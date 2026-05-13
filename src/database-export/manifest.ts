/**
 * MANIFEST.json read/write for the per-table partitioned export dir.
 *
 * Each table's directory looks like:
 *   <table>/
 *     MANIFEST.json
 *     <table>_2026-W17.parquet      (closed, byte-identical across cycles)
 *     <table>_2026-W18.parquet      (rolling-window, may re-export)
 *     ...
 *     <table>_2026-W22.parquet      (open, re-exports every cycle)
 *
 * The manifest is metadata: it records what shards exist, their week
 * boundaries, and which is the open one. It does NOT change behaviour
 * by itself — the exporter re-derives the desired shard set from the
 * current time and re-exports whatever's missing or in the rolling
 * window.
 */

import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

export const MANIFEST_FILENAME = 'MANIFEST.json'
export const MANIFEST_SCHEMA_VERSION = 1

export interface ShardEntry {
  /** Filename only, no path. e.g. "signalk_2026-W17.parquet" */
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
  /** Filename of the open (currently-filling) shard, if known. */
  openShard?: string
  /** ISO 8601 of the most recent successful export-cycle for this table. */
  lastExportRun: string
}

export async function readManifest(tableDir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(tableDir, MANIFEST_FILENAME), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!isManifest(parsed)) return null
    return parsed
  } catch (err) {
    // ENOENT = first run; anything else = corrupted/unreadable manifest,
    // treat as missing so we re-derive from scratch (idempotent).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

/**
 * Atomic write — manifest is small, but a half-written file would
 * permanently confuse subsequent runs. Temp + rename pattern.
 */
export async function writeManifest(tableDir: string, manifest: Manifest): Promise<void> {
  const finalPath = join(tableDir, MANIFEST_FILENAME)
  const tempPath = `${finalPath}.partial`
  await writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf-8')
  await rename(tempPath, finalPath)
}

function isManifest(v: unknown): v is Manifest {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (typeof r.tableName !== 'string') return false
  if (typeof r.schemaVersion !== 'number') return false
  if (!Array.isArray(r.shards)) return false
  for (const s of r.shards) {
    if (typeof s !== 'object' || s === null) return false
    const sr = s as Record<string, unknown>
    if (typeof sr.file !== 'string') return false
    if (typeof sr.weekStart !== 'string') return false
    if (typeof sr.bytes !== 'number') return false
    if (typeof sr.exportedAt !== 'string') return false
  }
  if (r.openShard !== undefined && typeof r.openShard !== 'string') return false
  if (typeof r.lastExportRun !== 'string') return false
  return true
}
