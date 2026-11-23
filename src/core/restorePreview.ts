import type { Payload } from 'payload'

import { readBackupArchiveBytes, resolveArchiveFileReference } from './backupArchiveRead'
import { type BackupBlobAccessLevel } from './backupBlobIO'
import { getPgDb } from './db'
import { loadPgArchive } from './pgArchive'
import { resolveTableOwners, rootTablesForSlug } from './tableGroups'

/** Payload slugs whose replacement invalidates the current admin session. */
const AUTH_SESSION_SLUGS = new Set(['payload-preferences', 'roles', 'sessions', 'users'])

/** Groups never listed in the UI (plugin-internal progress rows). */
const DEFAULT_EXCLUDED_GROUPS = new Set(['backup-tasks'])

export type RestorePreviewFileKind = 'json' | 'tar-gzip'

export type RestorePreviewAdminHiddenReason = 'collection-config' | 'version-history'

export type RestorePreviewGroup = {
  adminHidden: boolean
  adminHiddenReasons: RestorePreviewAdminHiddenReason[]
  affectsAuthSession: boolean
  /** e.g. "Seiten (pages)" */
  displayTitle: string
  /** Stable id for UI: Payload collection/global slug when known, else the table name. */
  groupId: string
  /** Row count of the root table (one row per document). */
  main?: { docCount: number; tableName: string }
  /** All Postgres tables restored/skipped together when this group is toggled. */
  tableNames: string[]
  /** Row count of the `_<root>_v` versions table. */
  versions?: { docCount: number; tableName: string }
}

export type RestorePreviewResponse = {
  /** Localized collection names represented by tables in the archive (excludes globals). */
  backupCollections: string[]
  fileKind: RestorePreviewFileKind
  groups: RestorePreviewGroup[]
  mediaBlobCount: number
}

function pickLocalizedLabel(labels: unknown, preferredLocales: string[]): string | undefined {
  if (!labels || typeof labels !== 'object') {
    return undefined
  }
  const l = labels as { plural?: unknown; singular?: unknown }

  const pickField = (field: unknown): string | undefined => {
    if (typeof field === 'string') {
      return field
    }
    if (field && typeof field === 'object') {
      const map = field as Record<string, string>
      for (const loc of preferredLocales) {
        const v = map[loc]
        if (v) {
          return v
        }
      }
      const first = Object.values(map).find(Boolean)
      return first
    }
    return undefined
  }

  return pickField(l.plural) || pickField(l.singular)
}

function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ''))
    .join(' ')
}

/** Collections shown in the default Payload admin sidebar: config order, skipping `admin.hidden`. */
function getNavVisibleCollections(payload: Payload) {
  return payload.config.collections.filter((c) => c.admin?.hidden !== true)
}

/**
 * Index in sidebar order, or `null` if the group is not a visible nav collection
 * (hidden config, unknown table, global, etc.).
 */
export function navVisibleCollectionOrderIndex(payload: Payload, groupId: string): null | number {
  const visible = getNavVisibleCollections(payload)
  const idx = visible.findIndex((c) => c.slug === groupId)
  return idx === -1 ? null : idx
}

function sortPreviewGroupsLikeAdminNav(
  payload: Payload,
  groups: RestorePreviewGroup[],
  preferredLocales: string[],
): void {
  const locale = preferredLocales[0] ?? 'en'
  groups.sort((a, b) => {
    const ia = navVisibleCollectionOrderIndex(payload, a.groupId)
    const ib = navVisibleCollectionOrderIndex(payload, b.groupId)
    if (ia !== null && ib !== null && ia !== ib) {
      return ia - ib
    }
    if (ia !== null && ib === null) {
      return -1
    }
    if (ia === null && ib !== null) {
      return 1
    }
    return a.displayTitle.localeCompare(b.displayTitle, locale)
  })
}

