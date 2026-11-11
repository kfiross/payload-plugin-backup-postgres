import type { Payload } from 'payload'

import type {
  RestoreBackupResult,
  RestoreCollectionOutcome,
  RestoreMediaOutcome,
} from './restoreResult'

import { readBackupArchiveBytes, resolveArchiveFileReference } from './backupArchiveRead'
import { type BackupBlobAccessLevel, putBackupBlobContent } from './backupBlobIO'
import {
  type ForeignKey,
  getPgDb,
  listTables,
  loadForeignKeys,
  loadTableMeta,
  type PgClient,
  qi,
  qualified,
  resetOwnedSequences,
  type TableMeta,
  withClient,
} from './db'
import { loadPgArchive, type PgBackupDocument } from './pgArchive'
import { tablesForSlugs } from './tableGroups'
import { updateBackupTask } from './taskProgress'

export type { RestoreBackupResult } from './restoreResult'

export interface RestoreBackupOptions {
  /** When set with S3, the archive is read server-side and list URLs may be stale. */
  archivePathname?: string
  /**
   * Default `true`: the whole database restore runs in one transaction and is rolled back if
   * any table fails, so the database is never left half-restored. Set `false` to keep the
   * tables that succeeded (MongoDB-plugin behaviour); each table still uses a savepoint.
   */
  atomic?: boolean
  /**
   * When set, the archive is loaded with the backup token (fetch + SDK fallback; works for
   * public and private blobs). Otherwise `downloadUrl` is fetched anonymously.
   */
  backupRead?: { pathname: string; token: string }
  /** Preferred Vercel Blob access for re-uploaded media files. Defaults to `public`. */
  blobAccess?: BackupBlobAccessLevel
  /** Optional explicit Vercel Blob token used for archive media blob uploads. */
  blobToken?: string
  /** When false, skip uploading media blobs from a tar.gz archive. Default true. */
  restoreArchiveMedia?: boolean
}

export async function restoreBackup(
  payload: Payload,
  downloadUrl: string,
  collectionBlacklist: string[] = [],
  mergeData = false,
  taskId?: string,
  options?: RestoreBackupOptions,
): Promise<RestoreBackupResult> {
  const restoreArchiveMedia = options?.restoreArchiveMedia !== false
  const blobToken = options?.blobToken
  const blobAccess: BackupBlobAccessLevel = options?.blobAccess ?? 'public'
  const t0 = Date.now()
  const archiveRef = resolveArchiveFileReference(downloadUrl, options?.archivePathname)

  const progress = async (message: string, status?: 'running') => {
    if (taskId) {
      await updateBackupTask(payload, taskId, status ? { message, status } : { message })
    }
  }

  payload.logger.info(
    { blacklist: collectionBlacklist, mergeData, url: archiveRef },
    '[restore] Starting restore',
  )
  await progress('Starting restore', 'running')

  const archiveBytes = await readBackupArchiveBytes(downloadUrl, {
    archivePathname: options?.archivePathname,
    backupRead: options?.backupRead,
    blobAccess,
    blobToken,
  })
  await progress(archiveRef.endsWith('.gz') ? 'Extracting tar.gz backup' : 'Parsing JSON backup')
  const archive = await loadPgArchive(archiveBytes, archiveRef)

  let mediaOutcome: null | RestoreMediaOutcome = null
  if (archive.fileKind === 'tar-gzip') {
    mediaOutcome = await restoreMedia(payload, archive.media, {
      blobAccess,
      blobToken,
      enabled: restoreArchiveMedia,
      progress,
    })
  }

  // Progress lives in `backup-tasks`; replacing those rows mid-restore would break polling.
  const { tableNameMap } = getPgDb(payload)
  const taskTables =
    taskId ?
      tablesForSlugs(payload, ['backup-tasks'], Object.keys(archive.doc.tables), tableNameMap)
    : []
  const effectiveBlacklist = [...new Set([...collectionBlacklist, ...taskTables])]

  const collections = await restoreTables(payload, archive.doc, {
    atomic: options?.atomic !== false,
    merge: mergeData,
    progress,
    skip: effectiveBlacklist,
  })

  const result: RestoreBackupResult = {
    archiveKind: archive.fileKind,
    collections,
    durationMs: Date.now() - t0,
    media: mediaOutcome,
  }
  payload.logger.info({ durationMs: result.durationMs, result }, '[restore] Restore complete')
  return result
}

