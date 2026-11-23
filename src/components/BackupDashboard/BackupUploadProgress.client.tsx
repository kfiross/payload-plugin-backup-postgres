'use client'

import { Button } from '@payloadcms/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import type { BackupTaskProgress } from '../../core/taskProgress'

import { backupPluginPublicApiPaths } from '../../publicApiPaths'
import {
  BACKUP_TASK_STARTED_EVENT,
  type BackupTaskStartedDetail,
  getBackupTaskDisplayMessage,
  parseBackupUploadProgress,
} from '../../utils/backupUploadProgress'
import { formatBytes } from '../../utils/formatBytes'

function isTerminalTaskStatus(status: BackupTaskProgress['status']): boolean {
  return (
    status === 'cancelled' ||
    status === 'completed' ||
    status === 'completed_with_warnings' ||
    status === 'failed'
  )
}

export const BackupUploadProgress: React.FC = () => {
  const router = useRouter()
  const [activeTask, setActiveTask] = useState<BackupTaskStartedDetail | null>(null)
  const [task, setTask] = useState<BackupTaskProgress | null>(null)
  const [progressError, setProgressError] = useState<null | string>(null)
  const [isCancelling, setIsCancelling] = useState(false)

  useEffect(() => {
    const onTaskStarted = (event: Event) => {
      const detail = (event as CustomEvent<BackupTaskStartedDetail>).detail
      if (
        !detail ||
        typeof detail.taskId !== 'string' ||
        typeof detail.pollSecret !== 'string'
      ) {
        return
      }
      setActiveTask(detail)
      setTask(null)
      setProgressError(null)
      setIsCancelling(false)
    }

    window.addEventListener(BACKUP_TASK_STARTED_EVENT, onTaskStarted)
    return () => window.removeEventListener(BACKUP_TASK_STARTED_EVENT, onTaskStarted)
  }, [])

  useEffect(() => {
    if (!activeTask) {
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const response = await fetch(backupPluginPublicApiPaths.adminTask(activeTask.taskId), {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${activeTask.pollSecret}` },
        })
        if (!response.ok) {
          throw new Error('Could not load backup upload progress')
        }
        const nextTask = (await response.json()) as BackupTaskProgress
        if (cancelled) {
          return
        }
        setTask((current) =>
          current && isTerminalTaskStatus(current.status) ? current : nextTask,
        )
        setProgressError(null)

        if (nextTask.status === 'completed' || nextTask.status === 'completed_with_warnings') {
          router.refresh()
          timer = setTimeout(() => {
            setActiveTask(null)
            setTask(null)
          }, 5000)
          return
        }
        if (nextTask.status === 'failed') {
          timer = setTimeout(() => {
            setActiveTask(null)
            setTask(null)
          }, 10000)
          return
        }
        if (nextTask.status === 'cancelled') {
          timer = setTimeout(() => {
            setActiveTask(null)
            setTask(null)
          }, 5000)
          return
        }
        timer = setTimeout(() => void poll(), 1000)
      } catch (error) {
        if (cancelled) {
          return
        }
        setProgressError(
          error instanceof Error ? error.message : 'Could not load backup upload progress',
        )
        timer = setTimeout(() => void poll(), 3000)
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [activeTask, router])

  if (!activeTask) {
    return null
  }

  const upload = task?.message ? parseBackupUploadProgress(task.message) : undefined
  const percentage =
    upload ? Math.min(100, Math.floor((upload.bytesUploaded / upload.totalBytes) * 100)) : undefined
  const isFailed = task?.status === 'failed' || progressError !== null
  const canCancel =
    task === null || task.status === 'queued' || task.status === 'running'
  const message =
    progressError ||
    (task?.status === 'failed' ?
      task.error || task.message
    : task?.status === 'cancelled' ?
      'Backup cancelled'
    : task?.status === 'completed' || task?.status === 'completed_with_warnings' ?
      'Backup uploaded'
    : task?.message ? getBackupTaskDisplayMessage(task.message)
    : 'Preparing backup…')

  return (
    <section
      aria-label="Backup upload progress"
      aria-live="polite"
      className={`backup-dashboard__upload-progress${
        isFailed ? ' backup-dashboard__upload-progress--error' : ''
      }`}
      role="status"
    >
      <div className="backup-dashboard__upload-progress-meta">
        <span className="backup-dashboard__upload-progress-message">{message}</span>
        {upload && percentage !== undefined ?
          <span className="backup-dashboard__upload-progress-size">
            {formatBytes(upload.bytesUploaded)} / {formatBytes(upload.totalBytes)} · {percentage}%
          </span>
        : null}
      </div>
      <div className="backup-dashboard__upload-progress-controls">
        {isFailed ? null : (
          <progress
            aria-label="Backup file upload"
            className="backup-dashboard__upload-progress-bar"
            max={100}
            value={
              task?.status === 'completed' || task?.status === 'completed_with_warnings' ? 100
              : percentage
            }
          />
        )}
        {canCancel && (
          <Button
            buttonStyle="secondary"
            disabled={isCancelling}
            onClick={() => {
              if (!activeTask) {
                return
              }
              setIsCancelling(true)
              void fetch(backupPluginPublicApiPaths.adminTaskCancel(activeTask.taskId), {
                headers: { Authorization: `Bearer ${activeTask.pollSecret}` },
                method: 'POST',
              })
                .then(async (response) => {
                  if (!response.ok) {
                    throw new Error('Could not cancel backup')
                  }
                  const cancelledTask = (await response.json()) as BackupTaskProgress
                  setTask((current) =>
                    current && isTerminalTaskStatus(current.status) ? current : cancelledTask,
                  )
                  setProgressError(null)
                })
                .catch((error: unknown) => {
                  setProgressError(
                    error instanceof Error ? error.message : 'Could not cancel backup',
                  )
                })
                .finally(() => setIsCancelling(false))
            }}
            size="small"
          >
            {isCancelling ? 'Cancelling upload…' : 'Cancel upload'}
          </Button>
        )}
      </div>
    </section>
  )
}
