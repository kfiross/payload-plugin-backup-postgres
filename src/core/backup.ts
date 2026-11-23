import type { Payload } from 'payload'

import { list } from '@vercel/blob'

import {
  serializeBackupTableDumpProgress,
  serializeBackupUploadProgress,
} from '../utils/backupUploadProgress'
import {
  createBlobName,
  getCurrentDbName,
  getCurrentHostname,
  sanitizeBackupLabel,
} from '../utils/index'
import { createTarGzip } from './archive'
import { type BackupBlobAccessLevel, readBackupBlobContentFlexible } from './backupBlobIO'
import { getResolvedCronBackupSettings, resolveBackupBlobToken } from './backupSettings'
import { getPgDb, listTables, type PgClient, qi, qualified, withClient } from './db'
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  DATABASE_FILE_NAME,
  MEDIA_PREFIX,
  type PgBackupDocument,
  serializeBackupDocument,
} from './pgArchive'
import { getBackupStorageKind, resolveBackupStorage } from './storage'
import { resolveTableOwners } from './tableGroups'
import { isBackupTaskCancelled, updateBackupTask } from './taskProgress'

export { DATABASE_FILE_NAME } from './pgArchive'

/**
 * Resolves the Vercel Blob read/write token the same way as backup endpoints and
 * {@link createBackup} / {@link restoreBackup}: settings document override, else `BLOB_READ_WRITE_TOKEN`.
 * Pass `explicitToken` to skip reading settings (same as `options.blobToken` in those calls).
 */
export async function resolveBackupListToken(
  payload: Payload,
  explicitToken?: string,
): Promise<string> {
  const t = explicitToken?.trim()
  if (t) {
    return t
  }
  return resolveBackupBlobToken(await getResolvedCronBackupSettings(payload)).trim()
}

export async function listBackups(
  payload: Payload,
  options: {
    /**
     * When set, used as the Vercel Blob token (e.g. tests or a pre-resolved value).
     * When omitted, uses {@link resolveBackupListToken} (settings + env), same as other backup APIs.
     */
    blobToken?: string
  } = {},
) {
  const kind = getBackupStorageKind()
  if (kind === 'vercel-blob') {
    const token = await resolveBackupListToken(payload, options.blobToken)
    if (!token) {
      return []
    }
    return resolveBackupStorage({ blobToken: token, kind }).list('backups/')
  }
  return resolveBackupStorage({ kind }).list('backups/')
}

function resolveBlobToken(blobToken?: string): string | undefined {
  if (blobToken && blobToken.trim().length > 0) {
    return blobToken
  }
  return undefined
}

/**
 * Builds a tar.gz archive containing the database dump plus Payload upload-store media files.
 * Media always comes from the Vercel Blob upload store (via token/env), independent of the
 * configured backup archive target (S3 vs Vercel Blob).
 */
export async function createMediaBackupFile(
  databaseFile: string,
  mediaPathnames: string[],
  backupBlobToken?: string,
  mediaListToken?: string,
  payload?: Payload,
): Promise<Buffer> {
  const envMedia = (process.env.BLOB_READ_WRITE_TOKEN || '').trim()
  const tokenForMedia =
    resolveBlobToken(mediaListToken) ??
    (envMedia.length > 0 ? envMedia : undefined) ??
    resolveBlobToken(backupBlobToken)
  const unique = [...new Set(mediaPathnames.filter(Boolean))]
  const mediaFiles = await Promise.all(
    unique.map(async (pathname) => {
      try {
        const matchingFiles = await list({ limit: 2, prefix: pathname, token: tokenForMedia })
        const blob = matchingFiles.blobs.find((b) => b.pathname === pathname)
        if (!blob) {
          payload?.logger.warn(
            { filename: pathname },
            '[backup] File was in database but not in blob storage',
          )
          return undefined
        }
        const content = await readBackupBlobContentFlexible(
          blob.pathname,
          blob.downloadUrl,
          tokenForMedia ?? '',
        )
        return { name: `${MEDIA_PREFIX}${pathname}`, content }
      } catch (err) {
        payload?.logger.warn(
          { err, filename: pathname },
          '[backup] Failed to read media file from blob storage',
        )
        return undefined
      }
    }),
  )
  return await createTarGzip([
    { name: DATABASE_FILE_NAME, content: Buffer.from(databaseFile) },
    ...(mediaFiles.filter(Boolean) as { content: Buffer; name: string }[]),
  ])
}

type DumpResult = {
  doc: PgBackupDocument
  /** Blob pathnames referenced by upload collections (only collected when requested). */
  mediaPathnames: string[]
}

/**
 * Dumps every table of Payload's schema inside one `REPEATABLE READ READ ONLY` transaction,
 * so all tables come from the same snapshot.
 */
