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

/** Backup categorisation; common values are manual/hourly/daily/weekly/startup
 *  but we accept anything the server sends so a future tier doesn't break the UI. */
export type BackupType = string

export interface BackupMetadata {
  id: string
  createdAt: string
  type: BackupType
  size: number
  description?: string
  checksum?: string
  path?: string
  includesPlugins?: boolean
  includesPluginData?: boolean
  includesHistory?: boolean
}

export interface BackupsResponse {
  backups: BackupMetadata[]
  grouped: Record<string, BackupMetadata[]>
}

export interface SchedulerStatus {
  enabled: boolean
  lastBackup: string | null
  nextBackups: {
    hourly: string | null
    daily: string | null
    weekly: string | null
  }
  backupCounts: {
    total: number
    hourly: number
    daily: number
    weekly: number
    startup: number
    manual: number
  }
}

export type RestoreState =
  | 'idle'
  | 'preparing'
  | 'extracting'
  | 'installing'
  | 'restarting'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'rolling_back'
  | 'rolled_back'

export interface RestoreStatus {
  state: RestoreState
  progress: number
  statusMessage: string
  error?: string
}

interface ApiEnvelope<T> {
  success?: boolean
  data?: T
  error?: { code?: string; message?: string }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, init)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`)
  }
  const body = (await res.json()) as unknown
  // Backup-server wraps responses in { success, data | error }. Unwrap
  // success → return data; success === false → throw with the server's
  // error message so the UI sees a real Error rather than a malformed T.
  if (body !== null && typeof body === 'object' && 'success' in body) {
    const env = body as ApiEnvelope<T>
    if (env.success === false) {
      const code = env.error?.code ? ` [${env.error.code}]` : ''
      throw new Error(`${path}${code}: ${env.error?.message ?? 'unknown server error'}`)
    }
    if (env.success === true && 'data' in body) {
      return env.data as T
    }
  }
  return body as T
}

export const api = {
  health: () => request<BackupServerHealth>('/health'),

  listBackups: () => request<BackupsResponse>('/backups'),

  scheduler: () => request<SchedulerStatus>('/backups/scheduler'),

  createBackup: (description?: string) =>
    request<BackupMetadata>('/backups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description })
    }),

  deleteBackup: (id: string) =>
    request<{ deleted: string }>(`/backups/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    }),

  // Multipart upload — fetch picks the boundary; do NOT set Content-Type
  // ourselves or the browser will not append the boundary value.
  uploadBackup: (file: File, description?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (description) form.append('description', description)
    form.append('restoreImmediately', 'false')
    return request<{ backup: BackupMetadata }>('/backups/upload', {
      method: 'POST',
      body: form
    })
  },

  startRestore: (id: string) =>
    request<{ started: boolean }>(`/backups/${encodeURIComponent(id)}/restore`, {
      method: 'POST'
    }),

  restoreStatus: () => request<RestoreStatus>('/backups/restore/status'),

  resetRestoreState: () =>
    request<{ reset: boolean }>('/backups/restore/reset', { method: 'POST' }),

  // Direct download URL — caller uses as <a href> or window.open(). No
  // unwrap because it's a binary stream, not JSON.
  downloadUrl: (id: string): string => `${API_BASE}/backups/${encodeURIComponent(id)}/download`,

  // Plugin's own /status (NOT proxied — no /api prefix).
  pluginStatus: async (): Promise<PluginStatus> => {
    const res = await fetch('/plugins/signalk-backup/status')
    if (!res.ok) throw new Error(`/status → ${res.status}`)
    return res.json() as Promise<PluginStatus>
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1024
  let i = 0
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(1)} ${units[i]}`
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Never'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  // Compact local format suitable for dense tables.
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}
