export interface BackupUploadProgress {
  bytesUploaded: number
  totalBytes: number
}

export const BACKUP_TASK_STARTED_EVENT = 'payload-backup-postgres-task-started'

export interface BackupTaskStartedDetail {
  pollSecret: string
  taskId: string
}

export function serializeBackupUploadProgress(progress: BackupUploadProgress): string {
  return JSON.stringify({ ...progress, phase: 'uploading' })
}

export function parseBackupUploadProgress(message: string): BackupUploadProgress | undefined {
  try {
    const parsed: unknown = JSON.parse(message)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'phase' in parsed &&
      parsed.phase === 'uploading' &&
      'bytesUploaded' in parsed &&
      typeof parsed.bytesUploaded === 'number' &&
      Number.isFinite(parsed.bytesUploaded) &&
      parsed.bytesUploaded >= 0 &&
      'totalBytes' in parsed &&
      typeof parsed.totalBytes === 'number' &&
      Number.isFinite(parsed.totalBytes) &&
      parsed.totalBytes > 0
    ) {
      return {
        bytesUploaded: Math.min(parsed.bytesUploaded, parsed.totalBytes),
        totalBytes: parsed.totalBytes,
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

export function getBackupTaskDisplayMessage(message: string): string {
  return parseBackupUploadProgress(message) ? 'Uploading backup to blob storage' : message
}
