import type { Config, Plugin } from 'payload'

import type { BackupPluginOptions } from './types'

import { BackupSettingsCollection } from './collections/BackupSettings'
import { BackupTasksCollection } from './collections/BackupTasks'
import { BACKUP_SETTINGS_SLUG } from './core/backupSettings'
import { pruneStaleBackupTasks } from './core/taskProgress'
import { createBackupPostgresEndpoints } from './endpoints/index'

export const backupPostgresPlugin = (options: BackupPluginOptions = {}): Plugin => {
  return (incomingConfig: Config): Config => {
    /**
     * If the plugin is disabled, we still want to keep added collections/fields so the database schema is consistent which is important for migrations.
     * If your plugin heavily modifies the database schema, you may want to remove this property.
     */
    if (options.enabled === false) {
      return incomingConfig
    }
    

    const existingCollections = incomingConfig.collections || []
    const existingEndpoints = incomingConfig.endpoints ?? []
    const existingViews = incomingConfig.admin?.components?.views || {}
    const backupEndpoints = createBackupPostgresEndpoints(options)

    return {
      ...incomingConfig,
      admin: {
        ...incomingConfig.admin,
        components: {
          ...incomingConfig.admin?.components,
           views: {
            ...existingViews,
            dbBackups: {
              Component: 'payload-plugin-backup-postgres/rsc#BackupDashboard',
              path: '/db-backups',
            },
          },
        },
      },
      collections: [...existingCollections, BackupTasksCollection, BackupSettingsCollection],
      endpoints: [...existingEndpoints, ...backupEndpoints],
      onInit: async (payload) => {
        await incomingConfig.onInit?.(payload)
        try {
          const existing = await payload.count({
            collection: BACKUP_SETTINGS_SLUG,
            overrideAccess: true,
          })
          if (existing.totalDocs === 0) {
            await payload.create({
              collection: BACKUP_SETTINGS_SLUG,
              data: {
                backupBlobAccess: null,
                backupBlobReadWriteToken: '',
                backupsToKeep: Number(process.env.BACKUPS_TO_KEEP) || 10,
                includeMediaForCron: true,
                skipTables: [],
              },
              overrideAccess: true,
            })
            payload.logger.info('[backup-plugin] Created default backup-settings document')
          }
        } catch (err) {
          payload.logger.warn({ err }, '[backup-plugin] Could not ensure backup-settings document')
        }
        // Postgres has no TTL indexes: prune finished/abandoned progress rows on start-up.
        await pruneStaleBackupTasks(payload)
      },
    }
  }
}
