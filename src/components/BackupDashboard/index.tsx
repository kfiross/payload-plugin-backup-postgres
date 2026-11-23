import type { I18n } from '@payloadcms/translations'
import type { AdminViewServerProps, Payload } from 'payload'

import { DefaultTemplate } from '@payloadcms/next/templates'
import { Gutter } from '@payloadcms/ui'

import type { BackupPluginOptions } from '../../types'

import { listBackups, resolveBackupListToken } from '../../core/backup'
import { getBackupStorageKind, isBackupStorageConfigured } from '../../core/storage'
import {
  getBackupSortTimeMs,
  getCurrentDbName,
  getCurrentHostname,
  isUserAllowedByEnvRoles,
  formatBytes,
  transformBlobName,
} from '../../utils/index'
import { backupDashboardInlineCss } from './backupDashboardInlineCss'
import {
  BackupListCollapsible,
  BackupSettingsModal,
  BackupUploadProgress,
  ManualBackupDialog,
} from './index.client'

interface BackupDashboardProps {
  i18n: I18n
  /**
   * Payload instance injected by Payload's admin `RenderServerComponent` as a server prop
   * for `afterDashboard` components. Avoids importing `@payload-config` from the plugin,
   * which does not resolve when the plugin runs from `node_modules`.
   */
  payload?: Payload
  /** Optional on admin server props; omitted does not mean logged out (see `defaultIsHidden`). */
  user?: null | Record<string, unknown>
}

function defaultIsHidden(
  user: null | Record<string, unknown> | undefined,
  access?: BackupPluginOptions['access'],
): boolean {
  if (user === null) {
    return true
  }
  if (user === undefined) {
    if (access) {
      return true
    }
    return false
  }
  if (access) {
    return !access(user)
  }
  // Role allow-list via `PAYLOAD_BACKUP_ALLOWED_ROLES`. When unset, falls back to the
  // historical default (admin role, or "visible" when the project has no roles field).
  return !isUserAllowedByEnvRoles(user)
}

