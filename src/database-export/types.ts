/**
 * Common types for database exporters.
 *
 * Each exporter targets ONE database plugin (signalk-questdb, etc.) and
 * produces parquet files in a staging directory inside the SignalK
 * config root so kopia picks them up automatically as part of the next
 * snapshot — there's no separate "upload" step.
 *
 * Per-table output is partitioned by ISO week into multiple parquet
 * shards (closed weeks become byte-identical and dedup perfectly).
 */

export interface TableExport {
  table: string
  /** Host-visible absolute path to the table's directory (NOT a single file). */
  tableDir: string
  /** Number of parquet shards written this cycle (current week + rolling churn window). */
  shardsWritten: number
  /** Number of closed shards that were skipped (already present, unchanged). */
  shardsSkipped: number
  /** Total bytes written this cycle (sum across shardsWritten). */
  bytes: number
}

export interface ExportResult {
  /** The signalk plugin id whose data this represents (e.g. 'signalk-questdb'). */
  pluginId: string
  tables: TableExport[]
  totalBytes: number
  durationMs: number
}

export interface DatabaseExporter {
  readonly pluginId: string
  /** Probe — returns true if this exporter can run against the live system. */
  detect(): Promise<boolean>
  /** Run a full export of every user table. Caller has already created stagingDir. */
  exportAll(stagingDir: string): Promise<ExportResult>
}
