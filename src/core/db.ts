import type { Payload } from 'payload'

/** Minimal subset of `pg.PoolClient` used by the plugin. */
export type PgClient = {
  query: <R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rowCount: null | number; rows: R[] }>
  release: (err?: boolean | Error) => void
}

/** Minimal subset of `pg.Pool` (also satisfied by `@vercel/postgres` VercelPool). */
export type PgPool = {
  connect: () => Promise<PgClient>
}

type PostgresPayloadDb = {
  name?: string
  pool?: PgPool
  schemaName?: string
  tableNameMap?: Map<string, string>
}

export type PgDb = {
  pool: PgPool
  /** Postgres schema Payload writes to (adapter `schemaName`, default `public`). */
  schema: string
  /** Payload's slug → table name map (snake_case slug as key), when available. */
  tableNameMap?: Map<string, string>
}

export function getPgDb(payload: Payload): PgDb {
  const db = payload.db as unknown as PostgresPayloadDb
  if (db.name !== 'postgres') {
    throw new Error(
      `Backup failed: Not a Postgres database adapter (got "${String(db.name)}"). ` +
        'Use @payloadcms/db-postgres or @payloadcms/db-vercel-postgres.',
    )
  }
  if (!db.pool || typeof db.pool.connect !== 'function') {
    throw new Error('Backup failed: Database not initialized (no pg pool on payload.db)')
  }
  return {
    pool: db.pool,
    schema: db.schemaName || 'public',
    tableNameMap: db.tableNameMap,
  }
}

/** Double-quotes a SQL identifier. */
export function qi(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`
}

export function qualified(schema: string, table: string): string {
  return `${qi(schema)}.${qi(table)}`
}

export async function withClient<T>(pool: PgPool, fn: (c: PgClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

/** Ordinary + partitioned parent tables in `schema` (partitions themselves are skipped). */
export async function listTables(client: PgClient, schema: string): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
      ORDER BY c.relname`,
    [schema],
  )
  return rows.map((r) => r.name)
}

export async function countTableRows(
  client: PgClient,
  schema: string,
  tables: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of tables) {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${qualified(schema, t)}`,
    )
    out[t] = Number(rows[0]?.n ?? 0)
  }
  return out
}

export type TableColumn = {
  generated: boolean
  name: string
  notNull: boolean
}

export type TableMeta = {
  columns: TableColumn[]
  name: string
  /** Primary key column names (empty when the table has no PK). */
  pk: string[]
  /** Non-PK unique constraints / plain unique indexes (column lists). */
  uniques: string[][]
}

export type ForeignKey = {
  /** Referencing columns on `table`. */
  columns: string[]
  name: string
  /** `ON DELETE` action: a=no action, r=restrict, c=cascade, n=set null, d=set default. */
  onDelete: 'a' | 'c' | 'd' | 'n' | 'r'
  /** Referenced columns on `refTable` (same order as `columns`). */
  refColumns: string[]
  refTable: string
  table: string
}

export async function loadTableMeta(
  client: PgClient,
  schema: string,
): Promise<Map<string, TableMeta>> {
  const { rows: cols } = await client.query<{
    attname: string
    generated: boolean
    notnull: boolean
    relname: string
  }>(
    `SELECT c.relname, a.attname, a.attnotnull AS notnull,
            (a.attgenerated <> '') AS generated
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema],
  )
  const { rows: pks } = await client.query<{ cols: string[]; relname: string }>(
    `SELECT c.relname,
            array_agg(a.attname ORDER BY array_position(i.indkey::int2[], a.attnum)) AS cols
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1 AND i.indisprimary
      GROUP BY c.relname`,
    [schema],
  )
  const meta = new Map<string, TableMeta>()
  for (const r of cols) {
    const m = meta.get(r.relname) ?? { name: r.relname, columns: [], pk: [], uniques: [] }
    m.columns.push({ name: r.attname, generated: r.generated, notNull: r.notnull })
    meta.set(r.relname, m)
  }
  for (const r of pks) {
    const m = meta.get(r.relname)
    if (m) {
      m.pk = parsePgArray(r.cols)
    }
  }
  const { rows: uqs } = await client.query<{ cols: string[]; relname: string }>(
    `SELECT c.relname,
            array_agg(a.attname ORDER BY array_position(i.indkey::int2[], a.attnum)) AS cols
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1 AND i.indisunique AND NOT i.indisprimary
        AND i.indexprs IS NULL AND i.indpred IS NULL
      GROUP BY c.relname, i.indexrelid`,
    [schema],
  )
  for (const r of uqs) {
    meta.get(r.relname)?.uniques.push(parsePgArray(r.cols))
  }
  return meta
}

export async function loadForeignKeys(client: PgClient, schema: string): Promise<ForeignKey[]> {
  const { rows } = await client.query<{
    cols: string[]
    name: string
    ondelete: ForeignKey['onDelete']
    refcols: string[]
    reftable: string
    tbl: string
  }>(
    `SELECT con.conname AS name, c.relname AS tbl, rc.relname AS reftable,
            con.confdeltype::text AS ondelete,
            array_agg(a.attname ORDER BY k.ord) AS cols,
            array_agg(ra.attname ORDER BY k.ord) AS refcols
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class rc ON rc.oid = con.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       JOIN pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = k.refattnum
      WHERE con.contype = 'f' AND n.nspname = $1 AND rn.nspname = $1
      GROUP BY con.conname, c.relname, rc.relname, con.confdeltype`,
    [schema],
  )
  return rows.map((r) => ({
    name: r.name,
    columns: parsePgArray(r.cols),
    onDelete: r.ondelete,
    refColumns: parsePgArray(r.refcols),
    refTable: r.reftable,
    table: r.tbl,
  }))
}

/** `pg` returns `name[]` as a JS array, but some drivers return the `{a,b}` text form. */
function parsePgArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(String)
  }
  if (typeof v === 'string') {
    return v
      .replace(/^\{|\}$/g, '')
      .split(',')
      .filter(Boolean)
      .map((s) => s.replace(/^"|"$/g, ''))
  }
  return []
}

/** Resets every sequence owned by a column of `table` to `max(column)`. */
export async function resetOwnedSequences(
  client: PgClient,
  schema: string,
  table: string,
): Promise<void> {
  const { rows } = await client.query<{ col: string; seq: string }>(
    `SELECT a.attname AS col, pg_get_serial_sequence(format('%I.%I', $1::text, $2::text), a.attname) AS seq
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, table],
  )
  for (const { col, seq } of rows) {
    if (!seq) {
      continue
    }
    await client.query(
      `SELECT setval($1::regclass, coalesce(max(${qi(col)})::bigint, 1), max(${qi(col)}) IS NOT NULL)
         FROM ${qualified(schema, table)}`,
      [seq],
    )
  }
}
