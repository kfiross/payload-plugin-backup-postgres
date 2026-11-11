import type { Payload } from 'payload'

import { randomBytes, timingSafeEqual } from 'node:crypto'

import type { RestoreBackupResult } from './restoreResult'

import { buildRestoreWarnings, formatRestoreSummary, restoreTaskStatus } from './restoreResult'

export type BackupTaskKind = 'backup' | 'blobTransfer' | 'delete' | 'restore'
export type BackupTaskStatus =
  'completed' | 'completed_with_warnings' | 'failed' | 'queued' | 'running'

export type BackupTaskProgress = {
  createdAt: string
  error?: null | string
  id: string
  kind: BackupTaskKind
  message: string
  status: BackupTaskStatus
  updatedAt: string
  warnings?: null | string
}

/** Task row as stored / returned from Payload (includes server-only poll secret). */
export type BackupTaskWithPollSecret = {
  pollSecret?: null | string
} & BackupTaskProgress

export function pollSecretsMatch(provided: string, stored: null | string | undefined): boolean {
  if (!stored || !provided) {
    return false
  }
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(stored, 'utf8')
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

export function stripPollSecretForClient(task: BackupTaskWithPollSecret): BackupTaskProgress {
  const { pollSecret: _pollSecret, ...rest } = task
  return rest as BackupTaskProgress
}

export async function createBackupTask(
  payload: Payload,
  kind: BackupTaskKind,
  message: string,
): Promise<{ pollSecret: string; taskId: string }> {
  await pruneStaleBackupTasks(payload)
  const pollSecret = randomBytes(32).toString('hex')
  const doc = await payload.create({
    collection: 'backup-tasks',
    data: { kind, message, pollSecret, status: 'queued' },
    overrideAccess: true,
  })
  return { pollSecret, taskId: String(doc.id) }
}

export async function getBackupTask(
  payload: Payload,
  id: string,
): Promise<BackupTaskWithPollSecret | undefined> {
  try {
    const doc = await payload.findByID({
      id,
      collection: 'backup-tasks',
      overrideAccess: true,
    })
    return doc as unknown as BackupTaskWithPollSecret
  } catch {
    return undefined
  }
}

export async function updateBackupTask(
  payload: Payload,
  id: string,
  patch: Partial<Pick<BackupTaskProgress, 'error' | 'message' | 'status' | 'warnings'>>,
): Promise<BackupTaskProgress | undefined> {
  try {
    const doc = await payload.update({
      id,
      collection: 'backup-tasks',
      data: patch,
      overrideAccess: true,
    })
    return doc as unknown as BackupTaskProgress
  } catch {
    return undefined
  }
}

export async function completeBackupTask(
  payload: Payload,
  id: string,
  message: string,
  options?: { status?: 'completed' | 'completed_with_warnings'; warnings?: string },
): Promise<BackupTaskProgress | undefined> {
  return updateBackupTask(payload, id, {
    message,
    status: options?.status ?? 'completed',
    warnings: options?.warnings ?? null,
  })
}

export async function completeRestoreBackupTask(
  payload: Payload,
  id: string,
  result: RestoreBackupResult,
): Promise<BackupTaskProgress | undefined> {
  const warnings = buildRestoreWarnings(result)
  return completeBackupTask(payload, id, formatRestoreSummary(result), {
    status: restoreTaskStatus(result),
    warnings: warnings.length > 0 ? warnings.join('\n') : undefined,
  })
}

export async function failBackupTask(
  payload: Payload,
  id: string,
  error: unknown,
): Promise<BackupTaskProgress | undefined> {
  return updateBackupTask(payload, id, {
    error: error instanceof Error ? error.message : String(error),
    message: 'Task failed',
    status: 'failed',
  })
}

/** Default age after which progress rows are deleted (matches the MongoDB plugin's TTL index). */
export const BACKUP_TASK_TTL_MS = 30 * 60 * 1000

/**
 * Postgres has no TTL indexes, so stale `backup-tasks` rows are pruned explicitly on start-up
 * and whenever a new task is created. Never throws.
 */
export async function pruneStaleBackupTasks(
  payload: Payload,
  maxAgeMs: number = BACKUP_TASK_TTL_MS,
): Promise<void> {
  try {
    await payload.delete({
      collection: 'backup-tasks',
      overrideAccess: true,
      where: { updatedAt: { less_than: new Date(Date.now() - maxAgeMs).toISOString() } },
    })
  } catch (err) {
    payload.logger.warn({ err }, '[backup-plugin] Could not prune stale backup-tasks')
  }
}
