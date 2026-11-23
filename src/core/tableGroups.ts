import type { Payload } from 'payload'

/**
 * Payload's Postgres adapter spreads one collection/global over several tables:
 *   `posts`, `posts_rels`, `posts_locales`, `posts_blocks_hero`, … (main data)
 *   `_posts_v`, `_posts_v_rels`, …                                  (version history)
 * This module maps physical tables back to the owning Payload slug so the admin UI can
 * keep showing one checkbox per collection, like the MongoDB plugin.
 */

export type TableOwner = {
  kind: 'collection' | 'global' | 'unknown'
  /** Collection/global slug, or the table name for tables not owned by Payload config. */
  slug: string
  /** True when the table belongs to the `_<root>_v` version-history family. */
  versions: boolean
}

type Root = { kind: 'collection' | 'global'; root: string; slug: string; versions: boolean }

export const BACKUP_INTERNAL_COLLECTION_SLUGS: ReadonlySet<string> = new Set([
  'backup-numbers',
  'backup-tasks',
])

/** Mirrors Payload's `toSnakeCase` for slugs (`my-posts` / `myPosts` → `my_posts`). */
export function slugToSnake(slug: string): string {
  return slug
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

function rootTableName(
  entity: { dbName?: unknown; slug: string },
  tableNameMap?: Map<string, string>,
): string {
  if (typeof entity.dbName === 'string' && entity.dbName) {
    return entity.dbName
  }
  const snake = slugToSnake(entity.slug)
  return tableNameMap?.get(snake) ?? snake
}

function collectRoots(payload: Payload, tableNameMap?: Map<string, string>): Root[] {
  const roots: Root[] = []
  for (const c of payload.config.collections ?? []) {
    const root = rootTableName(c as { dbName?: unknown; slug: string }, tableNameMap)
    roots.push({ slug: c.slug, kind: 'collection', root, versions: false })
    roots.push({ slug: c.slug, kind: 'collection', root: `_${root}_v`, versions: true })
  }
  for (const g of payload.config.globals ?? []) {
    const root = rootTableName(g as { dbName?: unknown; slug: string }, tableNameMap)
    roots.push({ slug: g.slug, kind: 'global', root, versions: false })
    roots.push({ slug: g.slug, kind: 'global', root: `_${root}_v`, versions: true })
  }
  // Longest root first so `media_folders` wins over `media` for `media_folders_rels`.
  return roots.sort((a, b) => b.root.length - a.root.length)
}

export function resolveTableOwners(
  payload: Payload,
  tables: string[],
  tableNameMap?: Map<string, string>,
): Map<string, TableOwner> {
  const roots = collectRoots(payload, tableNameMap)
  const out = new Map<string, TableOwner>()
  for (const t of tables) {
    const hit = roots.find((r) => t === r.root || t.startsWith(`${r.root}_`))
    out.set(
      t,
      hit ?
        { slug: hit.slug, kind: hit.kind, versions: hit.versions }
      : { slug: t, kind: 'unknown', versions: false },
    )
  }
  return out
}

/** Counts represented Payload collections, not their physical PostgreSQL tables. */
export function countCollectionGroups(
  payload: Payload,
  tables: string[],
  options: { excludeSlugs?: ReadonlySet<string>; tableNameMap?: Map<string, string> } = {},
): number {
  const collectionSlugs = new Set(
    (payload.config.collections ?? []).map((collection) => collection.slug),
  )
  const owners = resolveTableOwners(payload, tables, options.tableNameMap)
  return new Set(
    [...owners.values()]
      .filter(
        (owner) =>
          owner.kind === 'collection' &&
          collectionSlugs.has(owner.slug) &&
          !options.excludeSlugs?.has(owner.slug),
      )
      .map((owner) => owner.slug),
  ).size
}

/** Main + version root table names for a slug (used for row counts in the UI). */
export function rootTablesForSlug(
  payload: Payload,
  slug: string,
  tableNameMap?: Map<string, string>,
): { main: string; versions: string } | null {
  const entity =
    payload.config.collections?.find((c) => c.slug === slug) ??
    payload.config.globals?.find((g) => g.slug === slug)
  if (!entity) {
    return null
  }
  const root = rootTableName(entity as { dbName?: unknown; slug: string }, tableNameMap)
  return { main: root, versions: `_${root}_v` }
}

/** All tables (from `tables`) that belong to the given slugs. */
export function tablesForSlugs(
  payload: Payload,
  slugs: string[],
  tables: string[],
  tableNameMap?: Map<string, string>,
): string[] {
  const wanted = new Set(slugs)
  const owners = resolveTableOwners(payload, tables, tableNameMap)
  return tables.filter((t) => wanted.has(owners.get(t)!.slug))
}