export async function dumpDatabase(
  payload: Payload,
  options: {
    collectMedia?: boolean
    onTable?: (
      table: string,
      rowCount: number,
      tablesCompleted: number,
      totalTables: number,
    ) => Promise<void> | void
    skipTables?: string[]
  } = {},
): Promise<DumpResult> {
  const { pool, schema, tableNameMap } = getPgDb(payload)
  const skip = new Set(options.skipTables ?? [])

  return withClient(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      const { rows: ver } = await client.query<{ v: string }>(
        `SELECT current_setting('server_version') AS v`,
      )
      const allTables = await listTables(client, schema)
      const tables: PgBackupDocument['tables'] = {}
      const tablesToDump = allTables.filter((table) => {
        if (skip.has(table)) {
          payload.logger.debug({ table }, '[backup] Skipping blacklisted table')
          return false
        }
        return true
      })
      for (const [index, table] of tablesToDump.entries()) {
        const { rows } = await client.query<{ n: string; rows: string }>(
          `SELECT count(*)::text AS n, coalesce(json_agg(t), '[]'::json)::text AS rows
             FROM ${qualified(schema, table)} t`,
        )
        const rowCount = Number(rows[0]?.n ?? 0)
        tables[table] = { rowCount, rows: rows[0]?.rows ?? '[]' }
        await options.onTable?.(table, rowCount, index + 1, tablesToDump.length)
      }

      const mediaPathnames: string[] = []
      if (options.collectMedia) {
        const owners = resolveTableOwners(payload, Object.keys(tables), tableNameMap)
        const uploadSlugs = new Set(
          (payload.config.collections ?? []).filter((c) => Boolean(c.upload)).map((c) => c.slug),
        )
        for (const table of Object.keys(tables)) {
          const owner = owners.get(table)!
          // Only the main root table of an upload collection holds `filename` / `sizes_*_filename`.
          if (owner.kind !== 'collection' || owner.versions || !uploadSlugs.has(owner.slug)) {
            continue
          }
          mediaPathnames.push(...(await readMediaPathnames(client, schema, table)))
        }
      }

      await client.query('COMMIT')
      return {
        doc: {
          createdAt: new Date().toISOString(),
          format: ARCHIVE_FORMAT,
          schema,
          serverVersion: ver[0]?.v ?? 'unknown',
          tables,
          version: ARCHIVE_VERSION,
        },
        mediaPathnames,
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    }
  })
}

