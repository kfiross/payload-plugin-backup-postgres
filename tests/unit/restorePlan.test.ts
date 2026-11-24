import { describe, expect, it } from 'vitest'

import type { Payload } from 'payload'
import type { ForeignKey } from '../../src/core/db'

import { findOwnershipKeys, planRestoreOrder } from '../../src/core/restore'
import { countCollectionGroups, slugToSnake } from '../../src/core/tableGroups'
import { buildRestorePreviewGroups } from '../../src/core/restorePreview'

const fk = (
  table: string,
  refTable: string,
  col: string,
  onDelete: ForeignKey['onDelete'] = 'a',
): ForeignKey => ({
  name: `${table}_${col}_fk`,
  columns: [col],
  onDelete,
  refColumns: ['id'],
  refTable,
  table,
})

describe('planRestoreOrder', () => {
  it('orders parents before children', () => {
    const { deferred, order } = planRestoreOrder(
      ['posts_rels', 'categories', 'posts'],
      [
        fk('posts_rels', 'posts', 'parent_id', 'c'),
        fk('posts_rels', 'categories', 'categories_id', 'c'),
      ],
    )
    expect(order.indexOf('posts')).toBeLessThan(order.indexOf('posts_rels'))
    expect(order.indexOf('categories')).toBeLessThan(order.indexOf('posts_rels'))
    expect(deferred.size).toBe(0)
  })

  it('defers self-referencing columns', () => {
    const { deferred, order } = planRestoreOrder(
      ['categories'],
      [fk('categories', 'categories', 'parent_id', 'n')],
    )
    expect(order).toEqual(['categories'])
    expect([...deferred.get('categories')!]).toEqual(['parent_id'])
  })

  it('breaks multi-table cycles by deferring one side', () => {
    const { deferred, order } = planRestoreOrder(
      ['users', 'media'],
      [fk('users', 'media', 'avatar_id', 'n'), fk('media', 'users', 'owner_id', 'n')],
    )
    expect(order).toHaveLength(2)
    const deferredCount = [...deferred.values()].reduce((n, s) => n + s.size, 0)
    expect(deferredCount).toBe(1)
  })

  it('ignores FKs to tables outside the restore set', () => {
    const { order } = planRestoreOrder(['posts'], [fk('posts', 'users', 'author_id')])
    expect(order).toEqual(['posts'])
  })
})

describe('findOwnershipKeys', () => {
  it('picks cascade FKs to a name-prefix parent, longest parent wins', () => {
    const fks = [
      fk('posts_rels', 'posts', 'parent_id', 'c'),
      fk('posts_rels', 'categories', 'categories_id', 'c'),
      fk('posts_blocks_hero', 'posts', '_parent_id', 'c'),
      fk('posts_blocks_hero_items', 'posts_blocks_hero', '_parent_id', 'c'),
      fk('posts_blocks_hero_items', 'posts', 'post_id', 'c'),
      fk('posts_author', 'posts', 'x', 'n'),
    ]
    const tables = [
      'posts',
      'posts_rels',
      'categories',
      'posts_blocks_hero',
      'posts_blocks_hero_items',
      'posts_author',
    ]
    const owners = findOwnershipKeys(tables, fks)
    expect(owners.get('posts_rels')?.refTable).toBe('posts')
    expect(owners.get('posts_blocks_hero_items')?.refTable).toBe('posts_blocks_hero')
    expect(owners.has('posts_author')).toBe(false)
    expect(owners.has('categories')).toBe(false)
  })
})

describe('slugToSnake', () => {
  it('matches Payload table naming', () => {
    expect(slugToSnake('backup-tasks')).toBe('backup_tasks')
    expect(slugToSnake('siteSettings')).toBe('site_settings')
    expect(slugToSnake('payload-locked-documents')).toBe('payload_locked_documents')
  })
})

describe('countCollectionGroups', () => {
  it('counts included collections once, excluding globals and internal collections', () => {
    const payload = {
      config: {
        collections: [{ slug: 'posts' }, { slug: 'backup-tasks' }],
        globals: [{ slug: 'site-settings' }],
      },
    } as Payload

    expect(
      countCollectionGroups(
        payload,
        ['posts', 'posts_rels', '_posts_v', 'backup_tasks', 'site_settings', 'unknown_table'],
        { excludeSlugs: new Set(['backup-tasks']) },
      ),
    ).toBe(1)
  })

  it('counts custom dbName collection roots, version tables, and relation tables as one group', () => {
    const payload = {
      config: {
        collections: [
          { slug: 'articles', dbName: 'article_documents' },
          { slug: 'authors' },
        ],
        globals: [{ slug: 'site-settings', dbName: 'site_settings_data' }],
      },
    } as Payload

    expect(
      countCollectionGroups(
        payload,
        [
          'article_documents',
          'article_documents_rels',
          '_article_documents_v',
          '_article_documents_v_rels',
          'writer_records',
          'writer_records_rels',
          'site_settings_data',
          'unknown_table',
        ],
        { tableNameMap: new Map([['authors', 'writer_records']]) },
      ),
    ).toBe(2)
  })
})

describe('buildRestorePreviewGroups', () => {
  it('lists backed-up collections alphabetically', () => {
    const payload = {
      config: {
        collections: [
          { slug: 'zebras', labels: { plural: 'Zebras' } },
          { slug: 'apples', labels: { plural: 'Apples' } },
        ],
      },
    } as Payload

    const preview = buildRestorePreviewGroups(payload, {
      countsByTable: { zebras: 1, apples: 1 },
      fileKind: 'json',
      mediaBlobCount: 0,
    })

    expect(preview.backupCollections).toEqual(['Apples (apples)', 'Zebras (zebras)'])
  })
})
