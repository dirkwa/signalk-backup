// WHY: drive the SSE→delta translator with synthetic events; verifies the exact handleMessage
// calls a real backup-server scheduler tick would produce, plus the failure/overdue/storageLow
// hysteresis transitions.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { __test_only__, type BackupCompletedEvent } from '../src/signalk-deltas.js'
import type { BackupServerAPI } from '../src/types.js'

function makeApp(): { app: BackupServerAPI; handleMessage: ReturnType<typeof vi.fn> } {
  const handleMessage = vi.fn()
  const debug = vi.fn()
  const app = {
    selfId: 'self-vessel-uuid',
    handleMessage,
    debug,
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    getDataDirPath: () => '/tmp'
  } as unknown as BackupServerAPI
  return { app, handleMessage }
}

function baseEvent(overrides: Partial<BackupCompletedEvent> = {}): BackupCompletedEvent {
  return {
    type: 'backup-completed',
    tier: 'hourly',
    timestamp: '2026-05-21T12:00:00.000Z',
    localResult: 'success',
    localBytes: 4096,
    backupId: 'snap-1',
    freeBytes: 800,
    totalBytes: 1000,
    nextScheduled: {
      hourly: '2026-05-21T13:00:00.000Z',
      daily: '2026-05-22T00:00:00.000Z',
      weekly: '2026-05-24T00:00:00.000Z'
    },
    ...overrides
  }
}

interface DeltaUpdate {
  timestamp?: string
  values?: Array<{ path: string; value: unknown }>
  meta?: Array<{ path: string; value: Record<string, unknown> }>
}
interface Delta {
  context: string
  updates: DeltaUpdate[]
}

function metricsDelta(handleMessage: ReturnType<typeof vi.fn>): Delta {
  // The metrics delta is the one that carries server.backup.lastRunTimestamp.
  const found = handleMessage.mock.calls
    .map((c) => c[1] as Delta)
    .find((d) =>
      d.updates.some((u) => u.values?.some((v) => v.path === 'server.backup.lastRunTimestamp'))
    )
  if (!found) throw new Error('no metrics delta emitted')
  return found
}

function lastOf<T>(arr: T[]): T {
  const v = arr[arr.length - 1]
  if (v === undefined) throw new Error('expected non-empty array')
  return v
}

function findValue(d: Delta, path: string): unknown {
  for (const u of d.updates) {
    for (const v of u.values ?? []) {
      if (v.path === path) return v.value
    }
  }
  return undefined
}

function deltasForPath(handleMessage: ReturnType<typeof vi.fn>, path: string): Array<Delta> {
  return handleMessage.mock.calls
    .filter((c) => {
      const d = c[1] as Delta
      return d.updates.some((u) => u.values?.some((v) => v.path === path))
    })
    .map((c) => c[1] as Delta)
}

let setup: ReturnType<typeof makeApp>
let state: ReturnType<typeof __test_only__.bootstrap>

beforeEach(() => {
  setup = makeApp()
  state = __test_only__.bootstrap(setup.app)
})

describe('emitMetrics', () => {
  it('emits the four metric paths plus tier on a successful run', () => {
    __test_only__.handleEvent(state, baseEvent())
    const d = metricsDelta(setup.handleMessage)
    expect(d.context).toBe('vessels.self-vessel-uuid')
    expect(findValue(d, 'server.backup.lastRunTimestamp')).toBe('2026-05-21T12:00:00.000Z')
    expect(findValue(d, 'server.backup.lastStatus')).toBe('success')
    expect(findValue(d, 'server.backup.lastRunBytes')).toBe(4096)
    expect(findValue(d, 'server.backup.lastRunTier')).toBe('hourly')
    expect(findValue(d, 'server.backup.nextScheduledTimestamp')).toBe('2026-05-21T13:00:00.000Z')
  })

  it('lastStatus is failure when cloud sync failed but local succeeded', () => {
    __test_only__.handleEvent(
      state,
      baseEvent({ cloudResult: 'failure', cloudTarget: 'gdrive', cloudError: '403' })
    )
    const d = metricsDelta(setup.handleMessage)
    expect(findValue(d, 'server.backup.lastStatus')).toBe('failure')
  })

  it('lastRunBytes is 0 when the server omits localBytes', () => {
    __test_only__.handleEvent(state, baseEvent({ localResult: 'failure', localBytes: undefined }))
    const d = metricsDelta(setup.handleMessage)
    expect(findValue(d, 'server.backup.lastRunBytes')).toBe(0)
  })

  it('emits meta only once per process', () => {
    __test_only__.handleEvent(state, baseEvent())
    const first = metricsDelta(setup.handleMessage)
    const hasMeta1 = first.updates.some((u) => u.meta && u.meta.length > 0)
    expect(hasMeta1).toBe(true)

    // Clear and emit again; the second metrics delta should NOT have meta.
    setup.handleMessage.mockClear()
    __test_only__.handleEvent(state, baseEvent())
    const second = metricsDelta(setup.handleMessage)
    const hasMeta2 = second.updates.some((u) => u.meta && u.meta.length > 0)
    expect(hasMeta2).toBe(false)
  })

  it('nextScheduledTimestamp is the earliest of the three tiers', () => {
    __test_only__.handleEvent(
      state,
      baseEvent({
        nextScheduled: {
          hourly: '2026-05-21T14:00:00.000Z',
          daily: '2026-05-21T13:30:00.000Z',
          weekly: '2026-05-21T13:00:00.000Z'
        }
      })
    )
    const d = metricsDelta(setup.handleMessage)
    expect(findValue(d, 'server.backup.nextScheduledTimestamp')).toBe('2026-05-21T13:00:00.000Z')
  })
})

