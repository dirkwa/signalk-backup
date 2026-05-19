// Mirrors the QuestDB exporter: pulls signalk-grafana's /api/full-export/{db,dashboards,provisioning} over loopback and stages into kopia's snapshot tree.

import { mkdir, rename, rm, unlink } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { DatabaseExporter, ExportResult, TableExport } from './types.js'

const GRAFANA_PLUGIN_ID = 'signalk-grafana'
const DEFAULT_SIGNALK_BASE = 'http://127.0.0.1:3000'
const FETCH_TIMEOUT_MS = 600_000
// Engine-side validation rejects names outside this set; reject early
// here too so we never even try a fetch that the server would 400.
const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/

export interface GrafanaExporterOptions {
  signalkBaseUrl?: string
  log?: (msg: string) => void
  /** Override fetch (tests). */
  fetch?: typeof fetch
}

interface DashboardEntry {
  name: string
  sha256: string
  bytes: number
}

interface ProvisioningEntry {
  name: string
  relPath: string
  sha256: string
  bytes: number
}

export class GrafanaExporter implements DatabaseExporter {
  readonly pluginId = GRAFANA_PLUGIN_ID

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly log: (msg: string) => void

  constructor(opts: GrafanaExporterOptions = {}) {
    this.baseUrl = (opts.signalkBaseUrl ?? DEFAULT_SIGNALK_BASE).replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? fetch
    this.log = (msg: string) => opts.log?.(`[grafana-export] ${msg}`)
  }

  async detect(): Promise<boolean> {
    // Dashboards manifest is the cheapest probe — GET, no container exec, 200 even when /var/lib/grafana is empty.
    try {
      const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/dashboards`
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return false
      const body = (await res.json()) as { dashboards?: unknown }
      return Array.isArray(body.dashboards)
    } catch (err) {
      this.log(`detect failed: ${errMsg(err)}`)
      return false
    }
  }

  async exportAll(stagingDir: string): Promise<ExportResult> {
    const startedAt = Date.now()
    await mkdir(stagingDir, { recursive: true })

    const exports: TableExport[] = []
    let totalBytes = 0

    // Use TableExport-as-single-shard so totals line up with QuestDB reports.
    try {
      const dbBytes = await this.exportDb(stagingDir)
      exports.push({
        table: 'grafana.db',
        tableDir: stagingDir,
        shardsWritten: 1,
        shardsSkipped: 0,
        bytes: dbBytes
      })
      totalBytes += dbBytes
    } catch (err) {
      this.log(`db export failed: ${errMsg(err)}`)
    }

    try {
      const bytes = await this.exportDashboards(stagingDir)
      exports.push({
        table: 'dashboards',
        tableDir: join(stagingDir, 'dashboards'),
        shardsWritten: bytes.count,
        shardsSkipped: bytes.skipped,
        bytes: bytes.totalBytes
      })
      totalBytes += bytes.totalBytes
    } catch (err) {
      this.log(`dashboards export failed: ${errMsg(err)}`)
    }

    try {
      const bytes = await this.exportProvisioning(stagingDir)
      exports.push({
        table: 'provisioning',
        tableDir: join(stagingDir, 'provisioning'),
        shardsWritten: bytes.count,
        shardsSkipped: bytes.skipped,
        bytes: bytes.totalBytes
      })
      totalBytes += bytes.totalBytes
    } catch (err) {
      this.log(`provisioning export failed: ${errMsg(err)}`)
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

  private async exportDb(stagingDir: string): Promise<number> {
    const finalPath = join(stagingDir, 'grafana.db')
    // Drop the prior-cycle file first so a mid-cycle failure leaves no stale grafana.db beside fresh dashboards.
    if (existsSync(finalPath)) await unlink(finalPath).catch(() => undefined)

    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/db`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      throw new Error(`db HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    if (!res.body) {
      throw new Error('db response body is empty')
    }
    const bytes = await atomicWrite(res.body, finalPath)
    this.log(`wrote grafana.db (${bytes} bytes)`)
    return bytes
  }

  private async exportDashboards(stagingDir: string): Promise<{
    count: number
    skipped: number
    totalBytes: number
  }> {
    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/dashboards`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      throw new Error(`dashboards manifest HTTP ${res.status}`)
    }
    const body = (await res.json()) as { dashboards?: unknown }
    if (!Array.isArray(body.dashboards)) {
      throw new Error(`dashboards manifest missing 'dashboards' array`)
    }

    const dashboardsDir = join(stagingDir, 'dashboards')
    // Reset so dashboards deleted in Grafana don't linger in kopia forever.
    await this.resetStagingDir(dashboardsDir)

    let totalBytes = 0
    let count = 0
    let skipped = 0
    for (const raw of body.dashboards) {
      const entry = this.parseDashboardEntry(raw)
      if (!entry) {
        skipped++
        continue
      }
      try {
        totalBytes += await this.fetchDashboardFile(entry, dashboardsDir)
        count++
      } catch (err) {
        skipped++
        this.log(`dashboard ${entry.name} failed: ${errMsg(err)}`)
      }
    }
    return { count, skipped, totalBytes }
  }

  private parseDashboardEntry(raw: unknown): DashboardEntry | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (typeof o.name !== 'string' || !SAFE_FILENAME.test(o.name)) return null
    // SAFE_FILENAME matches "." and "..", which would resolve to the dir
    // itself or its parent under join(). Server rejects these too, but
    // belt-and-braces is cheap.
    if (o.name === '.' || o.name === '..') return null
    if (typeof o.sha256 !== 'string' || typeof o.bytes !== 'number') return null
    return { name: o.name, sha256: o.sha256, bytes: o.bytes }
  }

