import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrafanaExporter } from '../src/database-export/grafana.js'

type FetchInput = Parameters<typeof fetch>[0]

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

// Builds a fetch mock that answers the four export endpoints
// (dashboards manifest, dashboards file, provisioning manifest,
// provisioning file, db). Each fixture is a small in-memory blob; the
// exporter only cares about bytes + sha256 + the manifest shapes.
function makeMockFetch(opts: {
  dashboards?: Array<{ name: string; sha256: string; bytes: number; content: Buffer }>
  provisioning?: Array<{
    name: string
    relPath: string
    sha256: string
    bytes: number
    content: Buffer
  }>
  dbBytes?: Buffer
  failManifest?: 'dashboards' | 'provisioning' | 'db'
}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const dashboards = opts.dashboards ?? []
  const provisioning = opts.provisioning ?? []
  const dbBytes = opts.dbBytes ?? Buffer.from('SQLite-magic-bytes-here')

  const handler = (input: FetchInput): Response => {
    const url = urlOf(input)
    calls.push(url)

    if (url.endsWith('/full-export/dashboards')) {
      if (opts.failManifest === 'dashboards') {
        return new Response('boom', { status: 500 })
      }
      const manifest = dashboards.map(({ name, sha256, bytes }) => ({ name, sha256, bytes }))
      return new Response(JSON.stringify({ dashboards: manifest }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    if (url.endsWith('/full-export/provisioning')) {
      if (opts.failManifest === 'provisioning') {
        return new Response('boom', { status: 500 })
      }
      const files = provisioning.map(({ name, relPath, sha256, bytes }) => ({
        name,
        relPath,
        sha256,
        bytes
      }))
      return new Response(JSON.stringify({ files }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    if (url.endsWith('/full-export/db')) {
      if (opts.failManifest === 'db') {
        return new Response('boom', { status: 500 })
      }
      return new Response(streamFrom(dbBytes), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })
    }

    const dashMatch = url.match(/\/full-export\/dashboards\/([^/?]+)$/)
    if (dashMatch) {
      const decoded = decodeURIComponent(dashMatch[1])
      const entry = dashboards.find((d) => d.name === decoded)
      if (!entry) return new Response('not found', { status: 404 })
      return new Response(streamFrom(entry.content), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    const provMatch = url.match(/\/full-export\/provisioning\/([^/?]+)$/)
    if (provMatch) {
      const decoded = decodeURIComponent(provMatch[1])
      const entry = provisioning.find((p) => p.relPath === decoded)
      if (!entry) return new Response('not found', { status: 404 })
      return new Response(streamFrom(entry.content), {
        status: 200,
        headers: { 'content-type': 'text/yaml' }
      })
    }

    return new Response('unhandled', { status: 404 })
  }

  return {
    fetchImpl: (input: FetchInput) => Promise.resolve(handler(input)),
    calls
  }
}

function streamFrom(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buf)
      controller.close()
    }
  })
}

describe('GrafanaExporter', () => {
  let configRoot: string
  let stagingDir: string

  beforeEach(async () => {
    configRoot = await mkdtemp(join(tmpdir(), 'sk-grafana-'))
    stagingDir = join(configRoot, 'staging')
  })
  afterEach(async () => {
    await rm(configRoot, { recursive: true, force: true })
  })

  describe('detect', () => {
    it('returns true when the dashboards manifest responds 200', async () => {
      const { fetchImpl } = makeMockFetch({})
      const exporter = new GrafanaExporter({ fetch: fetchImpl })
      expect(await exporter.detect()).toBe(true)
    })

    it('returns false when the dashboards manifest fails', async () => {
      const { fetchImpl } = makeMockFetch({ failManifest: 'dashboards' })
      const exporter = new GrafanaExporter({ fetch: fetchImpl })
      expect(await exporter.detect()).toBe(false)
    })

    it('returns false when the response is malformed', async () => {
      const fetchImpl: typeof fetch = () =>
        Promise.resolve(
          new Response(JSON.stringify({ wrongShape: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        )
      const exporter = new GrafanaExporter({ fetch: fetchImpl })
      expect(await exporter.detect()).toBe(false)
    })
  })

  describe('exportAll', () => {
    it('writes grafana.db plus dashboard JSONs and provisioning YAMLs', async () => {
      const { fetchImpl } = makeMockFetch({
        dbBytes: Buffer.from('FAKE_SQLITE_DB'),
        dashboards: [
          {
            name: 'navigation.json',
            sha256: 'a'.repeat(64),
            bytes: 7,
            content: Buffer.from('{"n":1}')
          },
          {
            name: 'electrical.json',
            sha256: 'b'.repeat(64),
            bytes: 5,
            content: Buffer.from('{"e":2}')
          }
        ],
        provisioning: [
          {
            name: 'questdb.yaml',
            relPath: 'datasources/questdb.yaml',
            sha256: 'c'.repeat(64),
            bytes: 11,
            content: Buffer.from('apiVersion: 1\n')
          }
        ]
      })

      const exporter = new GrafanaExporter({ fetch: fetchImpl })
      const result = await exporter.exportAll(stagingDir)

      expect(result.pluginId).toBe('signalk-grafana')
      const tables = Object.fromEntries(result.tables.map((t) => [t.table, t]))
      expect(tables['grafana.db']).toBeDefined()
      expect(tables['grafana.db'].bytes).toBeGreaterThan(0)
      expect(tables['dashboards'].shardsWritten).toBe(2)
      expect(tables['provisioning'].shardsWritten).toBe(1)

      const dbContent = await readFile(join(stagingDir, 'grafana.db'))
      expect(dbContent.toString('utf-8')).toBe('FAKE_SQLITE_DB')

      const navContent = await readFile(join(stagingDir, 'dashboards', 'navigation.json'))
      expect(navContent.toString('utf-8')).toBe('{"n":1}')

      const yamlContent = await readFile(
        join(stagingDir, 'provisioning', 'datasources', 'questdb.yaml')
      )
      expect(yamlContent.toString('utf-8')).toBe('apiVersion: 1\n')
    })

    it('does NOT leave .partial files in the staging dir after a clean export', async () => {
      const { fetchImpl } = makeMockFetch({
        dashboards: [
          {
            name: 'a.json',
            sha256: 'a'.repeat(64),
            bytes: 4,
            content: Buffer.from('{"x":1}')
          }
        ]
      })
      const exporter = new GrafanaExporter({ fetch: fetchImpl })
      await exporter.exportAll(stagingDir)

      const dashboardEntries = await readdir(join(stagingDir, 'dashboards'))
      for (const name of dashboardEntries) {
        expect(name.endsWith('.partial')).toBe(false)
      }
      const top = await readdir(stagingDir)
      for (const name of top) {
        expect(name.endsWith('.partial')).toBe(false)
      }
    })

    it('wipes stale files from the previous cycle (deleted dashboards do not linger)', async () => {
      const cycle1 = makeMockFetch({
        dashboards: [
          {
            name: 'keep.json',
            sha256: 'a'.repeat(64),
            bytes: 2,
            content: Buffer.from('{}')
          },
          {
            name: 'delete-me.json',
            sha256: 'b'.repeat(64),
            bytes: 2,
            content: Buffer.from('{}')
          }
        ]
      })
      await new GrafanaExporter({ fetch: cycle1.fetchImpl }).exportAll(stagingDir)
      expect(await readdir(join(stagingDir, 'dashboards'))).toEqual(
        expect.arrayContaining(['keep.json', 'delete-me.json'])
      )

      // Cycle 2: "delete-me.json" gone from manifest; the staging tree must follow or kopia keeps it forever.
      const cycle2 = makeMockFetch({
        dashboards: [
          {
            name: 'keep.json',
            sha256: 'a'.repeat(64),
            bytes: 2,
            content: Buffer.from('{}')
          }
        ]
      })
      await new GrafanaExporter({ fetch: cycle2.fetchImpl }).exportAll(stagingDir)

      const after = await readdir(join(stagingDir, 'dashboards'))
      expect(after).toEqual(['keep.json'])
    })

    it('rejects malformed dashboard entries instead of crashing', async () => {
      // Server returns an entry without sha256; exporter should skip
      // it but still complete the run.
      const fetchImpl: typeof fetch = (input: FetchInput) => {
        const url = urlOf(input)
        if (url.endsWith('/full-export/dashboards')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                dashboards: [
                  { name: 'good.json', sha256: 'a'.repeat(64), bytes: 2 },
                  { name: 'no-sha.json', bytes: 2 } // missing sha256
                ]
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        }
        if (url.endsWith('/full-export/dashboards/good.json')) {
          return Promise.resolve(new Response(streamFrom(Buffer.from('{}')), { status: 200 }))
        }
        if (url.endsWith('/full-export/provisioning')) {
          return Promise.resolve(new Response(JSON.stringify({ files: [] }), { status: 200 }))
        }
        if (url.endsWith('/full-export/db')) {
          return Promise.resolve(new Response(streamFrom(Buffer.from('db')), { status: 200 }))
        }
        return Promise.resolve(new Response('not found', { status: 404 }))
      }

      const exporter = new GrafanaExporter({ fetch: fetchImpl })
      const result = await exporter.exportAll(stagingDir)
      const dashboardsTable = result.tables.find((t) => t.table === 'dashboards')
      expect(dashboardsTable?.shardsWritten).toBe(1)
      const present = await readdir(join(stagingDir, 'dashboards'))
      expect(present).toContain('good.json')
      expect(present).not.toContain('no-sha.json')
    })

    it('rejects provisioning entries with traversal segments', async () => {
      const fetchImpl: typeof fetch = (input: FetchInput) => {
        const url = urlOf(input)
        if (url.endsWith('/full-export/dashboards')) {
          return Promise.resolve(new Response(JSON.stringify({ dashboards: [] }), { status: 200 }))
        }
        if (url.endsWith('/full-export/provisioning')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                files: [
                  {
                    name: 'evil.yaml',
                    relPath: '../etc/passwd',
                    sha256: 'a'.repeat(64),
                    bytes: 1
                  },
                  {
                    name: 'questdb.yaml',
                    relPath: 'datasources/questdb.yaml',
                    sha256: 'b'.repeat(64),
                    bytes: 1
                  }
                ]
              }),
              { status: 200 }
            )
          )
        }
        // The exporter URL-encodes `/` in provisioning relPaths, so the
        // request lands here with `%2F` rather than a literal slash.
        if (
          url.includes('/full-export/provisioning/datasources%2Fquestdb.yaml') ||
          url.includes('/full-export/provisioning/datasources/questdb.yaml')
        ) {
          return Promise.resolve(new Response(streamFrom(Buffer.from('y')), { status: 200 }))
        }
        if (url.endsWith('/full-export/db')) {
          return Promise.resolve(new Response(streamFrom(Buffer.from('db')), { status: 200 }))
        }
        return Promise.resolve(new Response('not found', { status: 404 }))
      }

      const exporter = new GrafanaExporter({ fetch: fetchImpl })
      const result = await exporter.exportAll(stagingDir)
      const provTable = result.tables.find((t) => t.table === 'provisioning')
      expect(provTable?.shardsWritten).toBe(1)
      // Confirm no traversal happened — there should be no /etc/passwd
      // anywhere outside the staging tree, and the only provisioning
      // file should be the legitimate one.
      const provRoot = join(stagingDir, 'provisioning')
      const dsDir = join(provRoot, 'datasources')
      const inside = await readdir(dsDir)
      expect(inside).toEqual(['questdb.yaml'])
    })

    it('handles a failed DB export without aborting dashboards/provisioning', async () => {
      const { fetchImpl } = makeMockFetch({
        failManifest: 'db',
        dashboards: [
          {
            name: 'a.json',
            sha256: 'a'.repeat(64),
            bytes: 2,
            content: Buffer.from('{}')
          }
        ]
      })
      const exporter = new GrafanaExporter({ fetch: fetchImpl })
      const result = await exporter.exportAll(stagingDir)

      // db not in the results because exportDb threw; dashboards still
      // ran. The exporter logs the db failure but reports a partial
      // ExportResult, matching the orchestrator's "partial coverage is
      // better than none" stance.
      const tables = result.tables.map((t) => t.table)
      expect(tables).not.toContain('grafana.db')
      expect(tables).toContain('dashboards')
    })
  })
})
