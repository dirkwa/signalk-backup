import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { QuestDBExporter } from '../src/database-export/questdb.js'

// Derive fetch's input type from the global. The DOM lib's `RequestInfo`
// is a string|Request alias, but we don't pull DOM into tsconfig (server-
// side plugin), so we use `Parameters<typeof fetch>[0]` to stay portable.
type FetchInput = Parameters<typeof fetch>[0]

/** Narrow fetch's input arg to its URL string for routing. */
function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  // Request — has a `.url` getter.
  return input.url
}

/**
 * Build a mock fetch that responds to:
 *   GET /plugins/signalk-questdb/api/full-export/tables
 *   GET /plugins/signalk-questdb/api/full-export/<table>
 * The body for the per-table route is a fixed buffer (not real Parquet —
 * we only verify byte plumbing here, not Parquet validity).
 */
function makeMockFetch(tables: string[], parquetBytes = 64): typeof fetch {
  const handler = (input: FetchInput): Response => {
    const url = urlOf(input)
    if (url.endsWith('/full-export/tables')) {
      return new Response(JSON.stringify({ tables }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const m = url.match(/\/full-export\/([^/?]+)$/)
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
  return (input: FetchInput) => Promise.resolve(handler(input))
}

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

  it('detect() returns true when tables route returns at least one entry', async () => {
    const exporter = new QuestDBExporter({
      signalkBaseUrl: 'http://test.invalid',
      fetch: makeMockFetch(['signalk'])
    })
    expect(await exporter.detect()).toBe(true)
  })

  it('detect() returns false when fetch fails', async () => {
    const exporter = new QuestDBExporter({
      signalkBaseUrl: 'http://test.invalid',
      fetch: (() => Promise.reject(new Error('connection refused'))) as unknown as typeof fetch
    })
    expect(await exporter.detect()).toBe(false)
  })

  it('detect() returns false when tables array is empty', async () => {
    const exporter = new QuestDBExporter({
      signalkBaseUrl: 'http://test.invalid',
      fetch: makeMockFetch([])
    })
    expect(await exporter.detect()).toBe(false)
  })

  it('exportAll() writes one parquet per table', async () => {
    const exporter = new QuestDBExporter({
      signalkBaseUrl: 'http://test.invalid',
      fetch: makeMockFetch(['signalk', 'signalk_str', 'signalk_position'])
    })
    const result = await exporter.exportAll(stagingDir)
    expect(result.pluginId).toBe('signalk-questdb')
    expect(result.tables.map((t) => t.table).sort()).toEqual([
      'signalk',
      'signalk_position',
      'signalk_str'
    ])

    const files = await readdir(stagingDir)
    expect(files.sort()).toEqual([
      'signalk.parquet',
      'signalk_position.parquet',
      'signalk_str.parquet'
    ])

    for (const t of result.tables) {
      const s = await stat(t.parquetPath)
      expect(s.size).toBe(64)
      expect(t.bytes).toBe(64)
    }

    // No leftover .partial files.
    expect(files.filter((f) => f.endsWith('.partial'))).toEqual([])
  })

  it('exportAll() continues past per-table HTTP failures', async () => {
    const baseFetch = makeMockFetch(['good_table', 'bad_table'])
    const fetchImpl: typeof fetch = (input: FetchInput, init?: RequestInit) => {
      const url = urlOf(input)
      if (url.endsWith('/full-export/bad_table')) {
        return Promise.resolve(new Response('boom', { status: 502 }))
      }
      return baseFetch(input, init)
    }

    const exporter = new QuestDBExporter({
      signalkBaseUrl: 'http://test.invalid',
      fetch: fetchImpl
    })
    const result = await exporter.exportAll(stagingDir)
    expect(result.tables.map((t) => t.table)).toEqual(['good_table'])

    // bad_table should leave no .partial behind.
    const files = await readdir(stagingDir)
    expect(files.sort()).toEqual(['good_table.parquet'])
  })

  it('refuses table names from the tables route that fail safe-identifier check', async () => {
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
      // Honour both the safe names with parquet content.
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.alloc(8, 'p'))
              controller.close()
            }
          }),
          { status: 200 }
        )
      )
    }
    const exporter = new QuestDBExporter({
      signalkBaseUrl: 'http://test.invalid',
      fetch: fetchImpl
    })
    const result = await exporter.exportAll(stagingDir)
    const exported = result.tables.map((t) => t.table)
    expect(exported).toContain('ok_one')
    expect(exported).toContain('ok_two')
    expect(exported).not.toContain('has space')
  })
})

// Tiny smoke check that Readable.fromWeb is importable in this environment.
// (The exporter relies on Node 22's web-streams interop.)
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
