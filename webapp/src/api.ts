// All API calls hit the plugin's reverse proxy at
// /plugins/signalk-backup/api/*. Same origin as the SignalK admin UI,
// so no CORS dance and we inherit SignalK's auth layer.
const API_BASE = '/plugins/signalk-backup/api'

export interface BackupServerHealth {
  status: string
  uptime?: number
  version?: string
}

export interface PluginStatus {
  container: {
    state: string
    image: string
    managed: boolean
  }
  ready: boolean
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API_BASE + path)
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  // The backup-server wraps responses in { success, data }; unwrap if so.
  const body = (await res.json()) as unknown
  if (
    body !== null &&
    typeof body === 'object' &&
    'success' in body &&
    'data' in body &&
    (body as { success: boolean }).success
  ) {
    return (body as { data: T }).data
  }
  return body as T
}

export const api = {
  health: () => getJson<BackupServerHealth>('/health'),
  // The plugin's /status route is at /plugins/signalk-backup/status (no
  // /api prefix), so it's NOT proxied. Fetched separately.
  pluginStatus: async (): Promise<PluginStatus> => {
    const res = await fetch('/plugins/signalk-backup/status')
    if (!res.ok) throw new Error(`/status → ${res.status}`)
    return res.json() as Promise<PluginStatus>
  }
}
