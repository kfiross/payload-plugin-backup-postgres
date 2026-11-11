import { describe, expect, it } from 'vitest'

import type { BackupSourcePreviewResponse } from '../../src/core/backupSourcePreview.js'

import { selectedFromSkipTables, skipTablesFromPreview } from '../../src/utils/backupSelection.js'

function mockPreview(groups: BackupSourcePreviewResponse['groups']): BackupSourcePreviewResponse {
  return {
    groups,
    mediaBlobCandidates: 0,
  }
}

describe('backupSelection', () => {
  it('skipTablesFromPreview excludes unchecked groups', () => {
    const preview = mockPreview([
      {
        adminHidden: false,
        adminHiddenReasons: [],
        affectsAuthSession: false,
        displayTitle: 'Pages',
        groupId: 'pages',
        main: { docCount: 2, tableName: 'pages' },
        tableNames: ['pages', '_pages_versions'],
        versions: { docCount: 1, tableName: '_pages_versions' },
      },
      {
        adminHidden: false,
        adminHiddenReasons: [],
        affectsAuthSession: false,
        displayTitle: 'Media',
        groupId: 'media',
        main: { docCount: 0, tableName: 'media' },
        tableNames: ['media'],
      },
    ])
    const selected = { media: true as const, pages: false as const }
    expect(skipTablesFromPreview(preview, selected)).toEqual(['pages', '_pages_versions'])
  })

  it('selectedFromSkipTables unchecks groups fully covered by skip list', () => {
    const preview = mockPreview([
      {
        adminHidden: false,
        adminHiddenReasons: [],
        affectsAuthSession: false,
        displayTitle: 'A',
        groupId: 'a',
        main: { docCount: 1, tableName: 'a1' },
        tableNames: ['a1', 'a2'],
      },
      {
        adminHidden: false,
        adminHiddenReasons: [],
        affectsAuthSession: false,
        displayTitle: 'B',
        groupId: 'b',
        main: { docCount: 1, tableName: 'b1' },
        tableNames: ['b1'],
      },
    ])
    const selected = selectedFromSkipTables(preview, ['a1', 'a2'])
    expect(selected.a).toBe(false)
    expect(selected.b).not.toBe(false)
  })
})
