import type { Config } from 'payload'

import { describe, expect, it } from 'vitest'

import { backupPostgresPlugin } from '../../src/plugin.js'

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    admin: {},
    collections: [],
    endpoints: [],
    ...overrides,
  } as unknown as Config
}

/**
 * Payload types `Plugin` as `(config) => Config | Promise<Config>`. `backupPostgresPlugin`
 * always returns synchronously, so narrow it here to keep the test assertions tidy.
 */
function applyPlugin(options: Parameters<typeof backupPostgresPlugin>[0], config: Config): Config {
  const result = backupPostgresPlugin(options)(config)
  if (result instanceof Promise) {
    throw new Error('backupPostgresPlugin unexpectedly returned a Promise')
  }
  return result
}

describe('backupPostgresPlugin', () => {
  it('returns the incoming config untouched when enabled=false', () => {
    const input = baseConfig({
      collections: [{ slug: 'existing' } as never],
    })
    const out = applyPlugin({ enabled: false }, input)
    expect(out).toBe(input)
  })

  it('registers the backup-tasks and backup-settings collections alongside existing ones', () => {
    const existing = { slug: 'existing' } as never
    const out = applyPlugin({}, baseConfig({ collections: [existing] }))
    const slugs = (out.collections ?? []).map((c: { slug: string }) => c.slug)
    expect(slugs).toContain('existing')
    expect(slugs).toContain('backup-tasks')
    expect(slugs).toContain('backup-settings')
  })

  it('appends backup endpoints without removing existing ones', () => {
    const existingEp = {
      handler: () => new Response('ok'),
      method: 'get' as const,
      path: '/pre-existing',
    }
    const out = applyPlugin({}, baseConfig({ endpoints: [existingEp as never] }))
    const paths = (out.endpoints ?? []).map((e: { path: string }) => e.path)
    expect(paths).toContain('/pre-existing')
    expect(paths).toContain('/backup-postgres/cron/run')
    expect(paths).toContain('/backup-postgres/admin/manual')
    expect(paths).toContain('/backup-postgres/admin/restore')
    expect(paths).toContain('/backup-postgres/admin/task/:id')
  })

  it('registers the BackupDashboard at /db-backups and preserves existing admin views', () => {
    const existingView = { Component: 'some/existing/component', path: '/existing' }
    const existingAfterDashboard = 'some/existing/after-dashboard'
    const out = applyPlugin(
      {},
      baseConfig({
        admin: {
          components: { afterDashboard: [existingAfterDashboard as never] },
          views: { existing: existingView },
        },
      } as Partial<Config>),
    )
    expect(out.admin?.views?.existing).toBe(existingView)
    expect(out.admin?.views?.dbBackups).toEqual({
      Component: 'payload-plugin-backup-postgres/rsc#BackupDashboard',
      path: '/db-backups',
    })
    expect(out.admin?.components?.afterDashboard).toEqual([existingAfterDashboard])
  })
})
