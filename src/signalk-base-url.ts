// Loopback URL of the SignalK server we run inside, used to reach source
// plugins' export routes. Precedence mirrors signalk-server/src/ports.ts:
// env PORT/SSLPORT, then settings.port/sslport, then 3000/3443. Reading only
// env PORT misses the settings.json tier most installs use, which left the
// export tick probing a dead port with every detect() silently false (#90).

// Subset of app.config we read; ServerAPI doesn't declare it publicly.
export interface SignalKPortConfig {
  config?: {
    settings?: {
      ssl?: boolean
      port?: number | string
      sslport?: number | string
    }
  }
}

// Server defaults from signalk-server/src/ports.ts.
const DEFAULT_HTTP_PORT = 3000
const DEFAULT_SSL_PORT = 3443

// Like the server's `Number(x) || fallback`, but also rejects fractional and
// out-of-range values rather than building a URL nothing can connect to.
function firstUsablePort(candidates: Array<number | string | undefined>, fallback: number): number {
  for (const c of candidates) {
    const n = Number(c)
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n
  }
  return fallback
}

// Loopback base URL, no trailing slash.
export function resolveSignalkBaseUrl(app: object): string {
  // `ServerAPI` shares no declared members with SignalKPortConfig (all of
  // ours are optional), so TS rejects it as a weak-type argument. Narrow
  // from `object` here rather than widening the caller through `any`.
  const settings = (app as SignalKPortConfig).config?.settings

  // An SSL server serves https on the primary port, so http would never connect.
  if (settings?.ssl === true) {
    const sslPort = firstUsablePort([process.env['SSLPORT'], settings.sslport], DEFAULT_SSL_PORT)
    return `https://127.0.0.1:${sslPort}`
  }
  const httpPort = firstUsablePort([process.env['PORT'], settings?.port], DEFAULT_HTTP_PORT)
  return `http://127.0.0.1:${httpPort}`
}