  private async fetchDashboardFile(entry: DashboardEntry, dashboardsDir: string): Promise<number> {
    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/dashboards/${encodeURIComponent(entry.name)}`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`)
    }
    return atomicWrite(res.body, join(dashboardsDir, entry.name))
  }

  private async exportProvisioning(stagingDir: string): Promise<{
    count: number
    skipped: number
    totalBytes: number
  }> {
    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/provisioning`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      throw new Error(`provisioning manifest HTTP ${res.status}`)
    }
    const body = (await res.json()) as { files?: unknown }
    if (!Array.isArray(body.files)) {
      throw new Error(`provisioning manifest missing 'files' array`)
    }

    const provisioningDir = join(stagingDir, 'provisioning')
    // Reset so removed YAMLs don't linger in kopia forever.
    await this.resetStagingDir(provisioningDir)

    let totalBytes = 0
    let count = 0
    let skipped = 0
    for (const raw of body.files) {
      const entry = this.parseProvisioningEntry(raw)
      if (!entry) {
        skipped++
        continue
      }
      try {
        totalBytes += await this.fetchProvisioningFile(entry, provisioningDir)
        count++
      } catch (err) {
        skipped++
        this.log(`provisioning ${entry.relPath} failed: ${errMsg(err)}`)
      }
    }
    return { count, skipped, totalBytes }
  }

  private parseProvisioningEntry(raw: unknown): ProvisioningEntry | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (typeof o.name !== 'string' || !SAFE_FILENAME.test(o.name)) return null
    if (typeof o.relPath !== 'string') return null
    // Reject relPaths that try to escape via `..` or absolute paths
    // before we use them in a host filesystem write. The server-side
    // endpoint also rejects these, but defending in depth is cheap.
    const segments = o.relPath.split('/').filter(Boolean)
    if (segments.length === 0) return null
    for (const seg of segments) {
      if (seg === '..' || seg === '.' || !SAFE_FILENAME.test(seg)) return null
    }
    if (typeof o.sha256 !== 'string' || typeof o.bytes !== 'number') return null
    return { name: o.name, relPath: o.relPath, sha256: o.sha256, bytes: o.bytes }
  }

  private async fetchProvisioningFile(
    entry: ProvisioningEntry,
    provisioningDir: string
  ): Promise<number> {
    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/provisioning/${encodeURIComponent(entry.relPath)}`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`)
    }
    const finalPath = join(provisioningDir, entry.relPath)
    await mkdir(dirname(finalPath), { recursive: true })
    return atomicWrite(res.body, finalPath)
  }

  // Errors propagate so a failed reset reports as failed-section instead of emitting a half-fresh half-stale tree.
  private async resetStagingDir(root: string): Promise<void> {
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
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
