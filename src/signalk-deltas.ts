// WHY this file exists: GH issue #33 — publish backup health to the SignalK delta stream
// so KIP/Freeboard/dashboards see "did the last backup succeed, when is the next, anything wrong?"
// without polling. The signalk-backup-server scheduler emits `backup-completed` events over SSE
// (one per scheduled tick, including local + cloud outcome and disk free-space). This module
// subscribes to that stream and translates each event into a delta on `vessels.<selfId>` plus
// notifications under `notifications.server.backup.*`.
//
// Manual backups are deliberately not emitted (Dirk: "only fire on scheduled tasks").
// The SSE stream itself filters those — backup-server only emits for scheduler ticks.

import type { BackupServerAPI } from './types.js'

export type BackupTier = 'hourly' | 'daily' | 'weekly' | 'startup'

export interface BackupCompletedEvent {
  type: 'backup-completed'
  tier: BackupTier
  timestamp: string
  localResult: 'success' | 'failure'
  localError?: string
  localBytes?: number
  backupId?: string
  cloudResult?: 'success' | 'failure' | 'skipped'
  cloudError?: string
  cloudTarget?: 'gdrive' | 'smb' | 'local'
  freeBytes: number
  totalBytes: number
  nextScheduled: { hourly: string; daily: string; weekly: string }
}

const METRIC_BASE = 'server.backup'
const NOTIF_BASE = 'notifications.server.backup'

// Hysteresis band so a disk hovering at the boundary doesn't flap warn/normal repeatedly.
// Threshold values are documented in README.md "SignalK paths published" — keep in sync.
const STORAGE_LOW_WARN = 0.1 // <10% free → warn
const STORAGE_LOW_ALERT = 0.05 // <5% free → alert
const STORAGE_LOW_CLEAR = 0.12 // ≥12% free → clear

const TIER_INTERVAL_MS: Record<BackupTier, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  startup: 0 // never overdue: triggers only on server start
}

// Documented in README.md "SignalK paths published" — keep in sync.
const OVERDUE_MULTIPLIER = 2

interface DeltaEmitterState {
  app: BackupServerAPI
  baseUrl: string
  config: { emitSignalKDeltas: boolean }
  abortController: AbortController
  metaEmitted: boolean
  lastSuccessByTier: Map<BackupTier, number>
  activeNotifications: Set<string>
  reconnectTimer: NodeJS.Timeout | null
  reconnectDelayMs: number
  stopped: boolean
}

// WHY this indirection: eslint's no-unnecessary-condition narrows literal-typed
// fields to a constant within a function scope. The `stopped` flag is mutated
// from outside (stopSignalKEmitter), so reading it through a function call
// blocks the narrowing without disabling the rule project-wide.
function isStopped(s: DeltaEmitterState): boolean {
  return s.stopped
}

// WHY duck-type rather than rely on the static type: SSE input is untrusted
// JSON; a server-side rev that adds a new event type shouldn't crash the plugin.
function isBackupCompleted(e: { type: string }): boolean {
  return e.type === 'backup-completed'
}

let state: DeltaEmitterState | null = null

/**
 * Start subscribing to the backup-server's SSE stream and emitting deltas.
 * Idempotent — calling twice is a no-op. Survives the backup-server restarting
 * (managed-container restarts, image updates) by reconnecting with backoff.
 */
export function startSignalKEmitter(
  app: BackupServerAPI,
  baseUrl: string,
  config: { emitSignalKDeltas: boolean }
): void {
  if (state) {
    app.debug('[signalk-deltas] start called while already running — ignoring')
    return
  }
  if (!config.emitSignalKDeltas) {
    app.debug('[signalk-deltas] emitSignalKDeltas=false — not starting subscriber')
    return
  }

  state = {
    app,
    baseUrl,
    config,
    abortController: new AbortController(),
    metaEmitted: false,
    lastSuccessByTier: new Map(),
    activeNotifications: new Set(),
    reconnectTimer: null,
    reconnectDelayMs: 1_000,
    stopped: false
  }
  app.debug(`[signalk-deltas] starting SSE subscriber → ${baseUrl}/api/backups/events/stream`)
  void connect(state)
}

export function stopSignalKEmitter(): void {
  if (!state) return
  state.stopped = true
  state.abortController.abort()
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
  state.app.debug('[signalk-deltas] stopped')
  state = null
}