async function readMediaPathnames(
  client: PgClient,
  schema: string,
  table: string,
): Promise<string[]> {
  const { rows: cols } = await client.query<{ name: string }>(
    `SELECT a.attname AS name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, table],
  )
  const names = new Set(cols.map((c) => c.name))
  if (!names.has('filename')) {
    return []
  }
  const fileCols = ['filename', ...[...names].filter((n) => /^sizes_.+_filename$/.test(n))]
  const prefixExpr = names.has('prefix') ? qi('prefix') : 'NULL::text'
  const out: string[] = []
  for (const col of fileCols) {
    const { rows } = await client.query<{ f: string; p: null | string }>(
      `SELECT ${prefixExpr} AS p, ${qi(col)}::text AS f
         FROM ${qualified(schema, table)}
        WHERE ${qi(col)} IS NOT NULL AND ${qi(col)}::text <> ''`,
    )
    for (const r of rows) {
      const prefix = (r.p ?? '').replace(/^\/+|\/+$/g, '')
      out.push(prefix ? `${prefix}/${r.f}` : r.f)
    }
  }
  return out
}

export async function createBackup(
  payload: Payload,
  options: {
    backupsToKeep?: number
    /** Public (default) or private Vercel Blob access for the uploaded backup archive. */
    blobAccess?: BackupBlobAccessLevel
    /** Optional explicit Vercel Blob token (falls back to env inside @vercel/blob). */
    blobToken?: string
    cron?: boolean
    includeMedia?: boolean
    /**
     * Optional human-readable label for manual backups (appears in the backup list and is
     * searchable via the label filter). Ignored for cron backups.
     */
    label?: string
    /** Postgres table names to omit from the dump (e.g. manual backup UI). */
    skipCollections?: string[]
    taskId?: string
  } = {},
): Promise<void> {
  const {
    backupsToKeep,
    blobToken,
    cron = false,
    includeMedia = false,
    skipCollections,
    taskId,
  } = options
  const label = cron ? '' : sanitizeBackupLabel(options.label)
  const blobAccess: BackupBlobAccessLevel = options.blobAccess ?? 'public'
  const token = resolveBlobToken(blobToken)
  const resolvedBackupsToKeep = backupsToKeep ?? (Number(process.env.BACKUPS_TO_KEEP) || 10)
  const storage = resolveBackupStorage({ blobAccess, blobToken: token })

  const currentHostname = getCurrentHostname()
  const currentDbName = getCurrentDbName()
  const type = cron ? 'cron' : 'manual'
  const t0 = Date.now()

  payload.logger.info(
    {
      type,
      blacklist: skipCollections?.length ?? 0,
      db: currentDbName,
      host: currentHostname,
      includeMedia,
    },
    '[backup] Starting backup',
  )
  if (taskId) {
    if (await isBackupTaskCancelled(payload, taskId)) {
      return
    }
    await updateBackupTask(payload, taskId, { message: 'Starting backup', status: 'running' })
  }

  if (cron) {
    const blobs = await storage.list('backups/cron-')
    const sorted = blobs.sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    )
    const oldest = sorted.slice(Math.max(0, resolvedBackupsToKeep - 1))
    if (oldest.length > 0) {
      payload.logger.info({ count: oldest.length }, '[backup] Pruning old cron backups')
      if (taskId) {
        if (await isBackupTaskCancelled(payload, taskId)) {
          throw new Error('Backup cancelled')
        }
        await updateBackupTask(payload, taskId, {
          message: `Pruning ${oldest.length} old cron backup${oldest.length === 1 ? '' : 's'}`,
        })
      }
    }
    for (const blob of oldest) {
      await storage.del({ pathname: blob.pathname, url: blob.url })
      payload.logger.info({ pathname: blob.pathname }, '[backup] Deleted old backup')
    }
  }

  if (taskId) {
    await updateBackupTask(payload, taskId, { message: 'Dumping tables' })
  }
  const { doc, mediaPathnames } = await dumpDatabase(payload, {
    collectMedia: includeMedia,
    onTable: async (table, rowCount, tablesCompleted, totalTables) => {
      payload.logger.debug({ rows: rowCount, table }, '[backup] Table dumped')
      if (taskId) {
        if (await isBackupTaskCancelled(payload, taskId)) {
          throw new Error('Backup cancelled')
        }
        await updateBackupTask(payload, taskId, {
          message: serializeBackupTableDumpProgress({
            rowCount,
            table,
            tablesCompleted,
            totalTables,
          }),
        })
        if (taskId && (await isBackupTaskCancelled(payload, taskId))) {
          throw new Error('Backup cancelled')
        }
      }
    },
    skipTables: skipCollections,
  })

  const databaseFile = serializeBackupDocument(doc)
  const includedTableCount = Object.keys(doc.tables).length
  const backupTimestampMs = Date.now()

  if (includeMedia) {
    payload.logger.info({ files: mediaPathnames.length }, '[backup] Bundling media files')
    if (taskId) {
      await updateBackupTask(payload, taskId, { message: 'Bundling media files into archive' })
    }
  }

  const backupFile =
    includeMedia ?
      await createMediaBackupFile(databaseFile, mediaPathnames, token, undefined, payload)
    : databaseFile
  if (taskId && (await isBackupTaskCancelled(payload, taskId))) {
    throw new Error('Backup cancelled')
  }
  const name = `backups/${createBlobName(
    type,
    currentDbName,
    currentHostname,
    includedTableCount,
    backupTimestampMs,
    includeMedia ? 'tar.gz' : 'json',
    label || undefined,
  )}`

  payload.logger.info({ name }, '[backup] Uploading backup to blob storage')
  const totalBytes =
    typeof backupFile === 'string' ? Buffer.byteLength(backupFile) : backupFile.byteLength
  let lastProgressUpdateAt = 0
  let progressWrites = Promise.resolve()
  const uploadAbortController = new AbortController()
  let cancellationPoll: ReturnType<typeof setInterval> | undefined
  if (taskId) {
    await updateBackupTask(payload, taskId, {
      message: serializeBackupUploadProgress({ bytesUploaded: 0, totalBytes }),
    })
    cancellationPoll = setInterval(() => {
      void isBackupTaskCancelled(payload, taskId).then((cancelled) => {
        if (cancelled) {
          uploadAbortController.abort()
        }
      })
    }, 1000)
  }
  try {
    await storage.put(
      name,
      backupFile,
      taskId ?
        ({ loaded, total }) => {
          const now = Date.now()
          if (now - lastProgressUpdateAt < 500 && loaded < total) {
            return
          }
          lastProgressUpdateAt = now
          const progressTotalBytes = total > 0 ? total : totalBytes
          const message = serializeBackupUploadProgress({
            bytesUploaded: loaded,
            totalBytes: progressTotalBytes,
          })
          progressWrites = progressWrites.then(async () => {
            await updateBackupTask(payload, taskId, { message })
          })
        }
      : undefined,
      taskId ? uploadAbortController.signal : undefined,
    )
  } finally {
    if (cancellationPoll) {
      clearInterval(cancellationPoll)
    }
  }
  await progressWrites
  if (taskId && (await isBackupTaskCancelled(payload, taskId))) {
    await storage.del({ pathname: name })
    throw new Error('Backup cancelled')
  }
  if (taskId) {
    await updateBackupTask(payload, taskId, {
      message: serializeBackupUploadProgress({ bytesUploaded: totalBytes, totalBytes }),
    })
  }

  payload.logger.info({ name, durationMs: Date.now() - t0 }, '[backup] Backup complete')
}
