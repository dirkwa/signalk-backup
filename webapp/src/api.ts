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

/** One directory entry inside a snapshot, as returned by /backups/:id/tree. */
export interface BackupTreeEntry {
  name: string
  size: number
  /** ISO-8601 or kopia's locale-formatted timestamp; treat as opaque text. */
  mtime: string
  isDir: boolean
  /** Internal kopia object ID. Forwarded back to the server for downloads. */
  objectId: string
}

export type PartialRestoreState =
  | 'idle'
  | 'preparing'
  | 'safety_snapshotting'
  | 'extracting'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'rolling_back'
  | 'rolled_back'

export interface PartialRestoreStatus {
  state: PartialRestoreState
  progress: number
  statusMessage: string
  error?: string
  backupId?: string
  sourcePath?: string
  targetPath?: string
}

export type PartialRestoreTargetMode = 'original' | 'custom'

export interface PartialRestoreInput {
  sourcePath: string
  targetMode: PartialRestoreTargetMode
  /** Required when targetMode is "custom". Must resolve under signalkDataPath. */
  customPath?: string
  /** Resubmit with confirmOverwrite=true after a 409 to overwrite an existing entry. */
  confirmOverwrite?: boolean
}

/** Body returned with a 409 TARGET_EXISTS so the UI can show the user
 *  what they'd overwrite before resubmitting with confirmOverwrite. */
export interface PartialRestoreConflict {
  targetPath: string
  mtime: string | null
  size: number | null
}

/** One file in the live staging tree (the plugin's own
 *  database-exports/<sourcePluginId>/...). */
export interface StagingFileEntry {
  /** Path relative to the staging root, forward-slash separated. */
  path: string
  size: number
  /** ISO-8601 mtime. */
  mtime: string
}

export type CloudSyncMode = 'manual' | 'after_backup' | 'scheduled'
export type CloudSyncFrequency = 'daily' | 'weekly'

/**
 * Cloud sync provider identifier.
 *
 * - 'gdrive': Google Drive via rclone (OAuth)
 * - 'local': a host path (USB drive, NFS mount, anything mounted under
 *   /media or /mnt). No rclone — kopia writes to the path directly.
 * - 'smb': SMB/CIFS share (NAS, Synology, TrueNAS, Windows shares,
 *   generic Samba) via rclone's smb backend.
 */
export type CloudSyncProvider = 'gdrive' | 'local' | 'smb'

export interface SmbStatus {
  /** True when SMB credentials exist in rclone.conf. */
  connected: boolean
  /** Always equals connected for SMB (no separate "configured" state). */
  configured: boolean
  /** Active share host. */
  host?: string
  share?: string
  user?: string
  /** Convenience label, "user@host/share". */
  email?: string
}

export interface SmbDiscoveredHost {
  /** mDNS name (often the device's friendly name). */
  name: string
  /** First IP address from the responder (IPv4 preferred). */
  address: string
}

export interface SmbConnectInput {
  host: string
  share: string
  user: string
  password: string
  domain?: string
}

export interface LocalCandidate {
  /** Container-side path — what gets persisted via /local/configure. */
  containerPath: string
  /** Host-side path for display in the UI. */
  hostPath: string
  /** Free bytes on the destination's filesystem; null when unknown. */
  freeBytes: number | null
  /** Total bytes on the destination's filesystem; null when unknown. */
  totalBytes: number | null
  /**
   * True when the backup engine can write to this directory. Optional
   * for backwards compatibility with engine versions that predate the
   * field (treat missing as "unknown — let the user try and see").
   */
  writable?: boolean
}

export interface LocalStatus {
  /** True when a local destination is configured AND reachable + writable. */
  connected: boolean
  /** Always true for local (no auth flow). */
  configured: boolean
  containerPath?: string
  hostPath?: string
  freeBytes?: number
  totalBytes?: number
  /** Why connected is false, if it isn't. */
  error?: string
}

