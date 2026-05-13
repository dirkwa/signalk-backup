/**
 * QuestDB exporter — pulls data via signalk-questdb's HTTP route.
 *
 * The signalk-questdb plugin exposes:
 *   GET /plugins/signalk-questdb/api/full-export/tables → { tables: [...] }
 *   GET /plugins/signalk-questdb/api/full-export/<table>?from=&to= → parquet stream
 *
 * Both are served by SignalK in-process, so we reach them via plain HTTP
 * over loopback. No container exec, no shared filesystem ownership issues.
 *
 * For each table we partition the export by ISO week into one parquet
 * file per week. Closed weeks become byte-identical across export cycles
 * and dedup perfectly in kopia. The current ("open") week plus a small
 * rolling churn window get re-exported each cycle to absorb late arrivals.
 *
 * Streams the response body directly to a temp file in the shard's
 * directory, then atomically renames into place — so a snapshot
 * mid-export never sees a half-written parquet.
 */

import { mkdir, rename, unlink } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import type { DatabaseExporter, ExportResult, TableExport } from './types.js'
import {
  weekStartUtc,
  weekEndUtc,
  isoWeekOf,
  formatIsoWeek,
  weeksBetween,
  compareIsoWeek,
  type IsoWeek
} from './iso-week.js'
import {
  readManifest,
  writeManifest,
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  type ShardEntry
} from './manifest.js'

const QUESTDB_PLUGIN_ID = 'signalk-questdb'
const DEFAULT_SIGNALK_BASE = 'http://127.0.0.1:3000'
const FETCH_TIMEOUT_MS = 600_000
const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Closed weeks within this many cycles still get re-exported (late-arrival absorption). */
const ROLLING_CHURN_WEEKS = 4

export interface QuestDBExporterOptions {
  signalkBaseUrl?: string
  log?: (msg: string) => void
  /** Override fetch (tests). */
  fetch?: typeof fetch
  /** Override "now" (tests). */
  now?: () => Date
}

export class QuestDBExporter implements DatabaseExporter {
  readonly pluginId = QUESTDB_PLUGIN_ID

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly nowImpl: () => Date

  constructor(opts: QuestDBExporterOptions = {}) {
    this.baseUrl = (opts.signalkBaseUrl ?? DEFAULT_SIGNALK_BASE).replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? fetch
    this.nowImpl = opts.now ?? (() => new Date())
    this.log = (msg: string) => opts.log?.(`[questdb-export] ${msg}`)
  }

  private readonly log: (msg: string) => void

  async detect(): Promise<boolean> {
    try {
      const tables = await this.listTables()
      return tables.length > 0
    } catch (err) {
      this.log(`detect failed: ${errMsg(err)}`)
      return false
    }
  }

  async exportAll(stagingDir: string): Promise<ExportResult> {
    const startedAt = Date.now()
    await mkdir(stagingDir, { recursive: true })
    const tables = await this.listTables()

    const exports: TableExport[] = []
    for (const table of tables) {
      if (!SAFE_TABLE_NAME.test(table)) {
        this.log(`refusing unsafe table identifier: ${table}`)
        continue
      }
      try {
        exports.push(await this.exportTable(table, stagingDir))
      } catch (err) {
        this.log(`export failed for ${table}: ${errMsg(err)}`)
      }
    }

    return {
      pluginId: this.pluginId,
      tables: exports,
      totalBytes: exports.reduce((acc, t) => acc + t.bytes, 0),
      durationMs: Date.now() - startedAt
    }
  }

  // ---------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------

  private async listTables(): Promise<string[]> {
    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/tables`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      throw new Error(`tables HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = (await res.json()) as { tables?: unknown }
    if (!Array.isArray(body.tables)) {
      throw new Error(`tables response missing 'tables' array`)
    }
    const out: string[] = []
    for (const t of body.tables) {
      if (typeof t === 'string') out.push(t)
    }
    return out
  }

