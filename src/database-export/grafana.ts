// Grafana exporter — pulls a consistent SQLite checkpoint plus dashboard
// JSONs and provisioning YAMLs via signalk-grafana's /api/full-export
// routes. Mirrors the QuestDB pattern (HTTP over loopback, atomic
// temp-file-then-rename writes) so kopia picks up the staged files
// on the next snapshot. signalk-grafana >= the version that adds
// `/api/full-export/{db,dashboards,provisioning}` is required.

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
    // The dashboards manifest endpoint is the cheapest probe: GET, no
    // container exec, always 200 on a running signalk-grafana even when
    // /var/lib/grafana is empty (returns `{ dashboards: [] }`).
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

    // SQLite DB — a single file with no internal structure we expose.
    // Use the existing TableExport shape (one "table" with one "shard")
    // so the orchestrator's totals line up with QuestDB-style reports.
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

    // Dashboards — flat JSON files. Stage each under
    // `<stagingDir>/dashboards/<name>`.
    try {
      const bytes = await this.exportDashboards(stagingDir)
      exports.push({
        table: 'dashboards',
        tableDir: join(stagingDir, 'dashboards'),
        shardsWritten: bytes.count,
        shardsSkipped: 0,
        bytes: bytes.totalBytes
      })
      totalBytes += bytes.totalBytes
    } catch (err) {
      this.log(`dashboards export failed: ${errMsg(err)}`)
    }

    // Provisioning — nested YAML tree under `provisioning/`.
    try {
      const bytes = await this.exportProvisioning(stagingDir)
      exports.push({
        table: 'provisioning',
        tableDir: join(stagingDir, 'provisioning'),
        shardsWritten: bytes.count,
        shardsSkipped: 0,
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
    const partialPath = `${finalPath}.partial`
    if (existsSync(partialPath)) await unlink(partialPath).catch(() => undefined)

    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/db`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      throw new Error(`db HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    if (!res.body) {
      throw new Error('db response body is empty')
    }
    const bytes = await streamToFile(res.body, partialPath)
    await rename(partialPath, finalPath)
    this.log(`wrote grafana.db (${bytes} bytes)`)
    return bytes
  }

  private async exportDashboards(stagingDir: string): Promise<{
    count: number
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
    // Reset the staging dir before each export. Dashboards can be
    // renamed or deleted in Grafana between cycles, and re-fetching
    // doesn't remove the old files — without this, kopia would keep
    // snapshotting orphaned JSON forever.
    await this.resetStagingDir(dashboardsDir)

    let totalBytes = 0
    let count = 0
    for (const raw of body.dashboards) {
      const entry = this.parseDashboardEntry(raw)
      if (!entry) continue
      try {
        totalBytes += await this.fetchDashboardFile(entry, dashboardsDir)
        count++
      } catch (err) {
        this.log(`dashboard ${entry.name} failed: ${errMsg(err)}`)
      }
    }
    return { count, totalBytes }
  }

  private parseDashboardEntry(raw: unknown): DashboardEntry | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (typeof o.name !== 'string' || !SAFE_FILENAME.test(o.name)) return null
    if (typeof o.sha256 !== 'string' || typeof o.bytes !== 'number') return null
    return { name: o.name, sha256: o.sha256, bytes: o.bytes }
  }

  private async fetchDashboardFile(entry: DashboardEntry, dashboardsDir: string): Promise<number> {
    const url = `${this.baseUrl}/plugins/${this.pluginId}/api/full-export/dashboards/${encodeURIComponent(entry.name)}`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`)
    }
    const finalPath = join(dashboardsDir, entry.name)
    const partialPath = `${finalPath}.partial`
    const bytes = await streamToFile(res.body, partialPath)
    await rename(partialPath, finalPath)
    return bytes
  }

  private async exportProvisioning(stagingDir: string): Promise<{
    count: number
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
    // Reset for the same reason as dashboards: stale YAMLs from a
    // previous Grafana provisioning state would otherwise persist.
    await this.resetStagingDir(provisioningDir)

    let totalBytes = 0
    let count = 0
    for (const raw of body.files) {
      const entry = this.parseProvisioningEntry(raw)
      if (!entry) continue
      try {
        totalBytes += await this.fetchProvisioningFile(entry, provisioningDir)
        count++
      } catch (err) {
        this.log(`provisioning ${entry.relPath} failed: ${errMsg(err)}`)
      }
    }
    return { count, totalBytes }
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
    const partialPath = `${finalPath}.partial`
    const bytes = await streamToFile(res.body, partialPath)
    await rename(partialPath, finalPath)
    return bytes
  }

  // Wipe and recreate a per-section staging dir so the next export's
  // file set fully replaces the previous one. Without this, files
  // that disappeared between cycles (deleted dashboards, removed
  // datasource YAMLs) would linger in the staging tree and travel
  // forward in every kopia snapshot indefinitely.
  private async resetStagingDir(root: string): Promise<void> {
    try {
      await rm(root, { recursive: true, force: true })
      await mkdir(root, { recursive: true })
    } catch {
      // Best-effort; fall back to whatever directory state already
      // exists. Per-file rename-into-place will still produce a
      // consistent result for the files we do fetch this cycle.
    }
  }
}

// Stream a fetch body into a file. Pulled out as a helper because the
// `Readable.fromWeb` adapter dance + pipeline pattern repeats across
// every fetch we do.
async function streamToFile(body: ReadableStream<Uint8Array>, path: string): Promise<number> {
  const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
  const sink = createWriteStream(path)
  let bytes = 0
  nodeStream.on('data', (chunk: Buffer) => {
    bytes += chunk.length
  })
  await pipeline(nodeStream, sink)
  return bytes
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