export interface CloudStatus {
  /** Active cloud provider. */
  provider: CloudSyncProvider
  connected: boolean
  configured: boolean
  syncing: boolean
  syncMode: CloudSyncMode | null
  syncFrequency: CloudSyncFrequency | null
  lastSync: string | null
  lastSyncError: string | null
  internetAvailable: boolean | null
  /** Human-readable label for the connected destination (e.g. gdrive email). */
  email?: string
}

export type GDriveAuthState = 'idle' | 'pending' | 'completed' | 'failed'

export interface GDriveAuthInfo {
  state: GDriveAuthState
  authUrl: string | null
  error: string | null
}

export interface CloudConfigUpdate {
  syncMode?: CloudSyncMode
  syncFrequency?: CloudSyncFrequency
}

export interface DataDirEntry {
  name: string
  size: number
  excluded: boolean
  type?: 'dir' | 'history'
}

export interface RepositoryStats {
  /** Actual bytes on disk for the local kopia repository. */
  totalSize: number
  /** Sum of snapshot logical (pre-dedup) sizes. */
  originalSize: number
  snapshotCount: number
  /** originalSize - totalSize, clamped at 0. */
  dedupSavings: number
  /** Reserved; server currently returns 0. */
  compressionRatio: number
  status: string
}

export interface PluginDataDirEntry {
  name: string
  size: number
  excluded: boolean
  /** If true, the user cannot un-exclude this dir (DB plugins, our own state). */
  lockedExcluded?: boolean
  /** Human-readable reason the dir is locked-excluded. */
  lockReason?: string
}

export interface RetentionConfig {
  /** Number of hourly backups to keep. */
  hourly: number
  /** Number of daily backups to keep. */
  daily: number
  /** Number of weekly backups to keep. */
  weekly: number
  /** Number of startup-time backups to keep. */
  startup: number
}

export interface DbExportConfig {
  /** Whether the QuestDB exporter runs on the interval. */
  questdb: boolean
  /** Whether the Grafana exporter runs on the interval. */
  grafana: boolean
  /** Whether the SignalK Database exporter runs on the interval. */
  signalkDatabase: boolean
  /** Interval between exports in minutes (5 - 1440). */
  intervalMinutes: number
}

export interface PasswordStatus {
  hasCustomPassword: boolean
  /** The current kopia password. Exposed to the user so it can be copied
   *  down before a rotation — losing the custom password makes existing
   *  backups unreadable. UI defaults to masked; users opt in to reveal. */
  password?: string
}

interface ApiEnvelope<T> {
  success?: boolean
  data?: T
  error?: { code?: string; message?: string }
}

/** Thrown by api.restorePartial when the target already exists and the
 *  caller didn't pass confirmOverwrite. Carries the existing entry's
 *  mtime+size so the UI can show a confirmation diff and resubmit. */
export class PartialRestoreConflictError extends Error {
  constructor(
    message: string,
    public readonly conflict: PartialRestoreConflict
  ) {
    super(message)
    this.name = 'PartialRestoreConflictError'
  }
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

  repository: () => request<RepositoryStats>('/backups/repository'),

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

  // Partial restore / tree-browser passthrough (signalk-backup#30).
  // Proxied through the plugin to the backup-server's identical endpoints.

  listBackupTree: (id: string, path: string) =>
    request<{ path: string; entries: BackupTreeEntry[] }>(
      `/backups/${encodeURIComponent(id)}/tree?path=${encodeURIComponent(path)}`
    ),

  /** URL the browser can open / fetch to download one sub-path (raw bytes
   *  for files, ZIP for directories). Returned as a URL because it's a
   *  binary stream; pass via window.open() or an <a href>. */
  downloadSubtreeUrl: (id: string, path: string): string =>
    `${API_BASE}/backups/${encodeURIComponent(id)}/download-subtree?path=${encodeURIComponent(path)}`,

