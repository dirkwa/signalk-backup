import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { QuestDBExporter } from '../src/database-export/questdb.js'
import {
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  type Manifest
} from '../src/database-export/manifest.js'

type FetchInput = Parameters<typeof fetch>[0]

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/**
 * Mock fetch responding to:
 *   GET /plugins/signalk-questdb/api/full-export/tables → { tables: [...] }
 *   GET /plugins/signalk-questdb/api/full-export/<table>?from=&to= → fixed bytes
 *
 * Per-shard body is `parquetBytes` bytes of the letter 'p'. We're testing
 * byte plumbing + directory structure, not parquet validity.
 *
 * `calls` accumulates every request URL the test can inspect.
 */
function makeMockFetch(
  tables: string[],
  parquetBytes = 64
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const handler = (input: FetchInput): Response => {
    const url = urlOf(input)
    calls.push(url)
    if (url.endsWith('/full-export/tables')) {
      return new Response(JSON.stringify({ tables }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const m = url.match(/\/full-export\/([^/?]+)/)
    if (m && tables.includes(m[1])) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.alloc(parquetBytes, 'p'))
          controller.close()
        }
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/vnd.apache.parquet' }
      })
    }
    return new Response('not found', { status: 404 })
  }
  return {
    fetchImpl: (input: FetchInput) => Promise.resolve(handler(input)),
    calls
  }
}

/** Fixed "now" used across tests so we get deterministic ISO weeks. */
const FIXED_NOW = new Date('2026-05-13T12:00:00Z') // ISO 2026-W20 (Wed)

