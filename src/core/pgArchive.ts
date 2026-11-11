import { resolveTarGzip } from './archive'

/** Name of the database dump inside `.tar.gz` archives. */
export const DATABASE_FILE_NAME = 'database.json'
/** Media blobs are stored under this prefix inside `.tar.gz` archives. */
export const MEDIA_PREFIX = 'media/'
export const ARCHIVE_FORMAT = 'payload-plugin-backup-postgres'
export const ARCHIVE_VERSION = 1

export type PgBackupTable = {
  rowCount: number
  /**
   * Rows as the JSON text Postgres produced with `json_agg(t)`. Kept as an opaque string so
   * `numeric`/`bigint` values never round-trip through JS numbers; restore hands it back to
   * `json_populate_recordset` unchanged.
   */
  rows: string
}

export type PgBackupDocument = {
  createdAt: string
  format: typeof ARCHIVE_FORMAT
  /** Postgres schema the dump was taken from. */
  schema: string
  serverVersion: string
  tables: Record<string, PgBackupTable>
  version: number
}

export type PgArchiveFileKind = 'json' | 'tar-gzip'

export type LoadedPgArchive = {
  doc: PgBackupDocument
  fileKind: PgArchiveFileKind
  media: { content: Buffer; name: string }[]
}

export function serializeBackupDocument(doc: PgBackupDocument): string {
  return JSON.stringify(doc)
}

export function parseBackupDocument(text: string): PgBackupDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Backup file is not valid JSON')
  }
  const doc = parsed as Partial<PgBackupDocument>
  if (!doc || doc.format !== ARCHIVE_FORMAT || typeof doc.tables !== 'object' || !doc.tables) {
    throw new Error(
      'Not a Postgres backup created by payload-plugin-backup-postgres (MongoDB backups cannot be restored into Postgres)',
    )
  }
  if (typeof doc.version !== 'number' || doc.version > ARCHIVE_VERSION) {
    throw new Error(`Unsupported backup format version ${String(doc.version)}`)
  }
  for (const [name, t] of Object.entries(doc.tables)) {
    if (!t || typeof t.rows !== 'string' || typeof t.rowCount !== 'number') {
      throw new Error(`Backup table "${name}" is malformed`)
    }
  }
  return doc as PgBackupDocument
}

/** `archiveRef` is a pathname/URL used only for its extension (`.json` or `.gz`). */
export async function loadPgArchive(bytes: Buffer, archiveRef: string): Promise<LoadedPgArchive> {
  if (archiveRef.endsWith('.json')) {
    return { doc: parseBackupDocument(bytes.toString('utf8')), fileKind: 'json', media: [] }
  }
  if (archiveRef.endsWith('.gz')) {
    const files = await resolveTarGzip(bytes)
    const dbFile = files.find((f) => f.name === DATABASE_FILE_NAME)
    if (!dbFile) {
      throw new Error(`Archive does not contain ${DATABASE_FILE_NAME}`)
    }
    const media = files
      .filter((f) => f.name.startsWith(MEDIA_PREFIX) && f.name.length > MEDIA_PREFIX.length)
      .map((f) => ({ name: f.name.slice(MEDIA_PREFIX.length), content: f.content }))
    return {
      doc: parseBackupDocument(dbFile.content.toString('utf8')),
      fileKind: 'tar-gzip',
      media,
    }
  }
  throw new Error(`File type of backup ${archiveRef} not supported (expected .json or .tar.gz)`)
}
