import { describe, expect, it } from 'vitest'

import {
  parseBackupTableDumpProgress,
  parseBackupUploadProgress,
  serializeBackupTableDumpProgress,
  serializeBackupUploadProgress,
} from '../../src/utils/backupUploadProgress.js'

describe('backup upload progress messages', () => {
  it('round-trips byte counts and clamps uploaded bytes to the total', () => {
    const message = serializeBackupUploadProgress({ bytesUploaded: 120, totalBytes: 100 })

    expect(parseBackupUploadProgress(message)).toEqual({ bytesUploaded: 100, totalBytes: 100 })
  })

  it('rejects ordinary task messages and invalid progress values', () => {
    expect(parseBackupUploadProgress('Uploading backup to blob storage')).toBeUndefined()
    expect(
      parseBackupUploadProgress(
        JSON.stringify({ bytesUploaded: -1, phase: 'uploading', totalBytes: 100 }),
      ),
    ).toBeUndefined()
    expect(
      parseBackupUploadProgress(
        JSON.stringify({ bytesUploaded: 1, phase: 'uploading', totalBytes: 0 }),
      ),
    ).toBeUndefined()
  })
})

describe('backup table dump progress messages', () => {
  it('round-trips the completed and total table counts', () => {
    const message = serializeBackupTableDumpProgress({
      rowCount: 141,
      table: 'customers',
      tablesCompleted: 18,
      totalTables: 30,
    })

    expect(parseBackupTableDumpProgress(message)).toEqual({
      rowCount: 141,
      table: 'customers',
      tablesCompleted: 18,
      totalTables: 30,
    })
  })

  it('rejects invalid counts and ordinary task messages', () => {
    expect(parseBackupTableDumpProgress('Dumped table customers (141 rows)')).toBeUndefined()
    expect(
      parseBackupTableDumpProgress(
        JSON.stringify({
          phase: 'dumping',
          rowCount: 141,
          table: 'customers',
          tablesCompleted: 31,
          totalTables: 30,
        }),
      ),
    ).toBeUndefined()
  })
})