export const BackupDashboard: React.FC<AdminViewServerProps> = ({
  initPageResult,
  params,
  searchParams,
  ...props
}) => {

  return (
    <DefaultTemplate
      i18n={initPageResult.req.i18n}
      locale={initPageResult.locale}
      params={params}
      payload={initPageResult.req.payload}
      permissions={initPageResult.permissions}
      searchParams={searchParams}
      user={initPageResult.req.user || undefined}
      visibleEntities={initPageResult.visibleEntities}
    >
      <Gutter>
        <div style={{display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px'}}>
          <h1>Backups <span className="experimental">(experimental)</span></h1>
          <p>Here you can manage your database backups</p>
        </div>
        <BackupDashboardView i18n={initPageResult.req.i18n} payload={initPageResult.req.payload}user={initPageResult.req.user || undefined} />
      </Gutter>
    </DefaultTemplate>
  )
}

export const BackupDashboardView: React.FC<BackupDashboardProps> = async ({ i18n, payload, user }) => {
  if (defaultIsHidden(user)) {
    return null
  }

  const hasPostgresAdapter = (payload?.db as { name?: string } | undefined)?.name === 'postgres'
  if (!hasPostgresAdapter) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: backupDashboardInlineCss }} />
        <div className="backup-dashboard">
          <h2>
            Backups <span className="experimental">(experimental)</span>
          </h2>
          <p className="backup-dashboard__setup-hint" role="status">
            This plugin requires Payload&apos;s Postgres adapter (
            <code className="backup-dashboard__setup-hint-code">@payloadcms/db-postgres</code> or{' '}
            <code className="backup-dashboard__setup-hint-code">
              @payloadcms/db-vercel-postgres
            </code>
            ). For MongoDB use @trieb.work/payload-plugin-backup-mongodb.
          </p>
        </div>
      </>
    )
  }

  if (!payload) {
    // Should not happen in a normal Payload admin render; guard for safety.
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: backupDashboardInlineCss }} />
        <div className="backup-dashboard">
          <h2>
            Backups <span className="experimental">(experimental)</span>
          </h2>
          <p className="backup-dashboard__setup-hint" role="status">
            Backup dashboard could not initialise: Payload instance was not provided by the admin
            server props.
          </p>
        </div>
      </>
    )
  }

  const storageKind = getBackupStorageKind()
  const backupBlobToken = await resolveBackupListToken(payload)
  const storageConfigured = isBackupStorageConfigured(backupBlobToken)

  const blobs = storageConfigured ? await listBackups(payload, { blobToken: backupBlobToken }) : []
  const sortedBlobs = [...blobs].sort((a, b) => {
    const ta = getBackupSortTimeMs(transformBlobName(a.pathname), new Date(a.uploadedAt))
    const tb = getBackupSortTimeMs(transformBlobName(b.pathname), new Date(b.uploadedAt))
    return tb - ta
  })
  const archivesTotal = sortedBlobs.reduce((total, blob) => total + blob.size, 0)
  const currentHostname = getCurrentHostname()
  const currentDbName = getCurrentDbName()

  const countOtherDb = sortedBlobs.filter((blob) => {
    const { dbName } = transformBlobName(blob.pathname)
    return currentDbName !== dbName
  }).length

  const countOtherHostname = sortedBlobs.filter((blob) => {
    const { hostname } = transformBlobName(blob.pathname)
    return currentHostname !== hostname
  }).length
  const lastBackup = sortedBlobs[0]

  return (
    <>
      <style
        dangerouslySetInnerHTML={{ __html: backupDashboardInlineCss }}
        data-payload-backup-postgres="1"
      />
      <div className="backup-dashboard">
        {!storageConfigured && storageKind === 's3' && (
          <p className="backup-dashboard__setup-hint" role="status">
            Set <code className="backup-dashboard__setup-hint-code">BACKUP_S3_BUCKET</code> (and
            credentials) to enable the S3 backup target. Until then, the list stays empty and cron
            or manual backups cannot run.
          </p>
        )}
        {!storageConfigured && storageKind === 'vercel-blob' && (
          <p className="backup-dashboard__setup-hint" role="status">
            Add a Vercel Blob read/write token: set environment variable{' '}
            <code className="backup-dashboard__setup-hint-code">BLOB_READ_WRITE_TOKEN</code>, or
            open <strong>Backup settings</strong> and paste a token. Until then, the list stays
            empty and cron or manual backups cannot run.
          </p>
        )}

        <div className="backup-dashboard__toolbar">
          <div className="backup-dashboard__toolbar-meta">
            <span className="backup-dashboard__toolbar-pill">
              <span className="backup-dashboard__toolbar-key">Storage</span>
              {storageKind === 's3' ? 'AWS S3' : 'Vercel Blob'}
            </span>
            <span className="backup-dashboard__toolbar-pill">
              <span className="backup-dashboard__toolbar-key">Total</span>
              {sortedBlobs.length} backup{sortedBlobs.length === 1 ? '' : 's'}
            </span>
            <span
              className="backup-dashboard__toolbar-pill"
              title="Total size of listed backup archives only (up to 1,000 objects), not the full Vercel Blob store."
            >
              <span className="backup-dashboard__toolbar-key">Archives total</span>
              {formatBytes(archivesTotal)}
            </span>
            <span className="backup-dashboard__toolbar-pill">
              <span className="backup-dashboard__toolbar-key">Last backup</span>
              {lastBackup ?
                new Date(
                  getBackupSortTimeMs(
                    transformBlobName(lastBackup.pathname),
                    new Date(lastBackup.uploadedAt),
                  ),
                ).toLocaleString(i18n?.language || 'en')
              : 'No backups yet'}
            </span>
          </div>
          <div className="make-backup-actions">
            <BackupSettingsModal />
            <ManualBackupDialog />
          </div>
        </div>

        <BackupUploadProgress />

        <BackupListCollapsible
          blobs={sortedBlobs.map((b) => ({
            downloadUrl: b.downloadUrl,
            pathname: b.pathname,
            size: b.size,
            uploadedAt: new Date(b.uploadedAt).toISOString(),
            url: b.url,
          }))}
          countOtherDb={countOtherDb}
          countOtherHostname={countOtherHostname}
          currentDbName={currentDbName}
          currentHostname={currentHostname}
          i18nLanguage={i18n?.language || 'en'}
        />
      </div>
    </>
  )
}

export default BackupDashboard