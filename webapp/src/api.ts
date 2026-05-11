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
  // Backup-server wraps responses in { success, data }; unwrap if so.
  if (
    body !== null &&
    typeof body === 'object' &&
    'success' in body &&
    (body as ApiEnvelope<T>).success === true &&
    'data' in body
  ) {
    return (body as ApiEnvelope<T>).data as T
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