  /** Start a partial restore. Throws PartialRestoreConflictError when
   *  the target already exists and confirmOverwrite wasn't set — the
   *  UI should surface the conflict and resubmit with confirmOverwrite. */
  restorePartial: async (id: string, input: PartialRestoreInput): Promise<{ started: boolean }> => {
    const url = `${API_BASE}/backups/${encodeURIComponent(id)}/restore-partial`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as
        | (ApiEnvelope<{ conflict?: PartialRestoreConflict }> & {
            data?: { conflict?: PartialRestoreConflict }
          })
        | null
      const conflict = body?.data?.conflict
      const code = body?.error?.code
      if (code === 'TARGET_EXISTS' && conflict) {
        throw new PartialRestoreConflictError(
          body.error?.message ?? 'Target already exists',
          conflict
        )
      }
      // Other 409s (BUSY, RESTORE_NEEDS_FULL, CONFLICT from path-safety) —
      // surface as a plain Error so the existing handler shows the message.
      throw new Error(
        `restore-partial → 409${code ? ` [${code}]` : ''}: ${body?.error?.message ?? 'conflict'}`
      )
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`restore-partial → ${res.status}: ${text.slice(0, 200)}`)
    }
    const body = (await res.json()) as ApiEnvelope<{ started: boolean }>
    if (body.success === false) {
      throw new Error(`restore-partial: ${body.error?.message ?? 'unknown error'}`)
    }
    return body.data ?? { started: true }
  },

  restorePartialStatus: () => request<PartialRestoreStatus>('/backups/restore-partial/status'),

  resetRestorePartialState: () =>
    request<{ message: string }>('/backups/restore-partial/reset', { method: 'POST' }),

  // Live DB-export staging (plugin-side, not proxied). Lists files the
  // plugin wrote during its scheduled tick to
  // <getDataDirPath()>/database-exports/<sourcePluginId>/...
  listStaging: () =>
    request<{ stagingRoot: string; entries: StagingFileEntry[] }>('/db-export/staging'),

  /** Direct download URL for one live-staging file (URL-encoded relative
   *  path). Returned as a URL because it's a binary stream. */
  stagingDownloadUrl: (file: string): string =>
    `${API_BASE}/db-export/staging/download?file=${encodeURIComponent(file)}`,

  // Cloud sync — Google Drive auth + sync. Auth flow: connectGDrive
  // returns a Google OAuth URL the user opens; the browser is redirected
  // back to rclone's local listener (port 53682) which the plugin
  // exposes back to the user. When that path doesn't work (browser on a
  // different host than rclone), the user pastes the callback URL from
  // their browser into auth-callback to forward it manually.
  // Older backup-server images (pre-multi-provider refactor) don't include
  // `provider` in the response. Default it to `gdrive` so the type stays
  // honest at the API boundary and downstream code can rely on a defined
  // value. Drop the default once the floor backup-server version ships
  // with `provider`.
  cloudStatus: async (): Promise<CloudStatus> => {
    const raw = await request<Partial<CloudStatus> & Omit<CloudStatus, 'provider'>>('/cloud/status')
    return { ...raw, provider: raw.provider ?? 'gdrive' }
  },
  gdriveStatus: () =>
    request<{ connected: boolean; configured: boolean; email?: string }>('/cloud/gdrive/status'),
  gdriveAuthState: () => request<GDriveAuthInfo>('/cloud/gdrive/auth-state'),
  gdriveConnect: () => request<{ authUrl: string }>('/cloud/gdrive/connect', { method: 'POST' }),
  gdriveCancel: () => request<{ cancelled: boolean }>('/cloud/gdrive/cancel', { method: 'POST' }),
  gdriveAuthCallback: (url: string) =>
    request<{ accepted: boolean }>('/cloud/gdrive/auth-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    }),
  gdriveDisconnect: () =>
    request<{ disconnected: boolean }>('/cloud/gdrive/disconnect', { method: 'POST' }),

  // Local-filesystem destination (USB drive / mounted folder). No auth flow,
  // just a path. Discovery walks /host-media + /host-mnt baseline mounts.
  localStatus: () => request<LocalStatus>('/cloud/local/status'),
  localDiscover: () => request<{ candidates: LocalCandidate[] }>('/cloud/local/discover'),
  localConfigure: (containerPath: string, hostPath?: string) =>
    request<CloudStatus>('/cloud/local/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containerPath, hostPath })
    }),
  localDisconnect: () =>
    request<{ disconnected: boolean }>('/cloud/local/disconnect', { method: 'POST' }),

  // SMB share destination. Discover runs on the plugin (SignalK process)
  // — multicast doesn't have to traverse the backup-server container's
  // network. The other three are proxied through to backup-server.
  smbStatus: () => request<SmbStatus>('/cloud/smb/status'),
  smbDiscover: () => request<{ hosts: SmbDiscoveredHost[] }>('/cloud/smb/discover'),
  smbConnect: (input: SmbConnectInput) =>
    request<{ connected: boolean }>('/cloud/smb/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    }),
  smbDisconnect: () =>
    request<{ disconnected: boolean }>('/cloud/smb/disconnect', { method: 'POST' }),

  // Database export (plugin-side, not proxied to backup-server). The
  // plugin runs the export interval timer; the backup-server just
  // snapshots the resulting Parquet files when the next backup runs.
  dbExportConfig: () => request<DbExportConfig>('/db-export/config'),
  dbExportConfigSet: (next: Partial<DbExportConfig>) =>
    request<DbExportConfig>('/db-export/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next)
    }),

  cloudSync: () => request<{ started: boolean }>('/cloud/sync', { method: 'POST' }),
  cloudSyncCancel: () => request<{ cancelled: boolean }>('/cloud/sync/cancel', { method: 'POST' }),
  cloudConfig: (config: CloudConfigUpdate) =>
    request<CloudStatus>('/cloud/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    }),

  // Scheduler control — start/stop the backup-server's internal scheduler.
  // Returns just { enabled }; the richer SchedulerStatus shape comes from
  // GET /backups/scheduler (re-fetched after a toggle).
  schedulerStart: () =>
    request<{ enabled: boolean }>('/backups/scheduler/start', { method: 'POST' }),
  schedulerStop: () => request<{ enabled: boolean }>('/backups/scheduler/stop', { method: 'POST' }),

  // Retention — how many backups of each tier kopia keeps. Manual
  // backups are absent on purpose (never auto-pruned).
  retention: () => request<RetentionConfig>('/backups/retention'),
  setRetention: (next: Partial<RetentionConfig>) =>
    request<RetentionConfig>('/backups/retention', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next)
    }),

  // Exclusions — the list of glob patterns kopia skips during backup.
  // The patterns set here is the user-configurable layer; the server
  // adds always-excluded patterns (kopia repo, etc) and live-DB
  // defaults on top.
  exclusions: () => request<{ exclusions: string[] }>('/backups/exclusions'),
  setExclusions: (exclusions: string[]) =>
    request<{ exclusions: string[] }>('/backups/exclusions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exclusions })
    }),

  // Read-only directory listings the Settings UI uses to drive the
  // exclusions checklist. Both list every candidate dir with its current
  // excluded state derived from the patterns above + the always/locked
  // server-side rules.
  dataDirs: () => request<DataDirEntry[]>('/backups/data-dirs'),
  pluginDataDirs: () => request<PluginDataDirEntry[]>('/backups/plugin-data-dirs'),

  // Encryption password — kopia's repo password. Default is a known
  // string; once a user sets a custom one, hasCustomPassword goes true.
  // Server returns both the boolean and the actual password; the UI
  // shows it behind a reveal toggle so the user can copy it before a
  // rotation (losing the custom password makes existing backups
  // unreadable).
  passwordStatus: () => request<PasswordStatus>('/backups/password'),
  setPassword: (password: string) =>
    request<{ updated: boolean }>('/backups/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, confirmPassword: password })
    }),
  resetPassword: () => request<{ reset: boolean }>('/backups/password', { method: 'DELETE' }),

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
