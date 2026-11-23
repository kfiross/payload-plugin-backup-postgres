import type { Payload } from 'payload'

import { postgresAdapter } from '@payloadcms/db-postgres'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildConfig, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { BackupStorageAdapter, BackupStorageObject } from '../../src/core/storage/types'

import { createTarGzip } from '../../src/core/archive'
import { createBackup, dumpDatabase, listBackups } from '../../src/core/backup'
import { getBackupSourcePreviewForManual } from '../../src/core/backupSourcePreview'
import { getPgDb, withClient } from '../../src/core/db'
import { DATABASE_FILE_NAME, serializeBackupDocument } from '../../src/core/pgArchive'
import { restoreBackup } from '../../src/core/restore'
import { getRestorePreviewForAdminRestore } from '../../src/core/restorePreview'
import { createBackupTask, getBackupTask } from '../../src/core/taskProgress'
import { backupPostgresPlugin } from '../../src/plugin'

// ---------------------------------------------------------------- in-memory backup storage
const blobs = new Map<string, { body: Buffer; uploadedAt: Date }>()
const memStorage: BackupStorageAdapter = {
  del: async ({ pathname }) => void blobs.delete(pathname),
  kind: 's3',
  list: async (prefix) =>
    [...blobs.entries()]
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, b]): BackupStorageObject => ({
        downloadUrl: `mem://${p}`,
        pathname: p,
        size: b.body.length,
        uploadedAt: b.uploadedAt,
        url: `mem://${p}`,
      })),
  openDownloadStream: async () => null,
  put: async (pathname, body) => {
    blobs.set(pathname, { body: Buffer.from(body as Buffer), uploadedAt: new Date() })
    return { pathname, url: `mem://${pathname}` }
  },
  read: async ({ pathname }) => {
    const b = blobs.get(pathname)
    if (!b) {
      throw new Error(`not found ${pathname}`)
    }
    return b.body
  },
  validate: async () => ({ ok: true }),
}
vi.mock('../../src/core/storage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBackupStorageKind: () => 's3',
  resolveBackupStorage: () => memStorage,
}))

const CONN =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/payload_test'
const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-backup-media-'))
let payload: Payload

async function sql<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]> {
  const { pool } = getPgDb(payload)
  return withClient(pool, async (c) => (await c.query<T>(text, values)).rows)
}

/** Canonical snapshot of every table except plugin progress rows. */
async function snapshot(): Promise<Record<string, string>> {
  const { doc } = await dumpDatabase(payload)
  const out: Record<string, string> = {}
  for (const [t, v] of Object.entries(doc.tables)) {
    if (t.startsWith('backup_tasks') || t.startsWith('payload_locked_documents')) {
      continue
    }
    const rows = (JSON.parse(v.rows) as Record<string, unknown>[])
      .map((r) => JSON.stringify(r, Object.keys(r).sort()))
      .sort()
    out[t] = JSON.stringify(rows)
  }
  return out
}

async function latestBackupPath(): Promise<string> {
  const list = await listBackups(payload)
  return list.sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt))[0].pathname
}

const restore = (pathname: string, skip: string[] = [], merge = false, taskId?: string) =>
  restoreBackup(payload, `mem://${pathname}`, skip, merge, taskId, { archivePathname: pathname })

