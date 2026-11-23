import { describe, expect, it } from 'vitest'

import {
  parseBackupUploadProgress,
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
