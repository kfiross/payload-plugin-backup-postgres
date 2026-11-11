/**
 * Browser-facing paths for the backup plugin (Payload custom REST under default {@code /api}).
 * Must stay in sync with {@link createBackupPostgresEndpoints} in `endpoints/index.ts`.
 */
export const backupPluginPublicApiPaths = {
  adminBackupDownload: '/api/backup-postgres/admin/backup-download',
  adminBackupPreview: '/api/backup-postgres/admin/backup-preview',
  adminDelete: '/api/backup-postgres/admin/delete',
  adminManual: '/api/backup-postgres/admin/manual',
  adminRestore: '/api/backup-postgres/admin/restore',
  adminRestorePreview: '/api/backup-postgres/admin/restore-preview',
  adminSettings: '/api/backup-postgres/admin/settings',
  adminTask: (id: string) => `/api/backup-postgres/admin/task/${encodeURIComponent(id)}`,
  adminValidateBlobToken: '/api/backup-postgres/admin/validate-blob-token',
  cron: '/api/backup-postgres/cron/run',
  cronRestore: '/api/backup-postgres/cron/restore',
  list: '/api/backup-postgres/cron/list',
} as const