beforeAll(async () => {
  // fresh schema each run
  const { Client } = await import('pg')
  const c = new Client({ connectionString: CONN })
  await c.connect()
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  await c.end()

  const config = buildConfig({
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [
          { name: 'name', type: 'text' },
          { name: 'avatar', type: 'upload', relationTo: 'media' },
        ],
      },
      {
        slug: 'media',
        fields: [{ name: 'owner', type: 'relationship', relationTo: 'users' }],
        upload: { mimeTypes: ['text/plain'], staticDir },
      },
      {
        slug: 'categories',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'parent', type: 'relationship', relationTo: 'categories' },
        ],
      },
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          { name: 'price', type: 'number' },
          { name: 'meta', type: 'json' },
          { name: 'categories', type: 'relationship', hasMany: true, relationTo: 'categories' },
          { name: 'tags', type: 'array', fields: [{ name: 'tag', type: 'text' }] },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [{ slug: 'hero', fields: [{ name: 'heading', type: 'text' }] }],
          },
        ],
        versions: { drafts: true },
      },
    ],
    db: postgresAdapter({ pool: { connectionString: CONN }, push: true }),
    globals: [{ slug: 'site-settings', fields: [{ name: 'siteName', type: 'text' }] }],
    localization: { defaultLocale: 'en', locales: ['en', 'de'] },
    plugins: [backupPostgresPlugin()],
    secret: 'test-secret',
    typescript: { autoGenerate: false },
  })
  payload = await getPayload({ config: await config })

  // ---- seed
  const user = await payload.create({
    collection: 'users',
    data: { name: 'Ada', email: 'ada@example.com', password: 'pw-123456' },
  })
  const media = await payload.create({
    collection: 'media',
    data: { owner: user.id },
    file: { name: 'hello.txt', data: Buffer.from('hello'), mimetype: 'text/plain', size: 5 },
  })
  // users.avatar -> media and media.owner -> users: an FK cycle
  await payload.update({ id: user.id, collection: 'users', data: { avatar: media.id } })

  const root = await payload.create({ collection: 'categories', data: { title: 'Root' } })
  const child = await payload.create({
    collection: 'categories',
    data: { parent: root.id, title: 'Child' },
  })
  // make parent ids point "forward" too (child created first references a later row)
  const orphan = await payload.create({ collection: 'categories', data: { title: 'Late parent' } })
  await payload.update({ id: root.id, collection: 'categories', data: { parent: orphan.id } })

  for (let i = 1; i <= 3; i++) {
    const p = await payload.create({
      collection: 'posts',
      data: {
        _status: 'published',
        categories: [root.id, child.id],
        layout: [{ blockType: 'hero', heading: `Hero ${i}` }],
        meta: { n: i, nested: { ok: true } },
        price: i * 1.5,
        tags: [{ tag: `t${i}` }, { tag: 'common' }],
        title: `Post ${i}`,
      },
      locale: 'en',
    })
    await payload.update({
      id: p.id,
      collection: 'posts',
      data: { title: `Beitrag ${i}` },
      locale: 'de',
    })
  }
  await payload.updateGlobal({ slug: 'site-settings', data: { siteName: 'Original' } })

  // high-precision numeric straight into the column (beyond JS double precision)
  await sql(
    `UPDATE posts SET price = 12345678901234567890.123456789 WHERE id = (SELECT min(id) FROM posts)`,
  )
}, 180_000)

afterAll(async () => {
  await payload?.destroy?.()
  fs.rmSync(staticDir, { force: true, recursive: true })
})