async function restoreMedia(
  payload: Payload,
  medias: { content: Buffer; name: string }[],
  opts: {
    blobAccess: BackupBlobAccessLevel
    blobToken?: string
    enabled: boolean
    progress: (m: string) => Promise<void>
  },
): Promise<RestoreMediaOutcome> {
  const outcome: RestoreMediaOutcome = {
    accessFallbackCount: 0,
    attempted: medias.length,
    failed: [],
    restored: 0,
    skippedByOption: !opts.enabled,
  }
  if (!opts.enabled) {
    payload.logger.info('[restore] Skipping archive media blob upload (restoreArchiveMedia=false)')
    await opts.progress('Skipped media files from archive')
    return outcome
  }
  await opts.progress(`Restoring ${medias.length} media file${medias.length === 1 ? '' : 's'}`)
  const results = await Promise.all(
    medias.map(async (media) => {
      try {
        const effectiveAccess = await putBackupBlobContent(
          media.name,
          media.content,
          opts.blobToken,
          opts.blobAccess,
        )
        return { name: media.name, effectiveAccess, ok: true as const }
      } catch (err) {
        payload.logger.warn({ err, filename: media.name }, '[restore] Failed to upload media file')
        return {
          name: media.name,
          error: err instanceof Error ? err.message : String(err),
          ok: false as const,
        }
      }
    }),
  )
  for (const r of results) {
    if (r.ok) {
      outcome.restored += 1
      if (r.effectiveAccess !== opts.blobAccess) {
        outcome.accessFallbackCount += 1
      }
    } else {
      outcome.failed.push({ name: r.name, error: r.error })
    }
  }
  return outcome
}

/**
 * Orders tables so referenced tables are written before referencing ones. FK edges that form
 * cycles (including self references such as nested folders) are broken by marking the
 * referencing columns as "deferred": they are written as NULL first and patched afterwards.
 */
export function planRestoreOrder(
  tables: string[],
  fks: ForeignKey[],
): { deferred: Map<string, Set<string>>; order: string[] } {
  const inSet = new Set(tables)
  const edges = fks.filter((f) => inSet.has(f.table) && inSet.has(f.refTable))
  const deferred = new Map<string, Set<string>>()
  const defer = (fk: ForeignKey) => {
    const s = deferred.get(fk.table) ?? new Set<string>()
    fk.columns.forEach((c) => s.add(c))
    deferred.set(fk.table, s)
  }

  let live = edges.filter((e) => {
    if (e.table === e.refTable) {
      defer(e)
      return false
    }
    return true
  })
  const order: string[] = []
  const remaining = new Set([...tables].sort())
  while (remaining.size > 0) {
    const ready = [...remaining].filter(
      (t) => !live.some((e) => e.table === t && remaining.has(e.refTable)),
    )
    if (ready.length > 0) {
      for (const t of ready) {
        order.push(t)
        remaining.delete(t)
      }
      continue
    }
    // Cycle: break it at the table with the fewest outstanding dependencies.
    const pick = [...remaining].sort(
      (a, b) =>
        live.filter((e) => e.table === a && remaining.has(e.refTable)).length -
          live.filter((e) => e.table === b && remaining.has(e.refTable)).length ||
        a.localeCompare(b),
    )[0]
    const breaking = live.filter((e) => e.table === pick && remaining.has(e.refTable))
    breaking.forEach(defer)
    live = live.filter((e) => !breaking.includes(e))
  }
  return { deferred, order }
}