function buildDisplayTitle(
  payload: Payload,
  groupSlug: string,
  preferredLocales: string[],
): string {
  const col = payload.config.collections.find((c) => c.slug === groupSlug)
  const glob = payload.config.globals?.find((g) => g.slug === groupSlug)
  const label =
    pickLocalizedLabel(col?.labels, preferredLocales) ||
    pickLocalizedLabel(glob ? { singular: glob.label } : undefined, preferredLocales) ||
    humanizeSlug(groupSlug)
  return `${label} (${groupSlug})`
}

export async function loadRestoreBackupIndex(
  downloadUrl: string,
  options: {
    archivePathname?: string
    blobAccess?: BackupBlobAccessLevel
    blobToken?: string
    readAuth?: { pathname: string; token: string }
  } = {},
): Promise<{
  countsByTable: Record<string, number>
  fileKind: RestorePreviewFileKind
  mediaBlobCount: number
}> {
  const archiveRef = resolveArchiveFileReference(downloadUrl, options.archivePathname)
  const bytes = await readBackupArchiveBytes(downloadUrl, {
    archivePathname: options.archivePathname,
    backupRead: options.readAuth,
    blobAccess: options.blobAccess,
    blobToken: options.blobToken,
  })
  const archive = await loadPgArchive(bytes, archiveRef)
  const countsByTable: Record<string, number> = {}
  for (const [name, t] of Object.entries(archive.doc.tables)) {
    countsByTable[name] = t.rowCount
  }
  return { countsByTable, fileKind: archive.fileKind, mediaBlobCount: archive.media.length }
}

type GroupAgg = {
  groupId: string
  kind: 'collection' | 'global' | 'unknown'
  main?: { docCount: number; tableName: string }
  tableNames: string[]
  versions?: { docCount: number; tableName: string }
}

/** Ensures every configured collection/global appears (0 rows if absent from the backup). */
function mergeConfiguredZeros(
  payload: Payload,
  counts: Record<string, number>,
  excludeGroups: Set<string>,
  tableNameMap?: Map<string, string>,
): Record<string, number> {
  const merged = { ...counts }
  const slugs = [
    ...(payload.config.collections ?? []).map((c) => c.slug),
    ...(payload.config.globals ?? []).map((g) => g.slug),
  ]
  for (const slug of slugs) {
    if (excludeGroups.has(slug)) {
      continue
    }
    const roots = rootTablesForSlug(payload, slug, tableNameMap)
    if (roots && !(roots.main in merged)) {
      merged[roots.main] = 0
    }
  }
  return merged
}

function safeTableNameMap(payload: Payload): Map<string, string> | undefined {
  try {
    return getPgDb(payload).tableNameMap
  } catch {
    return undefined
  }
}

