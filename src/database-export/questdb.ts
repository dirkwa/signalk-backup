/**
 * QuestDB exporter — pulls data via signalk-questdb's HTTP route.
 *
 * The signalk-questdb plugin exposes:
 *   GET /plugins/signalk-questdb/api/full-export/tables → { tables: [...] }
 *   GET /plugins/signalk-questdb/api/full-export/<table>  → parquet stream
 *
 * Both are served by SignalK in-process, so we reach them via plain HTTP
 * over loopback. No container exec, no shared filesystem ownership
 * issues, no copy-completion polling.
 *
 * Streams the response body directly to a temp file in the staging dir,
 * then atomically renames into place — so a snapshot mid-export never
 * sees a half-written parquet.
 */

import { mkdir, rename, unlink } from 'fs/promises'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { join } from 'path'
import type { DatabaseExporter, ExportResult, TableExport } from './types'

const QUESTDB_PLUGIN_ID = 'signalk-questdb'
/** Default base URL — overridable for tests. SignalK normally listens here. */
const DEFAULT_SIGNALK_BASE = 'http://127.0.0.1:3000'
/** Per-request timeout. A full-table export of ~500k rows runs in <1s on
 *  a Pi over the loopback HTTP path, but pipe between pi-host-network +
 *  pasta containers can stall — bound at 10 minutes. */
const FETCH_TIMEOUT_MS = 600_000
const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export interface QuestDBExporterOptions {
  /** SignalK server base URL — typically http://127.0.0.1:3000 */
  signalkBaseUrl?: string
  /** Optional debug logger. */
  log?: (msg: string) => void
  /** Override fetch (tests). */
  fetch?: typeof fetch
}

export class QuestDBExporter implements DatabaseExporter {
  readonly pluginId = QUESTDB_PLUGIN_ID

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: QuestDBExporterOptions = {}) {
    this.baseUrl = (opts.signalkBaseUrl ?? DEFAULT_SIGNALK_BASE).replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? fetch
    this.log = (msg: string) => opts.log?.(`[questdb-export] ${msg}`)
  }

  private readonly log: (msg: string) => void

  /**
   * Detect: hit the tables endpoint. Returns true on HTTP 200 with at
   * least one table; false on any error or 503/404 (plugin disabled or
   * not loaded).
   */
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
      // Defence in depth — the route should reject these too, but a
      // malformed name in the request URL is worth catching here.
      if (!SAFE_TABLE_NAME.test(table)) {
        this.log(`refusing unsafe table identifier: ${table}`)
        continue
      }
      try {
        exports.push(await this.exportTable(table, stagingDir))
      } catch (err) {
        // Partial coverage > none. Log and keep going.
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
    const res = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(10_000)
    })
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
    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/${table}`
    const finalPath = join(stagingDir, `${table}.parquet`)
    const tempPath = `${finalPath}.partial`

    this.log(`exporting ${table}`)
    const res = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    }

    // Stream the response body to a temp file, then atomic-rename. This
    // means a kopia snapshot that races us mid-export sees either the
    // previous .parquet or no entry — never a torn write.
    const out = createWriteStream(tempPath)
    let bytes = 0
    out.on('drain', () => undefined)
    // Count bytes via a tap — pipeline doesn't expose them otherwise.
    const reader = Readable.fromWeb(res.body as never)
    reader.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    try {
      await pipeline(reader, out)
    } catch (err) {
      // Best-effort cleanup of partial file.
      await unlink(tempPath).catch(() => undefined)
      throw err
    }

    await rename(tempPath, finalPath)

    // rowCount is unknown without a separate query; leaving 0 keeps the
    // shape stable. Bytes carries the meaningful "what got captured".
    this.log(`exported ${table}: ${bytes} bytes`)
    return { table, parquetPath: finalPath, rowCount: 0, bytes }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
