'use client'

import { Button } from '@payloadcms/ui'
import { useCallback, useId, useRef, useState } from 'react'

import type { RestorePreviewResponse } from '../../core/restorePreview'

import { backupPluginPublicApiPaths } from '../../publicApiPaths'
import { closeNativeDialogOnBackdropPointer } from '../../utils/dialogBackdrop'

type BackupCollectionsDetailsProps = {
  collectionCount?: number
  downloadUrl: string
  pathname: string
}

type BackupCollectionsResponse = {
  error?: string
} & Pick<RestorePreviewResponse, 'backupCollections'>

export const BackupCollectionsDetails: React.FC<BackupCollectionsDetailsProps> = ({
  collectionCount,
  downloadUrl,
  pathname,
}) => {
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [collections, setCollections] = useState<string[]>([])
  const [phase, setPhase] = useState<'error' | 'idle' | 'loading' | 'ready'>('idle')
  const [errorMessage, setErrorMessage] = useState<null | string>(null)

  const loadCollections = useCallback(async () => {
    setPhase('loading')
    setErrorMessage(null)
    try {
      const locale =
        typeof document !== 'undefined' ? (document.documentElement.lang || 'en').slice(0, 2) : 'en'
      const response = await fetch(backupPluginPublicApiPaths.adminRestorePreview, {
        body: JSON.stringify({ locale, pathname, url: downloadUrl }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const data = (await response.json()) as BackupCollectionsResponse
      if (!response.ok) {
        throw new Error(data.error || 'Could not load backup collections')
      }
      setCollections(data.backupCollections)
      setPhase('ready')
    } catch (error) {
      setPhase('error')
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not load backup collections',
      )
    }
  }, [downloadUrl, pathname])

  const openDetails = () => {
    setIsOpen(true)
    dialogRef.current?.showModal()
    if (phase === 'idle') {
      void loadCollections()
    }
  }

  const displayCount = phase === 'ready' ? collections.length : collectionCount

  return (
    <div className="backup-item__collections">
      <button
        aria-controls={id}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="backup-item__pill backup-item__pill--collections backup-item__collections-trigger"
        onClick={openDetails}
        type="button"
      >
        {displayCount === undefined ?
          'Collections'
        : `${displayCount} collection${displayCount === 1 ? '' : 's'}`}
        <span
          aria-hidden="true"
          className={`backup-item__collections-arrow${isOpen ? ' backup-item__collections-arrow--expanded' : ''}`}
        >
          {'>'}
        </span>
      </button>

      <dialog
        aria-labelledby={`${id}-title`}
        className="backup-confirm-dialog backup-confirm-dialog--collections"
        id={id}
        onClose={() => setIsOpen(false)}
        onPointerDown={(event) => closeNativeDialogOnBackdropPointer(event, dialogRef)}
        ref={dialogRef}
      >
        <h3 className="backup-confirm-dialog__title" id={`${id}-title`}>
          Collections in backup
        </h3>
        <div className="backup-confirm-dialog__body backup-item__collections-body">
          {phase === 'loading' && (
            <p aria-live="polite" className="backup-item__collections-status">
              Loading collection names…
            </p>
          )}
          {phase === 'error' && (
            <div className="backup-item__collections-error" role="alert">
              <span>{errorMessage}</span>
              <Button buttonStyle="secondary" onClick={() => void loadCollections()} size="small">
                Retry
              </Button>
            </div>
          )}
          {phase === 'ready' &&
            (collections.length > 0 ?
              <ul aria-label="Collections in backup" className="restore-preview__all-list">
                {collections.map((collection) => (
                  <li className="restore-preview__all-item" key={collection}>
                    <span className="restore-preview__all-name">{collection}</span>
                  </li>
                ))}
              </ul>
            : <p className="backup-item__collections-status">No collections in this backup.</p>)}
        </div>
        <div className="backup-confirm-dialog__actions">
          <Button buttonStyle="secondary" onClick={() => dialogRef.current?.close()} type="button">
            Close
          </Button>
        </div>
      </dialog>
    </div>
  )
}
