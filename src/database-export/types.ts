/**
 * Common types for database exporters.
 *
 * Each exporter targets ONE database plugin (signalk-questdb, etc.) and
 * produces one parquet file per table. Files land in a staging directory
 * inside the SignalK config root so kopia picks them up automatically as
 * part of the next snapshot — there's no separate "upload" step.
 */

export interface TableExport {
  table: string
  /** Host-visible absolute path to the exported parquet file. */
  parquetPath: string
  rowCount: number
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
