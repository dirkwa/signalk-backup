import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignalKDatabaseExporter } from '../src/database-export/signalk-database.js'

type FetchInput = Parameters<typeof fetch>[0]

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function decodeUntilStable(url: string): string {
  let prev = url
  for (let i = 0; i < 5; i++) {
    let next: string
    try {
      next = decodeURIComponent(prev)
    } catch {
      return prev
    }
    if (next === prev) return next
    prev = next
  }
  return prev
}

function streamFrom(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf))
      controller.close()
    }
  })
}

interface DbFixture {
  id: string
  bytes: number
  modifiedAt: string
  content: Buffer
}

function makeMockFetch(opts: {
  dbs?: DbFixture[]
  manifestStatus?: number
  failStreamFor?: string
}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const dbs = opts.dbs ?? []

  const handler = (input: FetchInput): Response => {
    const url = urlOf(input)
    calls.push(url)

    if (url.endsWith('/full-export/databases')) {
      if (opts.manifestStatus && opts.manifestStatus !== 200) {
        return new Response('boom', { status: opts.manifestStatus })
      }
      const databases = dbs.map(({ id, bytes, modifiedAt }) => ({ id, bytes, modifiedAt }))
      return new Response(JSON.stringify({ databases }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    const m = url.match(/\/full-export\/([^?#/]+)$/)
    if (m) {
      const id = decodeUntilStable(m[1])
      if (opts.failStreamFor === id) {
        return new Response('boom', { status: 500 })
      }
      const fix = dbs.find((d) => d.id === id)
      if (!fix) {
        return new Response('not found', { status: 404 })
      }
      return new Response(streamFrom(fix.content), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })
    }

    return new Response('unexpected url', { status: 404 })
  }

  // Fetch impl returns Promise wrapping the synchronous handler.
  const fetchImpl: typeof fetch = (input) => Promise.resolve(handler(input))
  return { fetchImpl, calls }
}

describe('SignalKDatabaseExporter', () => {
  let stagingDir: string

  beforeEach(async () => {
    stagingDir = await mkdtemp(join(tmpdir(), 'sk-database-export-'))
  })

  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true })
  })

  it('detect() returns true on a 200 manifest with array body', async () => {
    const { fetchImpl } = makeMockFetch({ dbs: [] })
    const exporter = new SignalKDatabaseExporter({ fetch: fetchImpl })
    expect(await exporter.detect()).toBe(true)
  })

  it('detect() returns false on non-200 manifest', async () => {
    const { fetchImpl } = makeMockFetch({ manifestStatus: 500 })
    const exporter = new SignalKDatabaseExporter({ fetch: fetchImpl })
    expect(await exporter.detect()).toBe(false)
  })

  it('exportAll() writes one db.sqlite per consumer plugin', async () => {
    const dbs: DbFixture[] = [
      {
        id: 'alpha',
        bytes: 12,
        modifiedAt: '2026-01-01T00:00:00Z',
        content: Buffer.from('SQLite-mock-A')
      },
      {
        id: 'beta',
        bytes: 12,
        modifiedAt: '2026-01-01T00:00:00Z',
        content: Buffer.from('SQLite-mock-B')
      }
    ]
    const { fetchImpl, calls } = makeMockFetch({ dbs })
    const exporter = new SignalKDatabaseExporter({ fetch: fetchImpl })
    const result = await exporter.exportAll(stagingDir)

    expect(result.pluginId).toBe('signalk-database')
    expect(result.tables.map((t) => t.table).sort()).toEqual(['alpha', 'beta'])
    expect(result.totalBytes).toBe(
      Buffer.from('SQLite-mock-A').length + Buffer.from('SQLite-mock-B').length
    )

    // Files actually exist on disk
    const alphaPath = join(stagingDir, 'alpha', 'db.sqlite')
    const betaPath = join(stagingDir, 'beta', 'db.sqlite')
    expect(existsSync(alphaPath)).toBe(true)
    expect(existsSync(betaPath)).toBe(true)
    expect((await readFile(alphaPath)).toString()).toBe('SQLite-mock-A')
    expect((await readFile(betaPath)).toString()).toBe('SQLite-mock-B')

    // Exactly the URLs we expect were called (manifest + one per id)
    expect(calls.filter((u) => u.endsWith('/full-export/databases'))).toHaveLength(1)
    expect(calls.some((u) => u.endsWith('/full-export/alpha'))).toBe(true)
    expect(calls.some((u) => u.endsWith('/full-export/beta'))).toBe(true)
  })

  it('exportAll() skips ids that fail validation', async () => {
    // The exporter rejects suspicious ids client-side before any fetch,
    // even though the source plugin would 400 them too.
    const dbs: DbFixture[] = [
      {
        id: '../escape',
        bytes: 1,
        modifiedAt: '2026-01-01T00:00:00Z',
        content: Buffer.from('x')
      },
      {
        id: 'good',
        bytes: 1,
        modifiedAt: '2026-01-01T00:00:00Z',
        content: Buffer.from('y')
      }
    ]
    const { fetchImpl, calls } = makeMockFetch({ dbs })
    const exporter = new SignalKDatabaseExporter({ fetch: fetchImpl })
    const result = await exporter.exportAll(stagingDir)

    expect(result.tables.map((t) => t.table)).toEqual(['good'])
    // No fetch should have been issued for the bad id
    expect(calls.some((u) => u.includes('escape'))).toBe(false)
  })

  it('exportAll() resets the staging dir so removed DBs do not linger', async () => {
    // First cycle: alpha + beta
    let dbs: DbFixture[] = [
      {
        id: 'alpha',
        bytes: 1,
        modifiedAt: '2026-01-01T00:00:00Z',
        content: Buffer.from('A')
      },
      {
        id: 'beta',
        bytes: 1,
        modifiedAt: '2026-01-01T00:00:00Z',
        content: Buffer.from('B')
      }
    ]
    let exporter = new SignalKDatabaseExporter({ fetch: makeMockFetch({ dbs }).fetchImpl })
    await exporter.exportAll(stagingDir)
    expect(existsSync(join(stagingDir, 'beta', 'db.sqlite'))).toBe(true)

    // Second cycle: only alpha (beta uninstalled)
    dbs = [
      {
        id: 'alpha',
        bytes: 1,
        modifiedAt: '2026-01-02T00:00:00Z',
        content: Buffer.from('A2')
      }
    ]
    exporter = new SignalKDatabaseExporter({ fetch: makeMockFetch({ dbs }).fetchImpl })
    await exporter.exportAll(stagingDir)
    expect(existsSync(join(stagingDir, 'alpha', 'db.sqlite'))).toBe(true)
    expect(existsSync(join(stagingDir, 'beta'))).toBe(false)
  })

  it('exportAll() continues past one failing stream', async () => {
    const dbs: DbFixture[] = [
      {
        id: 'broken',
        bytes: 1,
        modifiedAt: '2026-01-01T00:00:00Z',
        content: Buffer.from('x')
      },
      {
        id: 'good',
        bytes: 1,
        modifiedAt: '2026-01-01T00:00:00Z',
        content: Buffer.from('y')
      }
    ]
    const { fetchImpl } = makeMockFetch({ dbs, failStreamFor: 'broken' })
    const exporter = new SignalKDatabaseExporter({ fetch: fetchImpl })
    const result = await exporter.exportAll(stagingDir)

    // good still got through; broken does not appear in the result.
    // The broken/ dir may or may not exist depending on where the
    // fetch failed relative to mkdir; we only assert no db.sqlite was
    // written for it.
    expect(result.tables.map((t) => t.table)).toEqual(['good'])
    expect(existsSync(join(stagingDir, 'good', 'db.sqlite'))).toBe(true)
    expect(existsSync(join(stagingDir, 'broken', 'db.sqlite'))).toBe(false)
  })

  it('exportAll() with empty manifest returns no tables', async () => {
    const { fetchImpl } = makeMockFetch({ dbs: [] })
    const exporter = new SignalKDatabaseExporter({ fetch: fetchImpl })
    const result = await exporter.exportAll(stagingDir)
    expect(result.tables).toEqual([])
    expect(result.totalBytes).toBe(0)
  })

  it('uses the configured signalkBaseUrl', async () => {
    const { fetchImpl, calls } = makeMockFetch({ dbs: [] })
    const exporter = new SignalKDatabaseExporter({
      signalkBaseUrl: 'http://example.test:9999',
      fetch: fetchImpl
    })
    await exporter.detect()
    expect(calls[0]).toMatch(/^http:\/\/example\.test:9999\//)
  })
})
