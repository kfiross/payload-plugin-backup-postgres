import { describe, expect, it } from 'vitest'

import type { ForeignKey } from '../../src/core/db'

import { findOwnershipKeys, planRestoreOrder } from '../../src/core/restore'
import { slugToSnake } from '../../src/core/tableGroups'

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
