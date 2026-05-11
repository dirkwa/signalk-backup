/**
 * Reverse proxy from /plugins/signalk-backup/api/* to the backup-server
 * container's loopback API.
 *
 * Why a proxy instead of direct browser → container calls:
 *   - The container binds 127.0.0.1 only; a remote browser can't reach it.
 *   - Single origin (the SignalK server) means no CORS preflights.
 *   - The plugin can intercept/transform later if needed.
 *
 * Streaming both ways: backup downloads are multi-GB ZIPs. We don't
 * `await res.text()` or buffer; we wire the upstream Body to res via
 * Web→Node stream interop.
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IRouter, Request as ExpressRequest, Response as ExpressResponse } from 'express'

/**
 * Headers that must NOT be forwarded between hops, per RFC 7230 §6.1
 * plus practical extras (host gets rewritten, content-length is computed
 * by undici/fetch from the body stream).
 */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-length'
])

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  // content-encoding stays — upstream may have already gzipped; we pass through
  'proxy-authenticate'
])

export interface ProxyOptions {
  /**
   * Lazy accessor for the upstream base URL (e.g. `http://127.0.0.1:3010`).
   * Returns null when the backup-server isn't reachable yet — those
   * requests get a 503.
   */
  getUpstreamBase: () => string | null
  /** Optional debug logger. */
  log?: (msg: string) => void
}

/**
 * Mount the proxy at the supplied router. Catches everything under
 * `/api/*` (the SignalK server passes `/plugins/signalk-backup/*` here,
 * with `/plugins/signalk-backup` already stripped).
 *
 * Existing /api/* routes on the same router (currently /api/update/*)
 * MUST be registered BEFORE this — Express matches in registration
 * order. The proxy uses `*` so it would otherwise swallow them.
 */
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

    // The `init` shape uses globalThis.fetch's RequestInit. Cast lets us
    // attach `body` (a Node Readable stream) and `duplex: 'half'` (undici
    // requires it for streamed bodies) without dragging in DOM-lib types.
    const init: Record<string, unknown> = {
      method: req.method,
      headers
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req
      init.duplex = 'half'
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

    // pipe upstream Web body → Express Node response. Readable.fromWeb
    // bridges the two; pipeline takes care of error/close propagation.
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
