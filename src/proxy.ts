// Reverse proxy from /plugins/signalk-backup/api/* to the backup-server's
// loopback API. Container is loopback-only so a remote browser can't
// reach it directly; routing through the SignalK origin also avoids CORS.
// Both directions stream via Readable.fromWeb + stream/promises::pipeline
// so multi-GB ZIP downloads/uploads don't allocate the body in memory.

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IRouter, Request as ExpressRequest, Response as ExpressResponse } from 'express'

// Hop-by-hop headers per RFC 7230 §6.1 (must NOT cross a proxy hop), plus
// host (gets rewritten to upstream) and content-length (recomputed by
// undici from the streamed body).
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length'
])

// Same list, response side. content-encoding stays — upstream may have
// already gzipped and we pass that through unchanged.
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate'
])

export interface ProxyOptions {
  /**
   * Lazy accessor for the upstream base URL — must include the scheme
   * (e.g. `http://127.0.0.1:3010` or `https://server:3010`). Returns
   * null when the backup-server isn't ready; those requests get a 503.
   */
  getUpstreamBase: () => string | null
  /** Optional debug logger. */
  log?: (msg: string) => void
}

// Catches /api/*; the explicit /api/update/{check,apply} routes must
// register BEFORE this — Express matches in registration order.
export function registerProxy(router: IRouter, opts: ProxyOptions): void {
  router.all(/^\/api\/.*/, async (req: ExpressRequest, res: ExpressResponse) => {
    const base = opts.getUpstreamBase()
    if (!base) {
      res.status(503).json({ error: 'backup-server not ready' })
      return
    }

    // Express's router-mount prefix has already been stripped, so
    // req.url is e.g. `/api/backups?type=manual`.
    const upstreamUrl = base.replace(/\/$/, '') + req.url

    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (HOP_BY_HOP_REQUEST_HEADERS.has(name.toLowerCase())) continue
      if (Array.isArray(value)) {
        for (const v of value) headers.append(name, v)
      } else {
        headers.set(name, value)
      }
    }

    // duplex: 'half' is required by undici when body is a Node Readable;
    // both fields are absent from the DOM RequestInit we'd otherwise import.
    const init: Record<string, unknown> = {
      method: req.method,
      headers
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // SignalK's outer middleware registers express.json() globally, which
      // consumes the request stream on JSON POSTs and stashes the parsed
      // body on req.body. By the time we get here, piping `req` as the
      // fetch body throws "Response body object should not be disturbed or
      // locked". So: if Express already parsed it, re-serialize req.body
      // instead of trying to re-read the consumed stream.
      const parsedBody: unknown = (req as { body?: unknown }).body
      const hasParsedBody =
        parsedBody !== undefined && parsedBody !== null && typeof parsedBody === 'object'
      if (hasParsedBody) {
        init.body = JSON.stringify(parsedBody)
        // Force application/json — the browser may not have sent it.
        headers.set('content-type', 'application/json')
      } else {
        init.body = req
        init.duplex = 'half'
      }
    }

    let upstreamRes: Awaited<ReturnType<typeof fetch>>
    try {
      upstreamRes = await fetch(upstreamUrl, init)
    } catch (err) {
      opts.log?.(`proxy ${req.method} ${req.url} → upstream error: ${errMsg(err)}`)
      res.status(502).json({ error: 'backup-server unreachable', detail: errMsg(err) })
      return
    }

    res.status(upstreamRes.status)
    for (const [name, value] of upstreamRes.headers.entries()) {
      if (HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) continue
      res.setHeader(name, value)
    }

    if (!upstreamRes.body) {
      res.end()
      return
    }

    try {
      await pipeline(Readable.fromWeb(upstreamRes.body as never), res)
    } catch (err) {
      opts.log?.(`proxy ${req.method} ${req.url} → stream error: ${errMsg(err)}`)
      if (!res.writableEnded) {
        res.end()
      }
    }
  })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
