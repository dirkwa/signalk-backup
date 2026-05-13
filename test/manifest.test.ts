import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readManifest,
  writeManifest,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  type Manifest
} from '../src/database-export/manifest.js'

describe('manifest', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sk-manifest-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const SAMPLE: Manifest = {
    tableName: 'signalk',
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    shards: [
      {
        file: 'signalk_2026-W17.parquet',
        weekStart: '2026-04-27T00:00:00.000Z',
        bytes: 1480231,
        exportedAt: '2026-05-13T13:00:00.000Z'
      }
    ],
    openShard: 'signalk_2026-W19.parquet',
    lastExportRun: '2026-05-13T13:00:00.000Z'
  }

  it('readManifest returns null when file is missing', async () => {
    expect(await readManifest(dir)).toBeNull()
  })

  it('write then read round-trip preserves the manifest exactly', async () => {
    await writeManifest(dir, SAMPLE)
    const got = await readManifest(dir)
    expect(got).toEqual(SAMPLE)
  })

  it('write is atomic — no .partial leftover after success', async () => {
    await writeManifest(dir, SAMPLE)
    const entries = await readdir(dir)
    expect(entries).toContain(MANIFEST_FILENAME)
    expect(entries.filter((e) => e.endsWith('.partial'))).toEqual([])
  })

  it('readManifest returns null for corrupted JSON', async () => {
    await writeFile(join(dir, MANIFEST_FILENAME), '{not json', 'utf-8')
    expect(await readManifest(dir)).toBeNull()
  })

  it('readManifest returns null for structurally invalid manifest', async () => {
    await writeFile(
      join(dir, MANIFEST_FILENAME),
      JSON.stringify({ tableName: 'x' /* missing fields */ }),
      'utf-8'
    )
    expect(await readManifest(dir)).toBeNull()
  })

  it('readManifest returns null when shard entries are malformed', async () => {
    const bad = {
      ...SAMPLE,
      shards: [{ file: 'x.parquet' /* missing weekStart/bytes/exportedAt */ }]
    }
    await writeFile(join(dir, MANIFEST_FILENAME), JSON.stringify(bad), 'utf-8')
    expect(await readManifest(dir)).toBeNull()
  })

  it('writeManifest accepts a manifest without openShard', async () => {
    const noOpen: Manifest = { ...SAMPLE, openShard: undefined }
    delete (noOpen as { openShard?: string }).openShard
    await writeManifest(dir, noOpen)
    const stored = JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf-8')) as unknown
    expect((stored as { openShard?: unknown }).openShard).toBeUndefined()
  })
})