describe('QuestDBExporter', () => {
  let configRoot: string
  let stagingDir: string

  beforeEach(async () => {
    configRoot = await mkdtemp(join(tmpdir(), 'sk-cfg-'))
    stagingDir = join(configRoot, 'plugin-config-data', 'signalk-backup', 'database-exports')
    await mkdir(stagingDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(configRoot, { recursive: true, force: true })
  })

  describe('detect()', () => {
    it('returns true when tables route returns at least one entry', async () => {
      const { fetchImpl } = makeMockFetch(['signalk'])
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl
      })
      expect(await exporter.detect()).toBe(true)
    })

    it('returns false when fetch fails', async () => {
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: (() => Promise.reject(new Error('connection refused'))) as unknown as typeof fetch
      })
      expect(await exporter.detect()).toBe(false)
    })

    it('returns false when tables array is empty', async () => {
      const { fetchImpl } = makeMockFetch([])
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl
      })
      expect(await exporter.detect()).toBe(false)
    })
  })

  describe('exportAll() (first cycle, no manifest)', () => {
    it('creates one subdir per table with shards for the rolling churn window', async () => {
      const { fetchImpl, calls } = makeMockFetch(['signalk', 'signalk_str', 'signalk_position'])
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl,
        now: () => FIXED_NOW
      })
      const result = await exporter.exportAll(stagingDir)
      expect(result.pluginId).toBe('signalk-questdb')
      expect(result.tables.map((t) => t.table).sort()).toEqual([
        'signalk',
        'signalk_position',
        'signalk_str'
      ])

      // Each table got its own subdir.
      const topLevel = await readdir(stagingDir)
      expect(topLevel.sort()).toEqual(['signalk', 'signalk_position', 'signalk_str'])

      // Each subdir has ROLLING_CHURN_WEEKS + 1 (=5) shards plus a MANIFEST.
      for (const t of ['signalk', 'signalk_position', 'signalk_str']) {
        const files = (await readdir(join(stagingDir, t))).sort()
        expect(files).toContain(MANIFEST_FILENAME)
        const shards = files.filter((f) => f.endsWith('.parquet'))
        expect(shards).toHaveLength(5)
        // The current week (2026-W20) should be the open shard.
        expect(shards).toContain(`${t}_2026-W20.parquet`)
        // Earliest in rolling window is current-week minus 4 → W16.
        expect(shards).toContain(`${t}_2026-W16.parquet`)
      }

      // Each shard call carried from= and to= params.
      const exportCalls = calls.filter((c) => c.includes('/full-export/signalk?'))
      expect(exportCalls).toHaveLength(5)
      for (const c of exportCalls) {
        expect(c).toMatch(/[?&]from=/)
        expect(c).toMatch(/[?&]to=/)
      }
    })

    it('writes a MANIFEST.json with the expected shape', async () => {
      const { fetchImpl } = makeMockFetch(['signalk'])
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl,
        now: () => FIXED_NOW
      })
      await exporter.exportAll(stagingDir)
      const raw = await readFile(join(stagingDir, 'signalk', MANIFEST_FILENAME), 'utf-8')
      const m = JSON.parse(raw) as Manifest
      expect(m.tableName).toBe('signalk')
      expect(m.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION)
      expect(m.openShard).toBe('signalk_2026-W20.parquet')
      expect(m.shards).toHaveLength(5)
      expect(m.lastExportRun).toBe(FIXED_NOW.toISOString())
    })

    it('records per-table accounting in the result', async () => {
      const { fetchImpl } = makeMockFetch(['signalk'])
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl,
        now: () => FIXED_NOW
      })
      const result = await exporter.exportAll(stagingDir)
      const t = result.tables[0]
      expect(t.shardsWritten).toBe(5)
      expect(t.shardsSkipped).toBe(0)
      expect(t.bytes).toBe(5 * 64)
      expect(t.tableDir).toBe(join(stagingDir, 'signalk'))
    })
  })

  describe('exportAll() (second cycle, manifest exists)', () => {
    it('skips closed shards outside the churn window', async () => {
      const tableDir = join(stagingDir, 'signalk')
      await mkdir(tableDir, { recursive: true })
      // Seed a closed shard from a week WELL outside the churn window
      // (5+ weeks ago = W15 or older from now=W20).
      await writeFile(join(tableDir, 'signalk_2026-W10.parquet'), Buffer.alloc(99, 'x'))
      const oldShardSize = (await stat(join(tableDir, 'signalk_2026-W10.parquet'))).size
      const manifest: Manifest = {
        tableName: 'signalk',
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        shards: [
          {
            file: 'signalk_2026-W10.parquet',
            weekStart: '2026-03-02T00:00:00.000Z',
            bytes: oldShardSize,
            exportedAt: '2026-03-09T12:00:00.000Z'
          }
        ],
        lastExportRun: '2026-03-09T12:00:00.000Z'
      }
      await writeFile(join(tableDir, MANIFEST_FILENAME), JSON.stringify(manifest), 'utf-8')

      const { fetchImpl, calls } = makeMockFetch(['signalk'])
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl,
        now: () => FIXED_NOW
      })
      const result = await exporter.exportAll(stagingDir)

      // W10 is way outside the churn window — never re-exported.
      // Match by the from= ISO timestamp; URLs carry timestamps, not week labels.
      const w10Start = '2026-03-02T00:00:00.000Z'
      const w10Calls = calls.filter((c) => new URL(c).searchParams.get('from') === w10Start)
      expect(w10Calls).toEqual([])
      // The old file is untouched on disk.
      const same = (await stat(join(tableDir, 'signalk_2026-W10.parquet'))).size
      expect(same).toBe(oldShardSize)

      const t = result.tables[0]
      // W10 is the seeded closed-but-known shard → skipped.
      // W11..W20 (10 weeks) are written: W11..W15 because not on disk,
      // W16..W20 because they're in the rolling churn window.
      expect(t.shardsSkipped).toBe(1)
      expect(t.shardsWritten).toBe(10)
    })

    it('produces a stable byte count on no-op re-runs (kopia dedup proof)', async () => {
      const { fetchImpl } = makeMockFetch(['signalk'])
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl,
        now: () => FIXED_NOW
      })
      // First cycle: writes all 5 shards in the churn window.
      const r1 = await exporter.exportAll(stagingDir)
      // Read shard file mtimes after first cycle.
      const tableDir = join(stagingDir, 'signalk')
      const filesBefore = await readdir(tableDir)
      const sizesBefore = new Map<string, number>()
      for (const f of filesBefore) {
        if (f.endsWith('.parquet')) {
          sizesBefore.set(f, (await stat(join(tableDir, f))).size)
        }
      }

      // Second cycle, same FIXED_NOW → same churn window → same shards
      // get rewritten with the SAME body. Sizes must be identical.
      const r2 = await exporter.exportAll(stagingDir)
      for (const [f, prev] of sizesBefore) {
        const now = (await stat(join(tableDir, f))).size
        expect(now).toBe(prev)
      }

      // Both cycles wrote 5 shards each — second run repeats the churn window.
      expect(r1.tables[0].shardsWritten).toBe(5)
      expect(r2.tables[0].shardsWritten).toBe(5)
    })
  })

  describe('legacy file migration', () => {
    it('moves a pre-partitioning <table>.parquet aside on first run', async () => {
      // Seed a legacy flat file directly in stagingDir.
      const legacyName = 'signalk.parquet'
      await writeFile(join(stagingDir, legacyName), Buffer.alloc(200, 'L'))

      const { fetchImpl } = makeMockFetch(['signalk'])
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl,
        now: () => FIXED_NOW
      })
      await exporter.exportAll(stagingDir)

      // Original flat file is gone; moved-aside copy exists.
      const top = await readdir(stagingDir)
      expect(top).toContain('signalk.parquet.legacy')
      expect(top).not.toContain('signalk.parquet')
      // New partitioned dir exists.
      expect(top).toContain('signalk')
    })

    it('is idempotent — second run leaves the .legacy file in place', async () => {
      await writeFile(join(stagingDir, 'signalk.parquet'), Buffer.alloc(200, 'L'))
      const { fetchImpl } = makeMockFetch(['signalk'])
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl,
        now: () => FIXED_NOW
      })
      await exporter.exportAll(stagingDir)
      const sizeAfter1 = (await stat(join(stagingDir, 'signalk.parquet.legacy'))).size
      await exporter.exportAll(stagingDir)
      const sizeAfter2 = (await stat(join(stagingDir, 'signalk.parquet.legacy'))).size
      expect(sizeAfter2).toBe(sizeAfter1)
    })
  })

  describe('error handling', () => {
    it('continues past per-table HTTP failures', async () => {
      const baseFetch = makeMockFetch(['good_table', 'bad_table']).fetchImpl
      const fetchImpl: typeof fetch = (input: FetchInput, init?: RequestInit) => {
        const url = urlOf(input)
        if (url.includes('/full-export/bad_table')) {
          return Promise.resolve(new Response('boom', { status: 502 }))
        }
        return baseFetch(input, init)
      }
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl,
        now: () => FIXED_NOW
      })
      const result = await exporter.exportAll(stagingDir)
      expect(result.tables.map((t) => t.table)).toEqual(['good_table'])
      // bad_table should leave no .partial behind in its own dir
      // (catch ENOENT for the case where exportAll never created the dir).
      const badDir = join(stagingDir, 'bad_table')
      const badFiles = await readdir(badDir).catch(() => [] as string[])
      expect(badFiles.filter((f) => f.endsWith('.partial'))).toEqual([])
    })

    it('refuses table names that fail safe-identifier check', async () => {
      const fetchImpl: typeof fetch = (input: FetchInput) => {
        const url = urlOf(input)
        if (url.endsWith('/full-export/tables')) {
          return Promise.resolve(
            new Response(JSON.stringify({ tables: ['ok_one', 'has space', 'ok_two'] }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          )
        }
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(Buffer.alloc(8, 'p'))
                c.close()
              }
            }),
            { status: 200 }
          )
        )
      }
      const exporter = new QuestDBExporter({
        signalkBaseUrl: 'http://test.invalid',
        fetch: fetchImpl,
        now: () => FIXED_NOW
      })
      const result = await exporter.exportAll(stagingDir)
      const exported = result.tables.map((t) => t.table)
      expect(exported).toContain('ok_one')
      expect(exported).toContain('ok_two')
      expect(exported).not.toContain('has space')
    })
  })
})

describe('Readable.fromWeb (sanity)', () => {
  it('round-trips a small body', async () => {
    const web = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from('hi'))
        c.close()
      }
    })
    const node = Readable.fromWeb(web as never)
    const chunks: Buffer[] = []
    for await (const c of node) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('hi')
  })
})
