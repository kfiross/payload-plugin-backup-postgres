export interface BackupUploadProgress {
  bytesUploaded: number
  totalBytes: number
}

export interface BackupTableDumpProgress {
  rowCount: number
  table: string
  tablesCompleted: number
  totalTables: number
}

export const BACKUP_TASK_STARTED_EVENT = 'payload-backup-postgres-task-started'

export interface BackupTaskStartedDetail {
  pollSecret: string
  taskId: string
}

export function serializeBackupUploadProgress(progress: BackupUploadProgress): string {
  return JSON.stringify({ ...progress, phase: 'uploading' })
}

export function serializeBackupTableDumpProgress(progress: BackupTableDumpProgress): string {
  return JSON.stringify({ ...progress, phase: 'dumping' })
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

export function parseBackupTableDumpProgress(message: string): BackupTableDumpProgress | undefined {
  try {
    const parsed: unknown = JSON.parse(message)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'phase' in parsed &&
      parsed.phase === 'dumping' &&
      'table' in parsed &&
      typeof parsed.table === 'string' &&
      'rowCount' in parsed &&
      typeof parsed.rowCount === 'number' &&
      Number.isInteger(parsed.rowCount) &&
      parsed.rowCount >= 0 &&
      'tablesCompleted' in parsed &&
      typeof parsed.tablesCompleted === 'number' &&
      Number.isInteger(parsed.tablesCompleted) &&
      parsed.tablesCompleted > 0 &&
      'totalTables' in parsed &&
      typeof parsed.totalTables === 'number' &&
      Number.isInteger(parsed.totalTables) &&
      parsed.totalTables >= parsed.tablesCompleted
    ) {
      return {
        rowCount: parsed.rowCount,
        table: parsed.table,
        tablesCompleted: parsed.tablesCompleted,
        totalTables: parsed.totalTables,
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

export function getBackupTaskDisplayMessage(message: string): string {
  if (parseBackupUploadProgress(message)) {
    return 'Uploading backup to blob storage'
  }
  const tableDump = parseBackupTableDumpProgress(message)
  return tableDump ?
      `Dumped table ${tableDump.table} (${tableDump.rowCount} rows)`
    : message
}
