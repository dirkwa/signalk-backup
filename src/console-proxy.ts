/**
 * Reverse-proxy from the SignalK plugin's mount-point to the backup-server
 * container. The container binds to 127.0.0.1 only (signalk-container's
 * `signalkAccessiblePorts` security model), so a browser on a different
 * machine cannot reach it directly. The plugin pipes /plugins/signalk-backup/
 * console/* through to http://<containerAddr>/* so users browse the backup
 * UI via the SignalK origin (which is already exposed on the LAN) and
 * inherit SignalK's existing auth.
 *
 * Implementation note: we use Node's built-in http.request rather than
 * http-proxy-middleware to avoid a runtime dependency. The proxy handles:
 *   - GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS
 *   - Streaming request and response bodies (uploads, ZIP downloads, SSE)
 *   - Hop-by-hop header stripping
 *   - Path rewriting: /plugins/signalk-backup/console/<rest> → /<rest>
 */

import type { Request, Response, IRouter } from 'express'
import * as http from 'http'

// Hop-by-hop headers that must not be forwarded (RFC 7230 §6.1).
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade'
])

export type AddressGetter = () => string | null

/**
 * Mount the proxy at /console (relative to the plugin's router root, which
 * SignalK mounts at /plugins/signalk-backup). The path-rewrite is
 * intentionally simple: anything after /console is passed through as the
 * backend path. So /plugins/signalk-backup/console/api/backups → /api/backups
 * inside the container.
 */
export function registerConsoleProxy(router: IRouter, getAddress: AddressGetter): void {
  // Express normalizes /console to match exactly; /console/* (with a slash)
  // matches everything below. Mount at both so /console redirects to
  // /console/ and the SPA's relative asset paths resolve.
  router.all(/^\/console(\/.*)?$/, (req: Request, res: Response) => {
    const addr = getAddress()
    if (!addr) {
      res.status(503).type('text/plain').send('backup-server not ready yet')
      return
    }

    // Path inside the container: drop the /console prefix, keep the rest.
    // Use req.params[0] which Express assigns to the (...) capture group.
    const tail = (req.params as Record<string, string | undefined>)[0]
    const targetPath = tail && tail.length > 0 ? tail : '/'
    const queryStr = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
    const upstreamPath = targetPath + queryStr

    // Filter request headers: drop hop-by-hop and rewrite Host.
    const upstreamHeaders: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue
      const key = k.toLowerCase()
      if (HOP_BY_HOP_HEADERS.has(key)) continue
      if (key === 'host') continue
      upstreamHeaders[k] = v
    }
    upstreamHeaders['host'] = addr
    // Forward original client IP via X-Forwarded-* so the backend can log
    // sensibly. SignalK auth is enforced upstream; the backend trusts.
    if (req.ip) upstreamHeaders['x-forwarded-for'] = req.ip
    upstreamHeaders['x-forwarded-proto'] = req.protocol
    upstreamHeaders['x-forwarded-host'] = req.get('host') ?? ''

    const colonIdx = addr.indexOf(':')
    const host = colonIdx === -1 ? addr : addr.slice(0, colonIdx)
    const port = colonIdx === -1 ? 80 : parseInt(addr.slice(colonIdx + 1), 10)

    const upstream = http.request(
      {
        host,
        port,
        method: req.method,
        path: upstreamPath,
        headers: upstreamHeaders
      },
      (upstreamRes) => {
        // Filter response headers: drop hop-by-hop, pass through everything
        // else (Content-Type, Content-Length, Set-Cookie, Cache-Control, …).
        const filteredHeaders: Record<string, number | string | string[]> = {}
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (v === undefined) continue
          if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue
          filteredHeaders[k] = v
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, filteredHeaders)
        upstreamRes.pipe(res)
      }
    )

    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).type('text/plain').send(`Bad gateway: ${err.message}`)
      } else {
        res.destroy()
      }
    })

    // SignalK mounts `express.json()` at the server level, which consumes
    // the body for any application/json request before our handler runs.
    // `req.body` is then a parsed JS object and the underlying stream has
    // already returned EOF — `req.pipe(upstream)` would close upstream
    // with zero bytes, so the container's POST/PUT handlers never fire.
    //
    // To work around this we serialize req.body back to JSON and write it
    // to upstream ourselves. For any other content-type (multipart uploads,
    // raw streams, GETs) we fall back to piping the (un-consumed) stream.
    const bodyAlreadyParsed =
      req.body !== undefined && req.body !== null && typeof req.body === 'object'
    if (bodyAlreadyParsed) {
      const payload = Buffer.from(JSON.stringify(req.body), 'utf-8')
      // Override Content-Length: parsed body length may differ from the
      // original (whitespace differences) and the original is now stale.
      upstream.setHeader('content-length', String(payload.length))
      upstream.setHeader('content-type', 'application/json')
      upstream.end(payload)
    } else {
      req.pipe(upstream)
      req.on('error', () => {
        upstream.destroy()
      })
    }
  })
}