describe('notifications.server.backup.failed', () => {
  it('raises alert with both targets in the message when both fail', () => {
    __test_only__.handleEvent(
      state,
      baseEvent({
        localResult: 'failure',
        localError: 'ENOSPC',
        cloudResult: 'failure',
        cloudTarget: 'gdrive',
        cloudError: '403 quota'
      })
    )
    const failedDeltas = deltasForPath(setup.handleMessage, 'notifications.server.backup.failed')
    expect(failedDeltas.length).toBeGreaterThan(0)
    const value = findValue(lastOf(failedDeltas), 'notifications.server.backup.failed') as {
      state: string
      message: string
      method: string[]
    }
    expect(value.state).toBe('alert')
    expect(value.message).toContain('Local Kopia: ENOSPC')
    expect(value.message).toContain('gdrive: 403 quota')
    expect(value.method).toEqual(['visual'])
  })

  it('clears (state: normal) after the next successful run', () => {
    __test_only__.handleEvent(
      state,
      baseEvent({ localResult: 'failure', localError: 'kopia exit 1' })
    )
    // Drain to the next event.
    __test_only__.handleEvent(state, baseEvent())
    const all = deltasForPath(setup.handleMessage, 'notifications.server.backup.failed')
    // First emission was the alert; second is the clear.
    expect(all.length).toBe(2)
    const cleared = findValue(lastOf(all), 'notifications.server.backup.failed') as {
      state: string
    }
    expect(cleared.state).toBe('normal')
  })

  it('does not re-emit `clear` on subsequent healthy events', () => {
    __test_only__.handleEvent(state, baseEvent({ localResult: 'failure', localError: 'x' }))
    __test_only__.handleEvent(state, baseEvent()) // clear #1
    __test_only__.handleEvent(state, baseEvent()) // should NOT emit again
    const all = deltasForPath(setup.handleMessage, 'notifications.server.backup.failed')
    expect(all.length).toBe(2)
  })
})

describe('notifications.server.backup.overdue', () => {
  it('does not raise overdue without a prior success baseline', () => {
    __test_only__.handleEvent(state, baseEvent({ localResult: 'failure', localError: 'x' }))
    const overdue = deltasForPath(setup.handleMessage, 'notifications.server.backup.overdue')
    expect(overdue.length).toBe(0)
  })

  it('raises warn when last hourly success >2h ago', () => {
    // First a success at T=0
    __test_only__.handleEvent(state, baseEvent({ timestamp: '2026-05-21T00:00:00.000Z' }))
    // Then a failure 3 hours later — overdue evaluator should fire.
    __test_only__.handleEvent(
      state,
      baseEvent({
        timestamp: '2026-05-21T03:00:00.000Z',
        localResult: 'failure',
        localError: 'x'
      })
    )
    const overdue = deltasForPath(setup.handleMessage, 'notifications.server.backup.overdue')
    expect(overdue.length).toBeGreaterThan(0)
    const v = findValue(lastOf(overdue), 'notifications.server.backup.overdue') as {
      state: string
    }
    expect(v.state).toBe('warn')
  })
})

describe('notifications.server.backup.storageLow', () => {
  it('raises warn when freeRatio < 10%', () => {
    __test_only__.handleEvent(state, baseEvent({ freeBytes: 80, totalBytes: 1000 }))
    const storage = deltasForPath(setup.handleMessage, 'notifications.server.backup.storageLow')
    const v = findValue(lastOf(storage), 'notifications.server.backup.storageLow') as {
      state: string
      message: string
    }
    expect(v.state).toBe('warn')
    expect(v.message).toContain('% free')
  })

  it('raises alert when freeRatio < 5%', () => {
    __test_only__.handleEvent(state, baseEvent({ freeBytes: 40, totalBytes: 1000 }))
    const storage = deltasForPath(setup.handleMessage, 'notifications.server.backup.storageLow')
    const v = findValue(lastOf(storage), 'notifications.server.backup.storageLow') as {
      state: string
    }
    expect(v.state).toBe('alert')
  })

  it('hysteresis: does NOT clear at 11% after raising at 9%, but DOES clear at 12%', () => {
    __test_only__.handleEvent(state, baseEvent({ freeBytes: 90, totalBytes: 1000 })) // warn
    __test_only__.handleEvent(state, baseEvent({ freeBytes: 110, totalBytes: 1000 })) // still active
    let storage = deltasForPath(setup.handleMessage, 'notifications.server.backup.storageLow')
    expect(storage.length).toBe(1)
    __test_only__.handleEvent(state, baseEvent({ freeBytes: 120, totalBytes: 1000 })) // clear at exactly 12%
    storage = deltasForPath(setup.handleMessage, 'notifications.server.backup.storageLow')
    expect(storage.length).toBe(2)
    const v = findValue(lastOf(storage), 'notifications.server.backup.storageLow') as {
      state: string
    }
    expect(v.state).toBe('normal')
  })

  it('skips entirely when totalBytes === 0 (statfs failed on the server)', () => {
    __test_only__.handleEvent(state, baseEvent({ freeBytes: 0, totalBytes: 0 }))
    const storage = deltasForPath(setup.handleMessage, 'notifications.server.backup.storageLow')
    expect(storage.length).toBe(0)
  })
})

describe('ignores non-backup-completed events', () => {
  it('drops events with a different type field silently', () => {
    __test_only__.handleEvent(state, {
      ...baseEvent(),
      // @ts-expect-error — intentional wrong type
      type: 'something-else'
    })
    expect(setup.handleMessage).not.toHaveBeenCalled()
  })
})
