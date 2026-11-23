import type { Payload } from 'payload'

import type { BackupStorageObject } from './storage/types'

import { getBackupSortTimeMs, transformBlobName } from '../utils/index'
import { getPgDb, qi, qualified, withClient } from './db'
import { rootTablesForSlug } from './tableGroups'

export const BACKUP_NUMBERS_SLUG = 'backup-numbers'

// Shared by backup-number allocations across processes connected to this database.
const BACKUP_NUMBER_LOCK_ID = '73194813002671'

function getNumber(rawNumber: number | string): number {
  const number = Number(rawNumber)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Invalid backup number: ${String(rawNumber)}`)
  }
  return number
}

function getNumbersTable(payload: Payload) {
  const { pool, schema, tableNameMap } = getPgDb(payload)
  const tables = rootTablesForSlug(payload, BACKUP_NUMBERS_SLUG, tableNameMap)
  if (!tables) {
    throw new Error(`Payload collection "${BACKUP_NUMBERS_SLUG}" is not configured`)
  }
  return { pool, table: qualified(schema, tables.main) }
}

async function findBackupNumbers(
  payload: Payload,
  pathnames: string[],
): Promise<Map<string, number>> {
  const { pool, table } = getNumbersTable(payload)
  const numbers = new Map<string, number>()
  for (let start = 0; start < pathnames.length; start += 250) {
    const chunk = pathnames.slice(start, start + 250)
    const rows = await withClient(pool, async (client) => {
      const { rows } = await client.query<{ number: string; pathname: string }>(
        `SELECT ${qi('number')}::text AS number, ${qi('pathname')} AS pathname
           FROM ${table}
          WHERE ${qi('pathname')} = ANY($1::text[])`,
        [chunk],
      )
      return rows
    })
    for (const doc of rows) {
      if (typeof doc.pathname === 'string') {
        numbers.set(doc.pathname, getNumber(doc.number))
      }
    }
  }
  return numbers
}

async function createBackupNumber(payload: Payload, pathname: string): Promise<number> {
  const { pool, table } = getNumbersTable(payload)
  return withClient(pool, async (client) => {
    await client.query('BEGIN')
    try {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [BACKUP_NUMBER_LOCK_ID])
      const existing = await client.query<{ number: string }>(
        `SELECT ${qi('number')}::text AS number
           FROM ${table}
          WHERE ${qi('pathname')} = $1`,
        [pathname],
      )
      if (existing.rows[0]) {
        await client.query('COMMIT')
        return getNumber(existing.rows[0].number)
      }

      const maximum = await client.query<{ number: string }>(
        `SELECT COALESCE(MAX(${qi('number')}), 0)::text AS number FROM ${table}`,
      )
      const next = Number(maximum.rows[0]?.number ?? 0) + 1
      if (!Number.isSafeInteger(next) || next < 1) {
        throw new Error('Backup numbering exceeded the safe integer range')
      }
      const inserted = await client.query<{ number: string }>(
        `INSERT INTO ${table} (${qi('number')}, ${qi('pathname')})
         VALUES ($1, $2)
         RETURNING ${qi('number')}::text AS number`,
        [next, pathname],
      )
      const insertedNumber = inserted.rows[0]?.number
      if (insertedNumber === undefined) {
        throw new Error(`Could not create a backup number for "${pathname}"`)
      }
      await client.query('COMMIT')
      return getNumber(insertedNumber)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  })
}

/** Assigns permanent numbers to unnumbered legacy blobs, oldest first. */
export async function ensureBackupNumbers(
  payload: Payload,
  blobs: BackupStorageObject[],
): Promise<Map<string, number>> {
  const uniqueBlobs = [...new Map(blobs.map((blob) => [blob.pathname, blob])).values()]
  const pathnames = uniqueBlobs.map((blob) => blob.pathname)
  const numbers = await findBackupNumbers(payload, pathnames)
  const missing = uniqueBlobs
    .filter((blob) => !numbers.has(blob.pathname))
    .sort((a, b) => {
      const timeDiff =
        getBackupSortTimeMs(transformBlobName(a.pathname), new Date(a.uploadedAt)) -
        getBackupSortTimeMs(transformBlobName(b.pathname), new Date(b.uploadedAt))
      return Number.isFinite(timeDiff) && timeDiff !== 0 ?
          timeDiff
        : a.pathname.localeCompare(b.pathname)
    })
  for (const blob of missing) {
    numbers.set(blob.pathname, await createBackupNumber(payload, blob.pathname))
  }
  return numbers
}

/** Permanently reserves the next number for a newly-created backup. */
export async function reserveBackupNumber(payload: Payload, pathname: string): Promise<number> {
  return createBackupNumber(payload, pathname)
}

export async function numberBackupBlobs(
  payload: Payload,
  blobs: BackupStorageObject[],
): Promise<Array<{ backupNumber: number } & BackupStorageObject>> {
  const numbers = await ensureBackupNumbers(payload, blobs)
  return blobs.map((blob) => {
    const backupNumber = numbers.get(blob.pathname)
    if (backupNumber === undefined) {
      throw new Error(`Could not assign a number to backup "${blob.pathname}"`)
    }
    return { ...blob, backupNumber }
  })
}
