// Mirrors the Grafana exporter: pulls signalk-database's /api/full-export/{databases,<id>} over loopback and stages one db.sqlite per consumer-plugin into kopia's snapshot tree.

import { mkdir, rename, rm, unlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import type { DatabaseExporter, ExportResult, TableExport } from './types.js'

const SIGNALK_DATABASE_PLUGIN_ID = 'signalk-database'
const DEFAULT_SIGNALK_BASE = 'http://127.0.0.1:3000'
const FETCH_TIMEOUT_MS = 600_000
// Same id grammar the source plugin enforces — reject early so we never
// even try a fetch the server would 400 on.
const SAFE_ID = /^[A-Za-z0-9._-]+$/

export interface SignalKDatabaseExporterOptions {
  signalkBaseUrl?: string
  log?: (msg: string) => void
  /** Override fetch (tests). */
  fetch?: typeof fetch
}

interface DatabaseEntry {
  id: string
  bytes: number
  modifiedAt: string
}

export class SignalKDatabaseExporter implements DatabaseExporter {
  readonly pluginId = SIGNALK_DATABASE_PLUGIN_ID

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly log: (msg: string) => void

  constructor(opts: SignalKDatabaseExporterOptions = {}) {
    this.baseUrl = (opts.signalkBaseUrl ?? DEFAULT_SIGNALK_BASE).replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? fetch
    this.log = (msg: string) => opts.log?.(`[signalk-database-export] ${msg}`)
  }

  async detect(): Promise<boolean> {
    // Manifest is cheap — GET returning 200 with a `databases` array even
    // when there are zero consumer DBs yet (empty plugin-config-data).
    try {
      const manifest = await this.fetchManifest(5_000)
      return Array.isArray(manifest)
    } catch (err) {
      this.log(`detect failed: ${errMsg(err)}`)
      return false
    }
  }

  async exportAll(stagingDir: string): Promise<ExportResult> {
    const startedAt = Date.now()
    await mkdir(stagingDir, { recursive: true })

    // Reset the staging tree so DBs removed from disk (because the
    // consumer plugin was uninstalled) don't linger in kopia forever.
    await this.resetStagingDir(stagingDir)
    await mkdir(stagingDir, { recursive: true })

    const manifest = await this.fetchManifest(10_000)

    const exports: TableExport[] = []
    let totalBytes = 0

    for (const entry of manifest) {
      if (!SAFE_ID.test(entry.id) || entry.id === '.' || entry.id === '..') {
        this.log(`skip suspicious id: ${entry.id}`)
        continue
      }
      try {
        const bytes = await this.exportOne(entry, stagingDir)
        exports.push({
          // `table` is the per-row label in the result manifest. For us,
          // each row is a whole consumer DB — use the id verbatim.
          table: entry.id,
          tableDir: join(stagingDir, entry.id),
          shardsWritten: 1,
          shardsSkipped: 0,
          bytes
        })
        totalBytes += bytes
      } catch (err) {
        this.log(`export ${entry.id} failed: ${errMsg(err)}`)
      }
    }

    return {
      pluginId: this.pluginId,
      tables: exports,
      totalBytes,
      durationMs: Date.now() - startedAt
    }
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private async fetchManifest(timeoutMs: number): Promise<DatabaseEntry[]> {
    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/databases`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      throw new Error(`manifest HTTP ${res.status}`)
    }
    const body = (await res.json()) as { databases?: unknown }
    if (!Array.isArray(body.databases)) {
      throw new Error(`manifest missing 'databases' array`)
    }
    const out: DatabaseEntry[] = []
    for (const raw of body.databases) {
      const parsed = this.parseEntry(raw)
      if (parsed) out.push(parsed)
    }
    return out
  }

  private parseEntry(raw: unknown): DatabaseEntry | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.bytes !== 'number') return null
    if (typeof o.modifiedAt !== 'string') return null
    return { id: o.id, bytes: o.bytes, modifiedAt: o.modifiedAt }
  }

  private async exportOne(entry: DatabaseEntry, stagingDir: string): Promise<number> {
    const dir = join(stagingDir, entry.id)
    await mkdir(dir, { recursive: true })
    const finalPath = join(dir, 'db.sqlite')

    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/${encodeURIComponent(entry.id)}`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    if (!res.body) {
      throw new Error('response body is empty')
    }
    const bytes = await atomicWrite(res.body, finalPath)
    this.log(`wrote ${entry.id}/db.sqlite (${bytes} bytes)`)
    return bytes
  }

  // Errors propagate so a failed reset reports as failed-section instead of emitting a half-fresh half-stale tree.
  private async resetStagingDir(root: string): Promise<void> {
    await rm(root, { recursive: true, force: true })
  }
}

// Failed writes unlink the partial so half-written data can't slip into the next snapshot.
async function atomicWrite(body: ReadableStream<Uint8Array>, finalPath: string): Promise<number> {
  const partialPath = `${finalPath}.partial`
  const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
  const sink = createWriteStream(partialPath)
  let bytes = 0
  nodeStream.on('data', (chunk: Buffer) => {
    bytes += chunk.length
  })
  try {
    await pipeline(nodeStream, sink)
    await rename(partialPath, finalPath)
    return bytes
  } catch (err) {
    await unlink(partialPath).catch(() => undefined)
    throw err
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
