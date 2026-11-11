export { createTarGzip, resolveTarGzip } from './core/archive'
export {
  createBackup,
  createMediaBackupFile,
  dumpDatabase,
  listBackups,
  resolveBackupListToken,
} from './core/backup'
export { getBackupSourcePreviewForManual } from './core/backupSourcePreview'

export type { BackupSourcePreviewResponse } from './core/backupSourcePreview'
export { getPgDb, listTables, loadForeignKeys, loadTableMeta, qi, qualified } from './core/db'
export type { ForeignKey, PgClient, PgDb, PgPool, TableMeta } from './core/db'
export {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  DATABASE_FILE_NAME,
  loadPgArchive,
  MEDIA_PREFIX,
  parseBackupDocument,
} from './core/pgArchive'
export type { LoadedPgArchive, PgBackupDocument, PgBackupTable } from './core/pgArchive'
export { findOwnershipKeys, planRestoreOrder } from './core/restore'
export { restoreBackup } from './core/restore'
export type { RestoreBackupOptions, RestoreBackupResult } from './core/restore'
export {
  buildCollectionPreviewGroups,
  buildRestorePreviewGroups,
  getRestorePreviewForAdminRestore,
  loadRestoreBackupIndex,
  navVisibleCollectionOrderIndex,
} from './core/restorePreview'
export type {
  RestorePreviewAdminHiddenReason,
  RestorePreviewFileKind,
  RestorePreviewGroup,
  RestorePreviewResponse,
} from './core/restorePreview'
export { buildRestoreWarnings, formatRestoreSummary, restoreTaskStatus } from './core/restoreResult'
export type {
  RestoreArchiveKind,
  RestoreCollectionOutcome,
  RestoreMediaOutcome,
} from './core/restoreResult'
export {
  resolveTableOwners,
  rootTablesForSlug,
  slugToSnake,
  tablesForSlugs,
} from './core/tableGroups'
export type { TableOwner } from './core/tableGroups'
export {
  completeBackupTask,
  completeRestoreBackupTask,
  createBackupTask,
  failBackupTask,
  getBackupTask,
  pollSecretsMatch,
  pruneStaleBackupTasks,
  stripPollSecretForClient,
  updateBackupTask,
} from './core/taskProgress'
export type {
  BackupTaskKind,
  BackupTaskProgress,
  BackupTaskStatus,
  BackupTaskWithPollSecret,
} from './core/taskProgress'
export { backupPostgresPlugin } from './plugin'
export { backupPluginPublicApiPaths } from './publicApiPaths'
export type { BackupPluginOptions } from './types'

export { createBlobName, getBackupSortTimeMs, transformBlobName } from './utils/blobName'
export { formatBytes } from './utils/formatBytes'
export { getConnectionString, getCurrentDbName, getCurrentHostname } from './utils/hostname'
