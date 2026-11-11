import type { Payload } from 'payload'

import type { RestorePreviewGroup } from './restorePreview'

import { countTableRows, getPgDb, listTables, qi, qualified, withClient } from './db'
import { buildCollectionPreviewGroups } from './restorePreview'
import { resolveTableOwners } from './tableGroups'

export type BackupSourcePreviewResponse = {
  groups: RestorePreviewGroup[]
  /** Upload documents with a filename (blob path candidates for tar backup). */
  mediaBlobCandidates: number
}

export async function getBackupSourcePreviewForManual(
  payload: Payload,
  options: { preferredLocales?: string[] } = {},
): Promise<BackupSourcePreviewResponse> {
  const { pool, schema, tableNameMap } = getPgDb(payload)
  const { counts, mediaBlobCandidates } = await withClient(pool, async (client) => {
    const tables = await listTables(client, schema)
    const counts = await countTableRows(client, schema, tables)

    const owners = resolveTableOwners(payload, tables, tableNameMap)
    const uploadSlugs = new Set(
      (payload.config.collections ?? []).filter((c) => Boolean(c.upload)).map((c) => c.slug),
    )
    let mediaBlobCandidates = 0
    for (const t of tables) {
      const o = owners.get(t)!
      if (o.kind !== 'collection' || o.versions || !uploadSlugs.has(o.slug) || !counts[t]) {
        continue
      }
      const { rows: hasCol } = await client.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2 AND column_name = 'filename') AS ok`,
        [schema, t],
      )
      if (!hasCol[0]?.ok) {
        continue
      }
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${qualified(schema, t)}
          WHERE ${qi('filename')} IS NOT NULL AND ${qi('filename')} <> ''`,
      )
      mediaBlobCandidates += Number(rows[0]?.n ?? 0)
    }
    return { counts, mediaBlobCandidates }
  })

  const groups = buildCollectionPreviewGroups(payload, counts, {
    includeEmptyCollections: true,
    preferredLocales: options.preferredLocales,
    sortLikeAdminNav: true,
  })
  return { groups, mediaBlobCandidates }
}