async function connect(s: DeltaEmitterState): Promise<void> {
  if (isStopped(s)) return
  try {
    const res = await fetch(`${s.baseUrl}/api/backups/events/stream`, {
      signal: s.abortController.signal,
      headers: { Accept: 'text/event-stream' }
    })
    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed: HTTP ${res.status}`)
    }
    s.app.debug('[signalk-deltas] SSE connected')
    s.reconnectDelayMs = 1_000 // reset backoff on a clean connect

    const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const decoder = new TextDecoder()
    let buffer = ''
    // SSE frames are separated by a blank line. Each frame may have multiple
    // `data:` lines (concatenated), interspersed with `:` keepalives we ignore.
    while (!isStopped(s)) {
      const { value, done } = await reader.read()
      if (done) throw new Error('SSE stream ended')
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
        if (dataLines.length === 0) continue
        try {
          const event = JSON.parse(dataLines.join('\n')) as BackupCompletedEvent
          handleEvent(s, event)
        } catch (err) {
          s.app.debug(`[signalk-deltas] failed to parse SSE frame: ${(err as Error).message}`)
        }
      }
    }
  } catch (err) {
    if (isStopped(s)) return
    s.app.debug(`[signalk-deltas] SSE disconnect: ${(err as Error).message}`)
    scheduleReconnect(s)
  }
}

function scheduleReconnect(s: DeltaEmitterState): void {
  if (isStopped(s)) return
  const delay = s.reconnectDelayMs
  s.reconnectDelayMs = Math.min(s.reconnectDelayMs * 2, 30_000)
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null
    s.abortController = new AbortController()
    void connect(s)
  }, delay)
}

export function handleEvent(s: DeltaEmitterState, event: BackupCompletedEvent): void {
  // Defensive: untrusted SSE input may carry a future event type the plugin doesn't know.
  if (!isBackupCompleted(event)) return

  emitMetrics(s, event)

  if (event.localResult === 'success' && event.cloudResult !== 'failure') {
    s.lastSuccessByTier.set(event.tier, Date.parse(event.timestamp))
    clearNotification(s, 'failed')
  } else {
    raiseFailedNotification(s, event)
  }

  evaluateOverdue(s, event)
  evaluateStorageLow(s, event)
}

function emitMetrics(s: DeltaEmitterState, event: BackupCompletedEvent): void {
  const lastStatus =
    event.localResult === 'success' && event.cloudResult !== 'failure' ? 'success' : 'failure'

  // The four metric paths the issue lists, plus a tier label so dashboards can split
  // by tier without parsing the message.
  const values: Array<{ path: string; value: unknown }> = [
    { path: `${METRIC_BASE}.lastRunTimestamp`, value: event.timestamp },
    { path: `${METRIC_BASE}.lastStatus`, value: lastStatus },
    { path: `${METRIC_BASE}.lastRunTier`, value: event.tier },
    { path: `${METRIC_BASE}.nextScheduledTimestamp`, value: minTimestamp(event.nextScheduled) }
  ]
  // Emit 0 on failure so dashboards always have a value; explicit omit on unknown-size
  // is handled by the server (event.localBytes undefined).
  values.push({ path: `${METRIC_BASE}.lastRunBytes`, value: event.localBytes ?? 0 })

  const updates: unknown[] = [
    {
      timestamp: event.timestamp,
      values
    }
  ]

  // Emit `meta` only once per process — first event seeds units + displayName for clients.
  if (!s.metaEmitted) {
    updates.push({ meta: metaSeed() })
    s.metaEmitted = true
  }

  s.app.handleMessage('signalk-backup', {
    context: `vessels.${s.app.selfId}` as never,
    updates: updates as never
  })
}

function metaSeed(): Array<{ path: string; value: Record<string, unknown> }> {
  return [
    {
      path: `${METRIC_BASE}.lastRunBytes`,
      value: {
        units: 'B',
        description: 'Size of the most recent scheduled backup',
        displayName: 'Last backup size'
      }
    },
    {
      path: `${METRIC_BASE}.lastRunTimestamp`,
      value: {
        description: 'When the most recent scheduled backup ran',
        displayName: 'Last backup'
      }
    },
    {
      path: `${METRIC_BASE}.lastStatus`,
      value: {
        description: 'Outcome of the most recent scheduled backup run',
        displayName: 'Backup status'
      }
    },
    {
      path: `${METRIC_BASE}.lastRunTier`,
      value: {
        description: 'Scheduler tier that produced the most recent run',
        displayName: 'Last backup tier'
      }
    },
    {
      path: `${METRIC_BASE}.nextScheduledTimestamp`,
      value: {
        description: 'When the next scheduled backup is due (earliest of all tiers)',
        displayName: 'Next backup'
      }
    }
  ]
}

function raiseFailedNotification(s: DeltaEmitterState, event: BackupCompletedEvent): void {
  const failedParts: string[] = []
  if (event.localResult === 'failure') {
    failedParts.push(`Local Kopia: ${event.localError ?? 'unknown error'}`)
  }
  if (event.cloudResult === 'failure') {
    const target = event.cloudTarget ?? 'cloud'
    failedParts.push(`${target}: ${event.cloudError ?? 'unknown error'}`)
  }
  const message =
    failedParts.length > 0
      ? `Backup failed — ${failedParts.join('; ')}`
      : 'Backup failed (no detail)'
  emitNotification(s, 'failed', 'alert', message, event.timestamp)
}

function evaluateOverdue(s: DeltaEmitterState, event: BackupCompletedEvent): void {
  const now = Date.parse(event.timestamp)
  let overdue: BackupTier | null = null
  for (const tier of ['hourly', 'daily', 'weekly'] as const) {
    const interval = TIER_INTERVAL_MS[tier]
    if (interval === 0) continue
    const lastSuccess = s.lastSuccessByTier.get(tier)
    if (lastSuccess === undefined) continue // no baseline yet, give it one cycle
    if (now - lastSuccess > OVERDUE_MULTIPLIER * interval) {
      overdue = tier
      break
    }
  }
  if (overdue) {
    const msg = `Scheduled ${overdue} backup is overdue (last success >${(OVERDUE_MULTIPLIER * TIER_INTERVAL_MS[overdue]) / 3_600_000}h ago)`
    emitNotification(s, 'overdue', 'warn', msg, event.timestamp)
  } else {
    clearNotification(s, 'overdue')
  }
}

function evaluateStorageLow(s: DeltaEmitterState, event: BackupCompletedEvent): void {
  if (event.totalBytes <= 0) {
    // Server couldn't statfs — skip rather than raise a misleading alarm.
    return
  }
  const freeRatio = event.freeBytes / event.totalBytes
  const active = s.activeNotifications.has('storageLow')

  let raisedState: 'warn' | 'alert' | null = null
  if (freeRatio < STORAGE_LOW_ALERT) raisedState = 'alert'
  else if (freeRatio < STORAGE_LOW_WARN) raisedState = 'warn'

  if (raisedState) {
    const pct = (freeRatio * 100).toFixed(1)
    emitNotification(
      s,
      'storageLow',
      raisedState,
      `Backup storage low: ${pct}% free`,
      event.timestamp
    )
  } else if (active && freeRatio >= STORAGE_LOW_CLEAR) {
    clearNotification(s, 'storageLow')
  }
  // freeRatio between WARN and CLEAR with no prior alarm → no-op (hysteresis dead-band).
}

function emitNotification(
  s: DeltaEmitterState,
  key: 'failed' | 'overdue' | 'storageLow',
  state: 'alert' | 'warn',
  message: string,
  timestamp: string
): void {
  const path = `${NOTIF_BASE}.${key}`
  s.app.handleMessage('signalk-backup', {
    context: `vessels.${s.app.selfId}` as never,
    updates: [
      {
        timestamp: timestamp as never,
        values: [
          {
            path: path as never,
            value: {
              state,
              method: ['visual'],
              message,
              timestamp
            }
          }
        ]
      }
    ]
  })
  s.activeNotifications.add(key)
}

function clearNotification(s: DeltaEmitterState, key: 'failed' | 'overdue' | 'storageLow'): void {
  if (!s.activeNotifications.has(key)) return
  const path = `${NOTIF_BASE}.${key}`
  s.app.handleMessage('signalk-backup', {
    context: `vessels.${s.app.selfId}` as never,
    updates: [
      {
        timestamp: new Date().toISOString() as never,
        values: [
          {
            path: path as never,
            value: {
              state: 'normal',
              method: [],
              message: 'OK',
              timestamp: new Date().toISOString()
            }
          }
        ]
      }
    ]
  })
  s.activeNotifications.delete(key)
}

function minTimestamp(next: { hourly: string; daily: string; weekly: string }): string {
  const candidates = [next.hourly, next.daily, next.weekly].filter((t): t is string => !!t)
  if (candidates.length === 0) return new Date().toISOString()
  candidates.sort((a, b) => Date.parse(a) - Date.parse(b))
  return candidates[0] ?? new Date().toISOString()
}

// Test-only helpers exposed so the vitest suite can drive the translator without an SSE server.
export const __test_only__ = {
  /** Inject a fresh state for tests; returns the test handle. */
  bootstrap(app: BackupServerAPI): DeltaEmitterState {
    return {
      app,
      baseUrl: 'http://test',
      config: { emitSignalKDeltas: true },
      abortController: new AbortController(),
      metaEmitted: false,
      lastSuccessByTier: new Map(),
      activeNotifications: new Set(),
      reconnectTimer: null,
      reconnectDelayMs: 1_000,
      stopped: false
    }
  },
  handleEvent,
  STORAGE_LOW_WARN,
  STORAGE_LOW_ALERT,
  STORAGE_LOW_CLEAR
}
