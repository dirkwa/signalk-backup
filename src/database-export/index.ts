/**
 * Database export orchestrator.
 *
 * Plugin-side counterpart to docs/v0.2-database-backup-design.md. The
 * exporter pulls data via the source plugin's HTTP route on the SignalK
 * server itself — no container exec or shared filesystems involved.
 *
 * Currently supports QuestDB only. InfluxDB is intentionally out of
 * scope (see design doc).
 */

import { mkdir } from 'fs/promises'
import { join } from 'path'
import { QuestDBExporter } from './questdb'
import type { DatabaseExporter, ExportResult } from './types'

const PLUGIN_ID = 'signalk-backup'
const STAGING_SUBDIR = 'database-exports'

export interface ExportOrchestratorOptions {
  /** Host-visible path to the SignalK config root. */
  signalkConfigRoot: string
  /** SignalK server base URL (loopback) — used to talk to source plugins. */
  signalkBaseUrl: string
  /** Optional debug logger. */
  log?: (msg: string) => void
}

/**
 * Run every supported exporter whose `detect()` returns true. Each
 * exporter writes its parquet files under
 *   <configRoot>/plugin-config-data/signalk-backup/database-exports/<pluginId>/
 * which is the staging area kopia will pick up on the next snapshot.
 *
 * Errors in one exporter are logged but don't abort the rest — partial
 * coverage is preferable to none. The returned array contains one
 * ExportResult per exporter that ran (regardless of success).
 */
export async function runAllExports(opts: ExportOrchestratorOptions): Promise<ExportResult[]> {
  const stagingRoot = join(opts.signalkConfigRoot, 'plugin-config-data', PLUGIN_ID, STAGING_SUBDIR)
  await mkdir(stagingRoot, { recursive: true })

  const exporters: DatabaseExporter[] = [
    new QuestDBExporter({
      signalkBaseUrl: opts.signalkBaseUrl,
      log: opts.log
    })
  ]

  const results: ExportResult[] = []
  for (const exporter of exporters) {
    if (!(await exporter.detect())) {
      opts.log?.(`[db-export] skipping ${exporter.pluginId} (detect failed)`)
      continue
    }
    const stagingDir = join(stagingRoot, exporter.pluginId)
    try {
      const r = await exporter.exportAll(stagingDir)
      results.push(r)
      opts.log?.(
        `[db-export] ${exporter.pluginId}: ${r.tables.length} tables, ` +
          `${r.totalBytes} bytes, ${r.durationMs}ms`
      )
    } catch (err) {
      opts.log?.(
        `[db-export] ${exporter.pluginId} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return results
}

export type { DatabaseExporter, ExportResult, TableExport } from './types'
export { QuestDBExporter } from './questdb'