describe('postgres backup & restore', () => {
  let original: Record<string, string>
  let backupPath: string

  it('creates a JSON backup containing every table', async () => {
    original = await snapshot()
    await createBackup(payload, { label: 'before changes' })
    backupPath = await latestBackupPath()
    expect(backupPath).toMatch(/^backups\/manual---.+---before%20changes\.json$/)

    const doc = JSON.parse(blobs.get(backupPath)!.body.toString('utf8'))
    expect(doc.format).toBe('payload-plugin-backup-postgres')
    expect(Object.keys(doc.tables)).not.toContain('backup_numbers')
    for (const t of [
      'posts',
      'posts_locales',
      'posts_rels',
      'posts_tags',
      'posts_blocks_hero',
      '_posts_v',
      'users',
      'media',
      'categories',
      'site_settings',
    ]) {
      expect(Object.keys(doc.tables)).toContain(t)
    }
    const numberedBackup = (await listBackups(payload)).find(
      (blob) => blob.pathname === backupPath,
    )
    expect(numberedBackup?.backupNumber).toBe(1)
    expect(doc.tables.posts.rowCount).toBe(3)
  })

  it('previews live DB grouped by collection', async () => {
    const preview = await getBackupSourcePreviewForManual(payload, { preferredLocales: ['en'] })
    const posts = preview.groups.find((g) => g.groupId === 'posts')!
    expect(posts.main?.docCount).toBe(3)
    expect(posts.versions?.tableName).toBe('_posts_v')
    expect(posts.tableNames).toEqual(
      expect.arrayContaining([
        'posts',
        'posts_locales',
        'posts_rels',
        '_posts_v',
        '_posts_v_locales',
      ]),
    )
    expect(preview.groups.find((g) => g.groupId === 'users')?.affectsAuthSession).toBe(true)
    expect(preview.groups.find((g) => g.groupId === 'site-settings')).toBeTruthy()
    expect(preview.groups.some((g) => g.groupId === 'backup-tasks')).toBe(false)
    expect(preview.mediaBlobCandidates).toBe(1)
  })

  it('previews a backup file', async () => {
    const preview = await getRestorePreviewForAdminRestore(payload, `mem://${backupPath}`, {
      archivePathname: backupPath,
    })
    expect(preview.fileKind).toBe('json')
    expect(preview.groups.find((g) => g.groupId === 'categories')?.main?.docCount).toBe(3)
    expect(preview.backupCollections).toEqual(
      expect.arrayContaining(['Posts (posts)', 'Categories (categories)', 'Media (media)']),
    )
    expect(preview.backupCollections).not.toContain('Backup Tasks (backup-tasks)')
  })

  it('replace-restore reverts deletes, edits, inserts (incl. FK cycles + self refs)', async () => {
    const posts = await payload.find({ collection: 'posts', sort: 'id' })
    await payload.delete({ id: posts.docs[0].id, collection: 'posts' })
    await payload.update({ id: posts.docs[1].id, collection: 'posts', data: { title: 'CHANGED' } })
    await payload.create({ collection: 'posts', data: { title: 'New after backup' } })
    const cats = await payload.find({
      collection: 'categories',
      where: { title: { equals: 'Late parent' } },
    })
    await payload.delete({ id: cats.docs[0].id, collection: 'categories' })
    await payload.updateGlobal({ slug: 'site-settings', data: { siteName: 'Changed' } })
    expect(await snapshot()).not.toEqual(original)

    const result = await restore(backupPath)
    expect(result.collections.filter((c) => c.kind === 'failed')).toEqual([])
    expect(await snapshot()).toEqual(original)

    const [{ price }] = await sql<{ price: string }>(
      `SELECT price::text FROM posts ORDER BY id LIMIT 1`,
    )
    expect(price).toBe('12345678901234567890.123456789')
    expect((await payload.findGlobal({ slug: 'site-settings' })).siteName).toBe('Original')
    const root = await payload.find({
      collection: 'categories',
      depth: 1,
      where: { title: { equals: 'Root' } },
    })
    expect((root.docs[0].parent as { title: string }).title).toBe('Late parent')
  })

  it('resets sequences so new documents get fresh ids', async () => {
    const created = await payload.create({
      collection: 'posts',
      data: { title: 'post-restore insert' },
    })
    const [{ max }] = await sql<{ max: number }>(`SELECT max(id) AS max FROM posts`)
    expect(created.id).toBe(max)
    await payload.delete({ id: created.id, collection: 'posts' })
  })

  it('merge-restore keeps newer rows and reverts changed ones', async () => {
    const extra = await payload.create({ collection: 'posts', data: { title: 'Keep me' } })
    const first = (await payload.find({ collection: 'posts', limit: 1, sort: 'id' })).docs[0]
    await payload.update({
      id: first.id,
      collection: 'posts',
      data: { tags: [{ tag: 'x' }, { tag: 'y' }, { tag: 'z' }], title: 'Edited' },
    })

    const result = await restore(backupPath, [], true)
    expect(result.collections.filter((c) => c.kind === 'failed')).toEqual([])
    const reverted = await payload.findByID({ id: first.id, collection: 'posts', locale: 'en' })
    expect(reverted.tags?.map((t) => t.tag)).toEqual(['t1', 'common'])
    const [{ n }] = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM posts_locales WHERE _parent_id = $1`,
      [first.id],
    )
    expect(n).toBe('2')
    expect((await payload.findByID({ id: extra.id, collection: 'posts' })).title).toBe('Keep me')
    expect(
      (await payload.findByID({ id: first.id, collection: 'posts', locale: 'en' })).title,
    ).toBe('Post 1')
    await payload.delete({ id: extra.id, collection: 'posts' })
  })

  it('honours the skip list (all tables of a collection)', async () => {
    const first = (await payload.find({ collection: 'posts', limit: 1, sort: 'id' })).docs[0]
    await payload.update({ id: first.id, collection: 'posts', data: { title: 'Skipped edit' } })
    const preview = await getBackupSourcePreviewForManual(payload)
    const postTables = preview.groups.find((g) => g.groupId === 'posts')!.tableNames

    const result = await restore(backupPath, postTables)
    expect(result.collections.find((c) => c.name === 'posts')).toMatchObject({
      kind: 'skipped',
      reason: 'blacklist',
    })
    expect((await payload.findByID({ id: first.id, collection: 'posts' })).title).toBe(
      'Skipped edit',
    )
    await restore(backupPath)
  })

  it('does not touch the running task row and reports via the task', async () => {
    const { taskId } = await createBackupTask(payload, 'restore', 'queued')
    await restore(backupPath, [], false, taskId)
    expect((await getBackupTask(payload, taskId))?.status).toBe('running')
  })

  it('restores a tar.gz archive (media upload disabled)', async () => {
    const { doc } = await dumpDatabase(payload)
    const tar = await createTarGzip([
      { name: DATABASE_FILE_NAME, content: Buffer.from(serializeBackupDocument(doc)) },
      { name: 'media/hello.txt', content: Buffer.from('hello') },
    ])
    const p = 'backups/manual---db---host---9-1700000000000.tar.gz'
    blobs.set(p, { body: tar, uploadedAt: new Date() })
    const preview = await getRestorePreviewForAdminRestore(payload, `mem://${p}`, {
      archivePathname: p,
    })
    expect(preview.fileKind).toBe('tar-gzip')
    expect(preview.mediaBlobCount).toBe(1)

    const result = await restoreBackup(payload, `mem://${p}`, [], false, undefined, {
      archivePathname: p,
      restoreArchiveMedia: false,
    })
    expect(result.archiveKind).toBe('tar-gzip')
    expect(result.media).toMatchObject({ attempted: 1, skippedByOption: true })
    expect(result.collections.every((c) => c.kind !== 'failed')).toBe(true)
  })

  it('atomic restore rolls everything back when a table fails', async () => {
    const doc = JSON.parse(blobs.get(backupPath)!.body.toString('utf8'))
    // categories row whose parent points at a non-existent id -> FK violation at link phase
    const cats = JSON.parse(doc.tables.categories.rows)
    cats[0].parent_id = 999_999
    doc.tables.categories.rows = JSON.stringify(cats)
    const bad = 'backups/manual---db---host---1-1700000000001.json'
    blobs.set(bad, { body: Buffer.from(JSON.stringify(doc)), uploadedAt: new Date() })

    await payload.updateGlobal({ slug: 'site-settings', data: { siteName: 'Before bad restore' } })
    const result = await restore(bad)
    expect(result.collections.find((c) => c.name === 'categories')?.kind).toBe('failed')
    expect(result.collections.find((c) => c.name === 'site_settings')?.kind).toBe('failed')
    expect((await payload.findGlobal({ slug: 'site-settings' })).siteName).toBe(
      'Before bad restore',
    )
  })

  it('reports tables missing from the current schema without aborting', async () => {
    const doc = JSON.parse(blobs.get(backupPath)!.body.toString('utf8'))
    doc.tables.legacy_table = { rowCount: 1, rows: '[{"id":1}]' }
    const drift = 'backups/manual---db---host---1-1700000000002.json'
    blobs.set(drift, { body: Buffer.from(JSON.stringify(doc)), uploadedAt: new Date() })
    const result = await restore(drift)
    expect(result.collections.find((c) => c.name === 'legacy_table')?.kind).toBe('failed')
    expect((await payload.findGlobal({ slug: 'site-settings' })).siteName).toBe('Original')
  })

  it('rejects MongoDB-format archives with a clear error', async () => {
    const p = 'backups/manual---db---host---1-1700000000003.json'
    blobs.set(p, { body: Buffer.from('{"users":[{"_id":{"$oid":"x"}}]}'), uploadedAt: new Date() })
    await expect(restore(p)).rejects.toThrow(/MongoDB backups cannot be restored/)
  })

  it('cron backups prune to backupsToKeep', async () => {
    for (let i = 0; i < 4; i++) {
      await createBackup(payload, { backupsToKeep: 2, cron: true })
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(
      (await listBackups(payload)).filter((b) => b.pathname.startsWith('backups/cron-')),
    ).toHaveLength(2)
  })

  it('does not reuse backup numbers after a backup is deleted', async () => {
    const before = await listBackups(payload)
    const highestNumber = Math.max(...before.map((blob) => blob.backupNumber))
    const removed = before[0]
    expect(removed).toBeTruthy()
    await memStorage.del({ pathname: removed.pathname, url: removed.url })

    await createBackup(payload, { label: 'after delete' })

    const after = await listBackups(payload)
    const created = after.find((blob) => blob.pathname.includes('after%20delete'))
    expect(created?.backupNumber).toBeGreaterThan(highestNumber)
  })
})
