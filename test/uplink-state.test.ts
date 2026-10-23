import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readUplinkState,
  UPLINK_POLL_MS,
  UPLINK_RESEND_MS,
  UplinkReporter,
  type UplinkState
} from '../src/uplink-state.js'

function appWith(value: unknown) {
  const state = { value }
  return {
    state,
    app: {
      getSelfPath: vi.fn((path: string) =>
        path === 'network.internet.state' ? { value: state.value } : undefined
      ),
      debug: vi.fn()
    }
  }
}

describe('readUplinkState', () => {
  it.each(['online', 'metered', 'captive', 'offline'])('reads %s', (value) => {
    expect(readUplinkState(appWith(value).app)).toBe(value)
  })

  it('treats a missing path as unknown', () => {
    expect(readUplinkState({ getSelfPath: () => undefined })).toBeNull()
  })

  it('treats a value signalk-internet does not publish as unknown', () => {
    expect(readUplinkState(appWith('roaming').app)).toBeNull()
  })
})

describe('UplinkReporter', () => {
  let sent: UplinkState[]
  let target: { putUplinkState: (s: UplinkState) => Promise<void> } | null

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    target = {
      putUplinkState: vi.fn((s: UplinkState) => {
        sent.push(s)
        return Promise.resolve()
      })
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the state on start and again only when it changes', async () => {
    const { app, state } = appWith('online')
    const reporter = new UplinkReporter({ app, target: () => target })
    reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['online'])

    await vi.advanceTimersByTimeAsync(UPLINK_POLL_MS)
    expect(sent).toEqual(['online'])

    state.value = 'metered'
    await vi.advanceTimersByTimeAsync(UPLINK_POLL_MS)
    expect(sent).toEqual(['online', 'metered'])
    reporter.stop()
  })

  it('re-sends an unchanged state so a restarted server learns it again', async () => {
    const reporter = new UplinkReporter({ app: appWith('metered').app, target: () => target })
    reporter.start()
    await vi.advanceTimersByTimeAsync(UPLINK_RESEND_MS + UPLINK_POLL_MS)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    reporter.stop()
  })

  it('sends to a new server right away', async () => {
    const reporter = new UplinkReporter({ app: appWith('offline').app, target: () => target })
    reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    const first = target
    target = {
      putUplinkState: vi.fn((s: UplinkState) => {
        sent.push(s)
        return Promise.resolve()
      })
    }
    await reporter.report()
    expect(sent).toEqual(['offline', 'offline'])
    expect(first).not.toBe(target)
    reporter.stop()
  })

  it('waits while no server is connected', async () => {
    target = null
    const reporter = new UplinkReporter({ app: appWith('online').app, target: () => target })
    reporter.start()
    await vi.advanceTimersByTimeAsync(UPLINK_POLL_MS)
    expect(sent).toEqual([])
    reporter.stop()
  })

  it('keeps going when the server does not know the endpoint', async () => {
    const { app } = appWith('metered')
    target = { putUplinkState: vi.fn(async () => Promise.reject(new Error('404'))) }
    const reporter = new UplinkReporter({ app, target: () => target })
    await expect(reporter.report()).resolves.toBeUndefined()
    expect(app.debug).toHaveBeenCalled()
  })

  it('reports again after a send that was in flight when the server changed', async () => {
    const { app } = appWith('metered')
    let release: () => void = () => undefined
    const slow = {
      putUplinkState: vi.fn(
        (s: UplinkState) =>
          new Promise<void>((resolve) => {
            sent.push(s)
            release = resolve
          })
      )
    }
    let current: typeof slow | typeof target = slow
    const reporter = new UplinkReporter({ app, target: () => current })
    const first = reporter.report()
    current = target
    reporter.start()
    release()
    await first
    expect(sent).toEqual(['metered', 'metered'])
    expect(target?.putUplinkState).toHaveBeenCalledTimes(1)
    reporter.stop()
  })
})
