import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  normalizeSkipTables,
  resolveBackupArchiveRead,
  resolveBackupBlobAccess,
  resolveBackupBlobToken,
  toPayloadSkipRows,
} from '../../src/core/backupSettings.js'

describe('normalizeSkipTables', () => {
  it('returns an empty array for non-array input', () => {
    expect(normalizeSkipTables(undefined)).toEqual([])
    expect(normalizeSkipTables(null)).toEqual([])
    expect(normalizeSkipTables('pages')).toEqual([])
    expect(normalizeSkipTables(42)).toEqual([])
  })

  it('keeps non-empty string entries unchanged', () => {
    expect(normalizeSkipTables(['pages', 'media'])).toEqual(['pages', 'media'])
  })

  it('accepts Payload-style row objects with a name field', () => {
    expect(normalizeSkipTables([{ name: 'pages' }, { name: 'media' }])).toEqual(['pages', 'media'])
  })

  it('drops empty strings and rows without a name', () => {
    expect(normalizeSkipTables(['', 'pages', { name: '' }, { notName: 'x' }, null])).toEqual([
      'pages',
    ])
  })

  it('rejects strings that are too long (>= 512 chars)', () => {
    const tooLong = 'x'.repeat(512)
    expect(normalizeSkipTables([tooLong, 'ok'])).toEqual(['ok'])
  })

  it('supports mixed string + object input in one list', () => {
    expect(normalizeSkipTables(['pages', { name: 'media' }, { name: 'posts' }, 'users'])).toEqual([
      'pages',
      'media',
      'posts',
      'users',
    ])
  })
})

describe('toPayloadSkipRows', () => {
  it('wraps strings into { name } rows', () => {
    expect(toPayloadSkipRows(['pages', 'media'])).toEqual([{ name: 'pages' }, { name: 'media' }])
  })

  it('returns [] for empty input', () => {
    expect(toPayloadSkipRows([])).toEqual([])
  })
})

const baseSettings = {
  id: 'settings-1',
  backupBlobAccess: null as 'private' | 'public' | null,
  backupBlobReadWriteToken: '',
  backupsToKeep: 10,
  includeMediaForCron: true,
  skipTables: [] as string[],
}

describe('resolveBackupBlobToken', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.BLOB_READ_WRITE_TOKEN
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('prefers the token stored on the settings document', () => {
    expect(
      resolveBackupBlobToken({ ...baseSettings, backupBlobReadWriteToken: '  vercel_rw  ' }),
    ).toBe('vercel_rw')
  })

  it('falls back to BLOB_READ_WRITE_TOKEN when settings token is blank', () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'env-token'
    expect(resolveBackupBlobToken({ ...baseSettings, backupBlobReadWriteToken: '   ' })).toBe(
      'env-token',
    )
  })

  it('returns empty string when nothing is configured', () => {
    expect(resolveBackupBlobToken(baseSettings)).toBe('')
  })
})

describe('resolveBackupBlobAccess', () => {
  it('uses the validated access level when present', () => {
    expect(resolveBackupBlobAccess({ ...baseSettings, backupBlobAccess: 'private' })).toBe(
      'private',
    )
    expect(resolveBackupBlobAccess({ ...baseSettings, backupBlobAccess: 'public' })).toBe('public')
  })

  it('treats a dedicated stored token as private when access is unknown', () => {
    expect(
      resolveBackupBlobAccess({
        ...baseSettings,
        backupBlobAccess: null,
        backupBlobReadWriteToken: 'dedicated',
      }),
    ).toBe('private')
  })

  it('defaults to public when using the environment token (no dedicated store)', () => {
    expect(
      resolveBackupBlobAccess({
        ...baseSettings,
        backupBlobAccess: null,
        backupBlobReadWriteToken: '',
      }),
    ).toBe('public')
  })
})

describe('resolveBackupArchiveRead', () => {
  it('returns undefined when pathname is missing or not a string', () => {
    expect(
      resolveBackupArchiveRead({ ...baseSettings, backupBlobReadWriteToken: 'x' }, undefined),
    ).toBeUndefined()
    expect(
      resolveBackupArchiveRead({ ...baseSettings, backupBlobReadWriteToken: 'x' }, 123),
    ).toBeUndefined()
  })

  it('returns undefined when pathname does not start with backups/', () => {
    expect(
      resolveBackupArchiveRead(
        { ...baseSettings, backupBlobReadWriteToken: 'x' },
        'leaked-path.json',
      ),
    ).toBeUndefined()
  })

  it('returns undefined when no blob token can be resolved', () => {
    const prev = process.env.BLOB_READ_WRITE_TOKEN
    delete process.env.BLOB_READ_WRITE_TOKEN
    expect(resolveBackupArchiveRead(baseSettings, 'backups/x.json')).toBeUndefined()
    if (prev !== undefined) {
      process.env.BLOB_READ_WRITE_TOKEN = prev
    }
  })

  it('returns { pathname, token } for valid backup paths with a token', () => {
    const out = resolveBackupArchiveRead(
      { ...baseSettings, backupBlobReadWriteToken: 'dedicated' },
      'backups/manual---db---host---1-1700000000000.json',
    )
    expect(out).toEqual({
      pathname: 'backups/manual---db---host---1-1700000000000.json',
      token: 'dedicated',
    })
  })

  it('returns undefined when BACKUP_STORAGE=s3 even if a blob token is configured', () => {
    const prev = process.env.BACKUP_STORAGE
    process.env.BACKUP_STORAGE = 's3'
    try {
      expect(
        resolveBackupArchiveRead(
          { ...baseSettings, backupBlobReadWriteToken: 'dedicated' },
          'backups/manual---db---host---1-1700000000000.json',
        ),
      ).toBeUndefined()
    } finally {
      if (prev === undefined) {
        delete process.env.BACKUP_STORAGE
      } else {
        process.env.BACKUP_STORAGE = prev
      }
    }
  })
})
