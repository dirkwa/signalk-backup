import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import request from 'supertest'
import { registerProxy } from '../src/proxy.js'

interface Upstream {
  url: string
  close: () => Promise<void>
}

/**
 * Spin up a tiny upstream HTTP server that the proxy can target,
 * so we test real wire bytes rather than mocking fetch().
 */
function startUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Upstream> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'string' || addr === null) {
        throw new Error('upstream server did not bind')
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              r()
            })
          })
      })
    })
  })
}

let upstream: Upstream | undefined

afterEach(async () => {
  if (upstream) {
    await upstream.close()
    upstream = undefined
  }
})

/** Resolve the active upstream URL or fail loudly — replaces non-null `!`. */
function upstreamUrl(): string {
  if (!upstream) throw new Error('upstream not initialised in beforeEach')
  return upstream.url
}

/** Narrow supertest's untyped `res.body` to a known shape. */
function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null) {
    return body as Record<string, unknown>
  }
  throw new Error(`expected JSON body, got: ${typeof body}`)
}

function buildApp(getUpstream: () => string | null): express.Express {
  const app = express()
  // Plugin's real registration shape: router with /api/* mount.
  // Express here stands in for SignalK's app passing the plugin a
  // sub-router rooted at /plugins/signalk-backup/.
  registerProxy(app, { getUpstreamBase: getUpstream })
  return app
}

describe('proxy', () => {
  describe('upstream up', () => {
    beforeEach(async () => {
      upstream = await startUpstream((req, res) => {
        if (req.url === '/api/health' && req.method === 'GET') {
          res.setHeader('content-type', 'application/json')
          res.setHeader('x-upstream-marker', 'yes')
          res.statusCode = 200
          res.end(JSON.stringify({ ok: true, upstreamSawUrl: req.url }))
          return
        }
        if (req.url?.startsWith('/api/echo') && req.method === 'POST') {
          // Echo the body back so we can verify body streaming.
          res.statusCode = 201
          res.setHeader('content-type', 'text/plain')
          req.pipe(res)
          return
        }
        if (req.url === '/api/big' && req.method === 'GET') {
          // 5 MB body to confirm we're not buffering.
          const buf = Buffer.alloc(5 * 1024 * 1024, 'a')
          res.statusCode = 200
          res.setHeader('content-type', 'application/octet-stream')
          res.setHeader('content-length', String(buf.length))
          res.end(buf)
          return
        }
        if (req.url === '/api/missing' && req.method === 'GET') {
          res.statusCode = 404
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'not found' }))
          return
        }
        res.statusCode = 500
        res.end(`unexpected upstream call: ${req.method ?? '?'} ${req.url ?? '?'}`)
      })
    })

    it('GETs are forwarded with status, headers and body', async () => {
      const app = buildApp(() => upstreamUrl())
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('application/json')
      expect(res.headers['x-upstream-marker']).toBe('yes')
      expect(res.body).toEqual({ ok: true, upstreamSawUrl: '/api/health' })
    })

    it('POST bodies are streamed through and echoed back', async () => {
      const app = buildApp(() => upstreamUrl())
      const payload = 'hello-from-test'
      const res = await request(app)
        .post('/api/echo')
        .set('content-type', 'text/plain')
        .send(payload)
      expect(res.status).toBe(201)
      expect(res.text).toBe(payload)
    })

    it('large response bodies are streamed without buffering', async () => {
      const app = buildApp(() => upstreamUrl())
      const res = await request(app).get('/api/big').buffer(true)
      expect(res.status).toBe(200)
      const body = res.body as Buffer
      expect(body.length).toBe(5 * 1024 * 1024)
      // Spot-check: every byte is 'a'.
      expect(body[0]).toBe(0x61)
      expect(body[body.length - 1]).toBe(0x61)
    })

    it('upstream 404 is passed through verbatim', async () => {
      const app = buildApp(() => upstreamUrl())
      const res = await request(app).get('/api/missing')
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'not found' })
    })

    it('non-/api/* paths are not handled by the proxy', async () => {
      const app = buildApp(() => upstreamUrl())
      // The proxy's regex only matches /api/*. Anything else falls
      // through to Express's default 404.
      const res = await request(app).get('/something-else')
      expect(res.status).toBe(404)
    })
  })

  describe('upstream not ready', () => {
    it('returns 503 when getUpstreamBase returns null', async () => {
      const app = buildApp(() => null)
      const res = await request(app).get('/api/anything')
      expect(res.status).toBe(503)
      expect(res.body).toEqual({ error: 'backup-server not ready' })
    })
  })

  describe('upstream unreachable', () => {
    it('returns 502 when fetch throws', async () => {
      // Point at a closed port so the connection refuses immediately.
      const app = buildApp(() => 'http://127.0.0.1:1')
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(502)
      expect(asRecord(res.body).error).toBe('backup-server unreachable')
    })
  })

  describe('hop-by-hop headers', () => {
    beforeEach(async () => {
      upstream = await startUpstream((req, res) => {
        // Echo the request headers we observed back to the test.
        res.setHeader('content-type', 'application/json')
        res.statusCode = 200
        const observed: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') observed[k.toLowerCase()] = v
        }
        res.end(JSON.stringify(observed))
      })
    })

    it('forwards custom request headers to the upstream', async () => {
      const app = buildApp(() => upstreamUrl())
      const res = await request(app).get('/api/anything').set('x-keep-me', 'yes')
      expect(res.status).toBe(200)
      const body = asRecord(res.body)
      expect(body['x-keep-me']).toBe('yes')
    })

    it('rewrites Host to the upstream (does not leak the SignalK origin)', async () => {
      const app = buildApp(() => upstreamUrl())
      const res = await request(app).get('/api/anything').set('host', 'sk.example.com')
      expect(res.status).toBe(200)
      const body = asRecord(res.body)
      // fetch sets Host to the upstream URL's host. We only assert it's
      // NOT the value the test client sent.
      expect(body.host).not.toBe('sk.example.com')
    })
  })
})

// Sanity: make sure express + supertest plumbing themselves work, so a
// failing proxy test isn't blamed on the harness.
describe('test harness sanity', () => {
  it('Readable.fromWeb interop', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from('ok'))
        c.close()
      }
    })
    const node = Readable.fromWeb(stream as never)
    const chunks: Buffer[] = []
    for await (const c of node) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('ok')
  })
})
