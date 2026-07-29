/**
 * Resolve the loopback URL of the SignalK server we are running inside.
 *
 * Used to reach source plugins' HTTP routes (signalk-questdb,
 * signalk-grafana) for the database-export tick.
 *
 * Mirrors the server's own precedence in signalk-server/src/ports.ts:
 *   getHttpPort = process.env.PORT || settings.port || 3000
 *   getSslPort  = process.env.SSLPORT || settings.sslport || 3443
 *   primary port = settings.ssl ? sslPort : httpPort
 *
 * Reading only process.env.PORT (as this plugin used to) misses the
 * settings.json tier, which is how most installs set their port — the
 * export tick then probed a dead port and every exporter's detect()
 * silently returned false.
 */

/** The subset of SignalK's `app.config` we depend on; `ServerAPI` doesn't declare it publicly. */
export interface SignalKPortConfig {
  config?: {
    settings?: {
      ssl?: boolean
      port?: number | string
      sslport?: number | string
    }
  }
}

/** Server defaults from signalk-server/src/ports.ts. */
const DEFAULT_HTTP_PORT = 3000
const DEFAULT_SSL_PORT = 3443

// Mirrors the server's `Number(x) || fallback`: rejects 0, NaN and blanks.
function firstUsablePort(candidates: Array<number | string | undefined>, fallback: number): number {
  for (const c of candidates) {
    const n = Number(c)
    if (Number.isFinite(n) && n > 0) return n
  }
  return fallback
}

/** Loopback base URL, no trailing slash. */
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