/**
 * Payload stores a document's localized values, arrays, blocks and relationships in child
 * tables named `<parent>_…` with an `ON DELETE CASCADE` FK to the parent (`_parent_id` /
 * `parent_id`). Returns, for each such child table, the FK that makes it part of its parent
 * document (longest parent name wins for nested blocks/arrays).
 */
export function findOwnershipKeys(tables: string[], fks: ForeignKey[]): Map<string, ForeignKey> {
  const inSet = new Set(tables)
  const out = new Map<string, ForeignKey>()
  for (const fk of fks) {
    if (
      fk.onDelete !== 'c' ||
      fk.table === fk.refTable ||
      !inSet.has(fk.table) ||
      !inSet.has(fk.refTable) ||
      !fk.table.startsWith(`${fk.refTable}_`)
    ) {
      continue
    }
    const prev = out.get(fk.table)
    if (!prev || fk.refTable.length > prev.refTable.length) {
      out.set(fk.table, fk)
    }
  }
  return out
}

type TableWork = {
  /** Columns written from the backup (present in table and dump, not generated). */
  columns: string[]
  deferredColumns: string[]
  meta: TableMeta
  name: string
  rowCount: number
  rows: string
}

async function restoreTables(
  payload: Payload,
  doc: PgBackupDocument,
  opts: {
    atomic: boolean
    merge: boolean
    progress: (m: string) => Promise<void>
    skip: string[]
  },
): Promise<RestoreCollectionOutcome[]> {
  const { pool, schema } = getPgDb(payload)
  const skip = new Set(opts.skip)
  const outcomes = new Map<string, RestoreCollectionOutcome>()
  const names = Object.keys(doc.tables).sort()

  return withClient(pool, async (client) => {
    await client.query('BEGIN')
    try {
      const live = new Set(await listTables(client, schema))
      const meta = await loadTableMeta(client, schema)
      const fks = await loadForeignKeys(client, schema)

      const candidates: string[] = []
      for (const name of names) {
        if (skip.has(name)) {
          outcomes.set(name, { name, kind: 'skipped', reason: 'blacklist' })
        } else if (!live.has(name)) {
          outcomes.set(name, {
            name,
            error: 'Table does not exist in the current database schema (run migrations first)',
            kind: 'failed',
          })
        } else if (opts.merge && doc.tables[name].rowCount === 0) {
          outcomes.set(name, { name, kind: 'skipped', reason: 'empty' })
        } else {
          candidates.push(name)
        }
      }

      const plan = planRestoreOrder(candidates, fks)
      const work = new Map<string, TableWork>()
      for (const name of plan.order) {
        const m = meta.get(name)!
        const t = doc.tables[name]
        const keys = await backupKeys(client, t.rows)
        const columns = m.columns.filter((c) => !c.generated && keys.has(c.name)).map((c) => c.name)
        const deferredColumns = [...(plan.deferred.get(name) ?? [])].filter(
          (c) => columns.includes(c) && m.pk.length > 0,
        )
        work.set(name, {
          name,
          columns,
          deferredColumns,
          meta: m,
          rowCount: t.rowCount,
          rows: t.rows,
        })
      }

      const fail = (name: string, err: unknown) => {
        const error = err instanceof Error ? err.message : String(err)
        payload.logger.error({ err, table: name }, '[restore] Failed to restore table')
        outcomes.set(name, { name, error, kind: 'failed' })
      }
      const step = async (name: string, label: string, fn: () => Promise<void>) => {
        if (outcomes.get(name)?.kind === 'failed') {
          return
        }
        await client.query('SAVEPOINT restore_table')
        try {
          await fn()
          await client.query('RELEASE SAVEPOINT restore_table')
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT restore_table')
          fail(name, new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`))
        }
      }

      await opts.progress(`Restoring ${work.size} table${work.size === 1 ? '' : 's'}`)

      if (!opts.merge) {
        // 1) Replace mode: drop rows that are not in the backup (children first).
        for (const name of [...plan.order].reverse()) {
          const w = work.get(name)!
          await step(name, 'delete', () => deleteMissingRows(client, schema, w))
        }
      } else {
        // 1) Merge mode works per document: rows of documents in the backup are replaced,
        //    everything else is kept. Payload rewrites child rows (locales, arrays, blocks,
        //    rels) with new ids on every save, so the live children of restored documents
        //    are cleared first instead of being upserted by id.
        const owners = findOwnershipKeys(plan.order, fks)
        for (const name of [...plan.order].reverse()) {
          const fk = owners.get(name)
          const parent = fk ? work.get(fk.refTable) : undefined
          if (fk && parent) {
            await step(name, 'delete children', () => deleteOwnedRows(client, schema, fk, parent))
          }
        }
        //    Live rows that collide with a backup row on a unique key but carry another
        //    primary key are evicted ("backup wins"), e.g. a user re-created with the same email.
        for (const name of plan.order) {
          const w = work.get(name)!
          if (w.meta.pk.length > 0 && w.meta.uniques.length > 0 && w.rowCount > 0) {
            await step(name, 'evict conflicts', () => evictUniqueConflicts(client, schema, w))
          }
        }
      }
      // 2) Upsert rows (parents first), deferred FK columns as NULL.
      for (const name of plan.order) {
        const w = work.get(name)!
        await opts.progress(`Restoring table ${name} (${w.rowCount} rows)`)
        await step(name, 'insert', () => upsertRows(client, schema, w, opts.merge))
      }
      // 3) Patch deferred (cyclic / self-referencing) FK columns.
      for (const name of plan.order) {
        const w = work.get(name)!
        if (w.deferredColumns.length > 0) {
          await step(name, 'link', () => patchDeferred(client, schema, w))
        }
      }
      // 4) Bring serial / identity sequences past the restored ids.
      for (const name of plan.order) {
        await step(name, 'sequence', () => resetOwnedSequences(client, schema, name))
      }

      for (const name of plan.order) {
        if (!outcomes.has(name)) {
          outcomes.set(name, { name, docCount: work.get(name)!.rowCount, kind: 'restored' })
        }
      }

      // Missing tables (schema drift) are reported but do not trigger the atomic rollback.
      const failures = plan.order.map((n) => outcomes.get(n)!).filter((o) => o.kind === 'failed')
      if (opts.atomic && failures.length > 0) {
        await client.query('ROLLBACK')
        const reason = `rolled back because ${failures.length} table(s) failed (first: ${failures[0].name})`
        for (const [name, o] of outcomes) {
          if (o.kind === 'restored') {
            outcomes.set(name, { name, error: `Not restored: ${reason}`, kind: 'failed' })
          }
        }
        payload.logger.error({ failures: failures.length }, '[restore] Atomic restore rolled back')
      } else {
        await client.query('COMMIT')
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    }
    return names.map((n) => outcomes.get(n)!).filter(Boolean)
  })
}

async function backupKeys(client: PgClient, rows: string): Promise<Set<string>> {
  const { rows: keys } = await client.query<{ k: string }>(
    `SELECT DISTINCT json_object_keys(e) AS k FROM json_array_elements($1::json) e`,
    [rows],
  )
  return new Set(keys.map((r) => r.k))
}

function recordset(schema: string, table: string, alias: string): string {
  return `json_populate_recordset(NULL::${qualified(schema, table)}, $1::json) ${alias}`
}

async function deleteMissingRows(client: PgClient, schema: string, w: TableWork): Promise<void> {
  const target = qualified(schema, w.name)
  const pk = w.meta.pk
  if (pk.length === 0 || !pk.every((c) => w.columns.includes(c))) {
    await client.query(`DELETE FROM ${target}`)
    return
  }
  const match = pk.map((c) => `s.${qi(c)} = t.${qi(c)}`).join(' AND ')
  await client.query(
    `DELETE FROM ${target} t WHERE NOT EXISTS (SELECT 1 FROM ${recordset(schema, w.name, 's')} WHERE ${match})`,
    [w.rows],
  )
}

async function deleteOwnedRows(
  client: PgClient,
  schema: string,
  fk: ForeignKey,
  parent: TableWork,
): Promise<void> {
  if (parent.rowCount === 0 || !fk.refColumns.every((c) => parent.columns.includes(c))) {
    return
  }
  const lhs = `(${fk.columns.map((c) => `t.${qi(c)}`).join(', ')})`
  const rhs = fk.refColumns.map((c) => `s.${qi(c)}`).join(', ')
  await client.query(
    `DELETE FROM ${qualified(schema, fk.table)} t
      WHERE ${lhs} IN (SELECT ${rhs} FROM ${recordset(schema, fk.refTable, 's')})`,
    [parent.rows],
  )
}

async function evictUniqueConflicts(client: PgClient, schema: string, w: TableWork): Promise<void> {
  const pk = w.meta.pk
  if (!pk.every((c) => w.columns.includes(c))) {
    return
  }
  const samePk = pk.map((c) => `t.${qi(c)} = s.${qi(c)}`).join(' AND ')
  for (const uq of w.meta.uniques) {
    if (!uq.every((c) => w.columns.includes(c))) {
      continue
    }
    const sameKey = uq.map((c) => `t.${qi(c)} = s.${qi(c)}`).join(' AND ')
    await client.query(
      `DELETE FROM ${qualified(schema, w.name)} t
        USING ${recordset(schema, w.name, 's')}
        WHERE ${sameKey} AND NOT (${samePk})`,
      [w.rows],
    )
  }
}

async function upsertRows(
  client: PgClient,
  schema: string,
  w: TableWork,
  merge: boolean,
): Promise<void> {
  if (w.rowCount === 0 || w.columns.length === 0) {
    return
  }
  const target = qualified(schema, w.name)
  const deferred = new Set(w.deferredColumns)
  const colList = w.columns.map(qi).join(', ')
  const selectList = w.columns.map((c) => (deferred.has(c) ? `NULL` : `s.${qi(c)}`)).join(', ')
  const pk = w.meta.pk
  const hasPk = pk.length > 0 && pk.every((c) => w.columns.includes(c))
  let conflict = ''
  if (hasPk) {
    const updatable = w.columns.filter((c) => !pk.includes(c))
    conflict =
      updatable.length > 0 ?
        ` ON CONFLICT (${pk.map(qi).join(', ')}) DO UPDATE SET ${updatable
          .map((c) => `${qi(c)} = EXCLUDED.${qi(c)}`)
          .join(', ')}`
      : ` ON CONFLICT (${pk.map(qi).join(', ')}) DO NOTHING`
  } else if (!merge) {
    conflict = '' // table was emptied in the delete phase
  }
  await client.query(
    `INSERT INTO ${target} (${colList}) OVERRIDING SYSTEM VALUE
       SELECT ${selectList} FROM ${recordset(schema, w.name, 's')}${conflict}`,
    [w.rows],
  )
}

async function patchDeferred(client: PgClient, schema: string, w: TableWork): Promise<void> {
  const set = w.deferredColumns.map((c) => `${qi(c)} = s.${qi(c)}`).join(', ')
  const match = w.meta.pk.map((c) => `t.${qi(c)} = s.${qi(c)}`).join(' AND ')
  const anyValue = w.deferredColumns.map((c) => `s.${qi(c)} IS NOT NULL`).join(' OR ')
  await client.query(
    `UPDATE ${qualified(schema, w.name)} t SET ${set}
       FROM ${recordset(schema, w.name, 's')}
      WHERE ${match} AND (${anyValue})`,
    [w.rows],
  )
}