  private async exportTable(table: string, stagingDir: string): Promise<TableExport> {
    const tableDir = join(stagingDir, table)
    await mkdir(tableDir, { recursive: true })

    // One-shot migration of any pre-partitioning flat file. Move-aside,
    // never delete — user may want to re-import it.
    await this.migrateLegacyFlatFile(stagingDir, table)

    const existing = await readManifest(tableDir)
    const nowIso = this.nowImpl()
    const currentWeek = isoWeekOf(nowIso)

    // Range to materialise: from whatever the manifest already covers,
    // back through (at minimum) the rolling churn window, up to the
    // current week. If no manifest exists yet, start from the churn
    // cutoff — that catches data from the last ROLLING_CHURN_WEEKS
    // weeks on first run. Deeper history pre-dates this code path and
    // is not auto-recovered (would need an admin-triggered backfill,
    // out of scope here).
    const churnCutoff = this.churnCutoffWeek(currentWeek)
    const earliestKnown = this.earliestWeekFromManifest(existing)
    const earliestWeek =
      earliestKnown !== null && compareIsoWeek(earliestKnown, churnCutoff) < 0
        ? earliestKnown
        : churnCutoff
    const allWeeks = weeksBetween(earliestWeek, currentWeek)
    const existingShards = new Map<string, ShardEntry>()
    for (const s of existing?.shards ?? []) existingShards.set(s.file, s)

    const newShards: ShardEntry[] = []
    let shardsWritten = 0
    let shardsSkipped = 0
    let bytesWritten = 0

    for (const week of allWeeks) {
      const file = `${table}_${formatIsoWeek(week)}.parquet`
      const isOpen = compareIsoWeek(week, currentWeek) === 0
      const inChurnWindow = compareIsoWeek(week, churnCutoff) >= 0
      const known = existingShards.get(file)
      const onDisk = existsSync(join(tableDir, file))
      const mustWrite = isOpen || inChurnWindow || !known || !onDisk

      if (mustWrite) {
        const { bytes } = await this.exportWeekToShard(table, week, tableDir, file)
        const entry: ShardEntry = {
          file,
          weekStart: weekStartUtc(week).toISOString(),
          bytes,
          exportedAt: nowIso.toISOString()
        }
        newShards.push(entry)
        shardsWritten++
        bytesWritten += bytes
      } else {
        // Closed shard, outside churn window, already present. Reuse the manifest entry.
        newShards.push(known)
        shardsSkipped++
      }
    }

    const openFile = `${table}_${formatIsoWeek(currentWeek)}.parquet`
    const manifest: Manifest = {
      tableName: table,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      shards: newShards,
      openShard: openFile,
      lastExportRun: nowIso.toISOString()
    }
    await writeManifest(tableDir, manifest)

    this.log(
      `${table}: ${shardsWritten} shards written, ${shardsSkipped} unchanged, ${bytesWritten} bytes`
    )

    return {
      table,
      tableDir,
      shardsWritten,
      shardsSkipped,
      bytes: bytesWritten
    }
  }

  /**
   * If the staging dir has a `<table>.parquet` directly (pre-partitioning
   * layout), move it aside to `<table>.parquet.legacy`. Idempotent.
   */
  private async migrateLegacyFlatFile(stagingDir: string, table: string): Promise<void> {
    const flat = join(stagingDir, `${table}.parquet`)
    const legacy = `${flat}.legacy`
    if (existsSync(flat) && !existsSync(legacy)) {
      try {
        await rename(flat, legacy)
        this.log(
          `migrated legacy ${table}.parquet → ${table}.parquet.legacy; partitioned export starting fresh`
        )
      } catch (err) {
        // Non-fatal: leave the flat file in place. Next cycle retries.
        this.log(`legacy-file migration failed for ${table}: ${errMsg(err)}`)
      }
    }
  }

  /**
   * Earliest week recorded in a manifest, or null if no shards exist.
   * Pure helper, no I/O — manifest is already read by the caller.
   */
  private earliestWeekFromManifest(manifest: Manifest | null): IsoWeek | null {
    if (!manifest || manifest.shards.length === 0) return null
    const oldest = manifest.shards
      .map((s) => new Date(s.weekStart))
      .reduce((a, b) => (a.getTime() < b.getTime() ? a : b))
    return isoWeekOf(oldest)
  }

  private churnCutoffWeek(current: IsoWeek): IsoWeek {
    // Walk back ROLLING_CHURN_WEEKS Mondays from the current week's Monday.
    const start = weekStartUtc(current)
    const earlier = new Date(start.getTime() - ROLLING_CHURN_WEEKS * 7 * 86_400_000)
    return isoWeekOf(earlier)
  }

  private async exportWeekToShard(
    table: string,
    week: IsoWeek,
    tableDir: string,
    filename: string
  ): Promise<{ bytes: number }> {
    const from = weekStartUtc(week).toISOString()
    const to = weekEndUtc(week).toISOString()
    const url = new URL(`${this.baseUrl}/plugins/${this.pluginId}/api/full-export/${table}`)
    url.searchParams.set('from', from)
    url.searchParams.set('to', to)

    const finalPath = join(tableDir, filename)
    const tempPath = `${finalPath}.partial`

    const res = await this.fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok || !res.body) {
      throw new Error(
        `HTTP ${res.status} for ${filename}: ${(await res.text().catch(() => '')).slice(0, 200)}`
      )
    }

    const out = createWriteStream(tempPath)
    let bytes = 0
    const reader = Readable.fromWeb(res.body as never)
    reader.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    try {
      await pipeline(reader, out)
    } catch (err) {
      await unlink(tempPath).catch(() => undefined)
      throw err
    }

    await rename(tempPath, finalPath)
    return { bytes }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
