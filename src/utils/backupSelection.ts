import type { BackupSourcePreviewResponse } from '../core/backupSourcePreview'

export function skipTablesFromPreview(
  preview: BackupSourcePreviewResponse,
  selected: Record<string, boolean>,
): string[] {
  return preview.groups.filter((g) => selected[g.groupId] === false).flatMap((g) => g.tableNames)
}

/**
 * Derives checkbox state from stored Postgres table names to skip (cron / settings).
 */
export function selectedFromSkipTables(
  preview: BackupSourcePreviewResponse,
  skipTableNames: string[],
): Record<string, boolean> {
  const skip = new Set(skipTableNames)
  const selected: Record<string, boolean> = {}
  for (const g of preview.groups) {
    const allSkipped = g.tableNames.length > 0 && g.tableNames.every((m) => skip.has(m))
    selected[g.groupId] = !allSkipped
  }
  return selected
}
