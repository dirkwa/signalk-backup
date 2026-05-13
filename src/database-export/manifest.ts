// MANIFEST.json read/write for the per-table partitioned export dir.

import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

export const MANIFEST_FILENAME = 'MANIFEST.json'
export const MANIFEST_SCHEMA_VERSION = 1

export interface ShardEntry {
  file: string
  /** ISO 8601 UTC midnight Monday — start of this shard's ISO week. */
  weekStart: string
  bytes: number
  exportedAt: string
}

export interface Manifest {
  tableName: string
  schemaVersion: number
  shards: ShardEntry[]
  openShard?: string
  lastExportRun: string
}

export async function readManifest(tableDir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(tableDir, MANIFEST_FILENAME), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!isManifest(parsed)) return null
    return parsed
  } catch {
    // ENOENT (first run) or any read/parse error — treat as missing so the
    // exporter rebuilds from scratch idempotently.
    return null
  }
}

// Temp + rename so a half-written manifest can never confuse subsequent runs.
export async function writeManifest(tableDir: string, manifest: Manifest): Promise<void> {
  const finalPath = join(tableDir, MANIFEST_FILENAME)
  const tempPath = `${finalPath}.partial`
  await writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf-8')
  await rename(tempPath, finalPath)
}

function isValidIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v))
}

function isManifest(v: unknown): v is Manifest {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (typeof r.tableName !== 'string') return false
  // Pin the schema version — accept only what this build wrote. A future
  // build with a bumped version should be treated as 'unreadable manifest'
  // and trigger a clean rebuild.
  if (r.schemaVersion !== MANIFEST_SCHEMA_VERSION) return false
  if (!Array.isArray(r.shards)) return false
  for (const s of r.shards) {
    if (typeof s !== 'object' || s === null) return false
    const sr = s as Record<string, unknown>
    if (typeof sr.file !== 'string' || sr.file.length === 0) return false
    if (!isValidIsoString(sr.weekStart)) return false
    if (typeof sr.bytes !== 'number' || !Number.isFinite(sr.bytes) || sr.bytes < 0) return false
    if (!isValidIsoString(sr.exportedAt)) return false
  }
  if (r.openShard !== undefined && typeof r.openShard !== 'string') return false
  if (!isValidIsoString(r.lastExportRun)) return false
  return true
}
