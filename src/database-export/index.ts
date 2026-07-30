/**
 * Database export orchestrator.
 *
 * Plugin-side counterpart to docs/v0.2-database-backup-design.md. The
 * exporter pulls data via the source plugin's HTTP route on the SignalK
 * server itself — no container exec or shared filesystems involved.
 *
 * Supports QuestDB and Grafana. InfluxDB is intentionally out of scope
 * (see design doc).
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { GrafanaExporter } from './grafana.js'
import { QuestDBExporter } from './questdb.js'
import { SignalKDatabaseExporter } from './signalk-database.js'
import type { DatabaseExporter, ExportResult } from './types.js'
import { errMsg } from '../errors.js'

const PLUGIN_ID = 'signalk-backup'
const STAGING_SUBDIR = 'database-exports'

export interface ExportOrchestratorOptions {
  /** Host-visible path to the SignalK config root. */
  signalkConfigRoot: string
  /** SignalK server base URL (loopback) — used to talk to source plugins. */
  signalkBaseUrl: string
  /** Optional debug logger. */
  log?: (msg: string) => void
  // Operator-visible sink: an enabled export that produced nothing must not be
  // debug-only, which made a dead base URL look like "working fine" (#90).
  warn?: (msg: string) => void
  // Missing key = disabled, matching SCHEMA_DEFAULTS.databaseExport.
  enabled?: { questdb?: boolean; grafana?: boolean; signalkDatabase?: boolean }
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

  const enabled = opts.enabled ?? {}
  const exporters: DatabaseExporter[] = []
  if (enabled.questdb === true) {
    exporters.push(
      new QuestDBExporter({
        signalkBaseUrl: opts.signalkBaseUrl,
        log: opts.log
      })
    )
  }
  if (enabled.grafana === true) {
    exporters.push(
      new GrafanaExporter({
        signalkBaseUrl: opts.signalkBaseUrl,
        log: opts.log
      })
    )
  }
  if (enabled.signalkDatabase === true) {
    exporters.push(
      new SignalKDatabaseExporter({
        signalkBaseUrl: opts.signalkBaseUrl,
        log: opts.log
      })
    )
  }

  const results: ExportResult[] = []
  for (const exporter of exporters) {
    // A throwing detect() must not strand the exporters queued behind it.
    let detected: boolean
    try {
      detected = await exporter.detect()
    } catch (err) {
      opts.warn?.(`[db-export] ${exporter.pluginId} detection failed: ${errMsg(err)}`)
      continue
    }
    if (!detected) {
      const warning =
        `${exporter.pluginId} export is enabled but the plugin did not respond at ` +
        `${opts.signalkBaseUrl} — nothing was exported. Check that the plugin is ` +
        `installed and enabled, and that this is the URL SignalK actually listens on.`
      opts.warn?.(`[db-export] ${warning}`)
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
      opts.log?.(`[db-export] ${exporter.pluginId} failed: ${errMsg(err)}`)
    }
  }
  return results
}

export type { DatabaseExporter, ExportResult, TableExport } from './types.js'
export { GrafanaExporter } from './grafana.js'
export { QuestDBExporter } from './questdb.js'
export { SignalKDatabaseExporter } from './signalk-database.js'
