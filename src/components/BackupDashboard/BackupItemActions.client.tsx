'use client'

import { Button } from '@payloadcms/ui'
import { useRef } from 'react'

import { backupPluginPublicApiPaths } from '../../publicApiPaths'
import { closeNativeDialogOnBackdropPointer } from '../../utils/dialogBackdrop'
import { RestoreBackupDialog } from './RestoreBackupDialog.client'
import { TaskActionButton } from './TaskActionButton.client'

type BackupItemActionsProps = {
  backupNumber?: number
  downloadUrl: string
  pathname: string
  url: string
}

export const BackupItemActions: React.FC<BackupItemActionsProps> = ({
  backupNumber,
  downloadUrl,
  pathname,
  url,
}) => {
  const downloadParams = new URLSearchParams({ pathname })
  if (url) {
    downloadParams.set('url', url)
  }
  if (downloadUrl) {
    downloadParams.set('downloadUrl', downloadUrl)
  }
  const downloadHref = `${backupPluginPublicApiPaths.adminBackupDownload}?${downloadParams.toString()}`
  const deleteDialogRef = useRef<HTMLDialogElement>(null)

  return (
    <div className="backup-item-actions">
      <div className="backup-item-actions__buttons">
        <Button buttonStyle="secondary" el="anchor" newTab size="small" url={downloadHref}>
          Download
        </Button>
        <RestoreBackupDialog downloadUrl={downloadUrl} pathname={pathname} />
        <Button
          buttonStyle="secondary"
          onClick={() => deleteDialogRef.current?.showModal()}
          size="small"
        >
          Delete
        </Button>
      </div>

      {/* Native <dialog>: backdrop dismiss; element not in jsx-a11y interactive list */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <dialog
        className="backup-confirm-dialog backup-confirm-dialog--delete-backup"
        onMouseDown={(e) => closeNativeDialogOnBackdropPointer(e, deleteDialogRef)}
        ref={deleteDialogRef}
      >
        <p className="backup-confirm-dialog__title">
          {backupNumber === undefined ? 'Delete this backup?' : `Delete backup #${backupNumber} ?`}
        </p>
        <p className="backup-confirm-dialog__body">This action cannot be undone.</p>
        <div className="backup-confirm-dialog__actions">
          <TaskActionButton
            body={{ pathname, url }}
            buttonStyle="error"
            className="backup-confirm-dialog__delete-button"
            completeLabel="Deleted"
            endpoint={backupPluginPublicApiPaths.adminDelete}
            idleLabel="Yes, delete"
            kind="delete"
            onComplete={() => deleteDialogRef.current?.close()}
            onFailure={() => deleteDialogRef.current?.close()}
            pendingLabel="Deleting..."
            refreshOnComplete={true}
            statusAboveButton
          />
          <Button
            buttonStyle="secondary"
            className="backup-confirm-dialog__not-now-button"
            onClick={() => deleteDialogRef.current?.close()}
            size="medium"
          >
            Not now
          </Button>
        </div>
      </dialog>
    </div>
  )
}