/** Groups Postgres tables + row counts (live DB or backup file) by Payload collection/global. */
export function buildCollectionPreviewGroups(
  payload: Payload,
  countsByTable: Record<string, number>,
  options: {
    /** Payload slugs (or raw table names) to hide. Default: `backup-tasks`. */
    excludeGroups?: Set<string>
    /** When true, list groups whose tables are all empty (e.g. manual backup UI). Default false. */
    includeEmptyCollections?: boolean
    preferredLocales?: string[]
    /** When true, order like Payload admin sidebar; unknown / hidden-only groups last by title. */
    sortLikeAdminNav?: boolean
  } = {},
): RestorePreviewGroup[] {
  const preferredLocales =
    options.preferredLocales?.length ? options.preferredLocales : ['de', 'en']
  const excludeGroups = options.excludeGroups ?? DEFAULT_EXCLUDED_GROUPS
  const includeEmptyCollections = options.includeEmptyCollections ?? false
  const sortLikeAdminNav = options.sortLikeAdminNav ?? false
  const tableNameMap = safeTableNameMap(payload)

  const owners = resolveTableOwners(payload, Object.keys(countsByTable), tableNameMap)
  const aggs = new Map<string, GroupAgg>()
  for (const [table, count] of Object.entries(countsByTable)) {
    const owner = owners.get(table)!
    if (excludeGroups.has(owner.slug)) {
      continue
    }
    const agg = aggs.get(owner.slug) ?? { groupId: owner.slug, kind: owner.kind, tableNames: [] }
    agg.tableNames.push(table)
    const roots =
      owner.kind === 'unknown' ? null : rootTablesForSlug(payload, owner.slug, tableNameMap)
    if (owner.kind === 'unknown' || table === roots?.main) {
      agg.main = { docCount: count, tableName: table }
    } else if (table === roots?.versions) {
      agg.versions = { docCount: count, tableName: table }
    }
    aggs.set(owner.slug, agg)
  }

  const authSlugs = new Set([
    ...(payload.config.collections ?? []).filter((c) => Boolean(c.auth)).map((c) => c.slug),
    ...AUTH_SESSION_SLUGS,
  ])

  const groups: RestorePreviewGroup[] = []
  for (const agg of aggs.values()) {
    const total = (agg.main?.docCount ?? 0) + (agg.versions?.docCount ?? 0)
    if (!includeEmptyCollections && total === 0) {
      continue
    }
    const reasons = new Set<RestorePreviewAdminHiddenReason>()
    const col = payload.config.collections?.find((c) => c.slug === agg.groupId)
    if (col?.admin?.hidden === true) {
      reasons.add('collection-config')
    }
    if (!agg.main && agg.versions) {
      reasons.add('version-history')
    }
    groups.push({
      adminHidden: reasons.size > 0,
      adminHiddenReasons: [...reasons],
      affectsAuthSession: authSlugs.has(agg.groupId),
      displayTitle:
        agg.kind === 'unknown' ?
          `${agg.groupId} (table)`
        : buildDisplayTitle(payload, agg.groupId, preferredLocales),
      groupId: agg.groupId,
      main: agg.main,
      tableNames: agg.tableNames.sort(),
      versions: agg.versions,
    })
  }

  if (sortLikeAdminNav) {
    sortPreviewGroupsLikeAdminNav(payload, groups, preferredLocales)
  } else {
    const locale = preferredLocales[0] ?? 'en'
    groups.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle, locale))
  }
  return groups
}

export function buildRestorePreviewGroups(
  payload: Payload,
  parsed: {
    countsByTable: Record<string, number>
    fileKind: RestorePreviewFileKind
    mediaBlobCount: number
  },
  options: { excludeGroups?: Set<string>; preferredLocales?: string[] } = {},
): RestorePreviewResponse {
  const excludeGroups = options.excludeGroups ?? DEFAULT_EXCLUDED_GROUPS
  const counts = mergeConfiguredZeros(
    payload,
    parsed.countsByTable,
    excludeGroups,
    safeTableNameMap(payload),
  )
  const groups = buildCollectionPreviewGroups(payload, counts, {
    excludeGroups,
    includeEmptyCollections: true,
    preferredLocales: options.preferredLocales,
    sortLikeAdminNav: true,
  })
  const collectionSlugs = new Set(
    (payload.config.collections ?? []).map((collection) => collection.slug),
  )
  const backupCollections = buildCollectionPreviewGroups(payload, parsed.countsByTable, {
    excludeGroups,
    includeEmptyCollections: true,
    preferredLocales: options.preferredLocales,
    sortLikeAdminNav: true,
  })
    .filter((group) => collectionSlugs.has(group.groupId))
    .map((group) => group.displayTitle)
  return {
    backupCollections,
    fileKind: parsed.fileKind,
    groups,
    mediaBlobCount: parsed.mediaBlobCount,
  }
}

export async function getRestorePreviewForAdminRestore(
  payload: Payload,
  downloadUrl: string,
  options: {
    archivePathname?: string
    backupRead?: { pathname: string; token: string }
    blobAccess?: BackupBlobAccessLevel
    blobToken?: string
    preferredLocales?: string[]
  } = {},
): Promise<RestorePreviewResponse> {
  const parsed = await loadRestoreBackupIndex(downloadUrl, {
    archivePathname: options.archivePathname,
    blobAccess: options.blobAccess,
    blobToken: options.blobToken,
    readAuth: options.backupRead,
  })
  return buildRestorePreviewGroups(payload, parsed, options)
}
