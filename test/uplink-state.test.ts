import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Delta } from '@signalk/server-api'
import {
  FIRST_STATE_WAIT_MS,
  toUplinkState,
  UPLINK_RESEND_MS,
  UplinkReporter,
  type UplinkReporterOptions,
  type UplinkState
} from '../src/uplink-state.js'

// A server whose subscription manager sends `cached` when the subscription starts, as Signal K does with
// the last value; `publish` delivers the next one.
function serverWith(cached: unknown) {
  let deliver: ((value: unknown) => void) | null = null
  const server = { unsubscribed: 0 }
  const subscriptionmanager = {
    subscribe: vi.fn(
      (
        _subscription: unknown,
        unsubscribes: Array<() => void>,
        _onError: unknown,
        onDelta: (delta: Delta) => void
      ) => {
        deliver = (value) => {
          onDelta({
            updates: [{ values: [{ path: 'network.internet.state', value }] }]
          } as unknown as Delta)
        }
        unsubscribes.push(() => {
          deliver = null
          server.unsubscribed++
        })
        if (cached !== undefined) deliver(cached)
      }
    ),
    unsubscribe: vi.fn()
  }
  const app = { subscriptionmanager, debug: vi.fn() } as unknown as UplinkReporterOptions['app'] & {
    debug: ReturnType<typeof vi.fn>
  }
  return { app, server, publish: (value: unknown) => deliver?.(value) }
}

describe('toUplinkState', () => {
  it.each(['online', 'metered', 'captive', 'offline'])('reads %s', (value) => {
    expect(toUplinkState(value)).toBe(value)
  })

  it('treats no value as unknown', () => {
    expect(toUplinkState(undefined)).toBeNull()
    expect(toUplinkState(null)).toBeNull()
  })

  it('treats a value signalk-internet does not publish as unknown', () => {
    expect(toUplinkState('roaming')).toBeNull()
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

  it('sends the state on start and again when it changes', async () => {
    const { app, publish } = serverWith('online')
    const reporter = new UplinkReporter({ app, target: () => target })
    reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['online'])

    publish('online')
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['online'])

    publish('metered')
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['online', 'metered'])
    reporter.stop()
  })

  it('re-sends an unchanged state so a restarted server learns it again', async () => {
    const reporter = new UplinkReporter({ app: serverWith('metered').app, target: () => target })
    reporter.start()
    await vi.advanceTimersByTimeAsync(UPLINK_RESEND_MS - 1)
    expect(sent).toEqual(['metered'])
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual(['metered', 'metered'])
    reporter.stop()
  })

  it('sends to a new server right away', async () => {
    const reporter = new UplinkReporter({ app: serverWith('offline').app, target: () => target })
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
    const reporter = new UplinkReporter({ app: serverWith('online').app, target: () => target })
    reporter.start()
    await vi.advanceTimersByTimeAsync(UPLINK_RESEND_MS)
    expect(sent).toEqual([])
    reporter.stop()
  })

  it('keeps going when the server does not know the endpoint', async () => {
    const { app } = serverWith('metered')
    target = { putUplinkState: vi.fn(async () => Promise.reject(new Error('404'))) }
    const reporter = new UplinkReporter({ app, target: () => target })
    reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(app.debug).toHaveBeenCalled()
    reporter.stop()
  })

  it('reports again after a send that was in flight when the server changed', async () => {
    const { app } = serverWith('metered')
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
    reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    current = target
    reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['metered', 'metered'])
    expect(target?.putUplinkState).toHaveBeenCalledTimes(1)
    reporter.stop()
  })

  it('unsubscribes on stop', async () => {
    const { app, server, publish } = serverWith('online')
    const reporter = new UplinkReporter({ app, target: () => target })
    reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    reporter.stop()
    expect(server.unsubscribed).toBe(1)
    publish('metered')
    await vi.advanceTimersByTimeAsync(UPLINK_RESEND_MS)
    expect(sent).toEqual(['online'])
  })

  describe("with the server's plugin list", () => {
    const pluginsList = (enabled: boolean) =>
      vi.fn(() => Promise.resolve([{ id: 'signalk-internet', enabled }]))

    it('sends a published state without asking the plugin list', async () => {
      const getPluginsList = pluginsList(false)
      const reporter = new UplinkReporter({
        app: serverWith('metered').app,
        target: () => target,
        getPluginsList
      })
      reporter.start()
      await vi.advanceTimersByTimeAsync(UPLINK_RESEND_MS)
      expect(sent).toEqual(['metered', 'metered'])
      expect(getPluginsList).not.toHaveBeenCalled()
      reporter.stop()
    })

    it('sends no state at once when signalk-internet is not enabled', async () => {
      const reporter = new UplinkReporter({
        app: serverWith(undefined).app,
        target: () => target,
        getPluginsList: vi.fn(() => Promise.resolve([]))
      })
      reporter.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(sent).toEqual([null])
      reporter.stop()
    })

    it('sends no state at once when the plugin list cannot be read', async () => {
      const reporter = new UplinkReporter({
        app: serverWith(undefined).app,
        target: () => target,
        getPluginsList: vi.fn(() => Promise.reject(new Error('not ready')))
      })
      reporter.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(sent).toEqual([null])
      reporter.stop()
    })

    it('waits for an enabled signalk-internet to publish its first state', async () => {
      const { app, publish } = serverWith(undefined)
      const reporter = new UplinkReporter({
        app,
        target: () => target,
        getPluginsList: pluginsList(true)
      })
      reporter.start()
      await vi.advanceTimersByTimeAsync(FIRST_STATE_WAIT_MS / 2)
      expect(sent).toEqual([])

      publish('metered')
      await vi.advanceTimersByTimeAsync(0)
      expect(sent).toEqual(['metered'])
      reporter.stop()
    })

    it('reports no state once the first-state wait is over', async () => {
      const getPluginsList = pluginsList(true)
      const reporter = new UplinkReporter({
        app: serverWith(undefined).app,
        target: () => target,
        getPluginsList
      })
      reporter.start()
      await vi.advanceTimersByTimeAsync(FIRST_STATE_WAIT_MS - 1)
      expect(sent).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(sent).toEqual([null])

      // Past the wait the plugin list is not asked again.
      const asked = getPluginsList.mock.calls.length
      await vi.advanceTimersByTimeAsync(UPLINK_RESEND_MS)
      expect(sent).toEqual([null, null])
      expect(getPluginsList).toHaveBeenCalledTimes(asked)
      reporter.stop()
    })

    it('keeps the last state while a restarted signalk-internet works out the link', async () => {
      const { app, publish } = serverWith('metered')
      const reporter = new UplinkReporter({
        app,
        target: () => target,
        getPluginsList: pluginsList(true)
      })
      reporter.start()
      // Past the wait after start, so only the restart's own wait holds the report.
      await vi.advanceTimersByTimeAsync(FIRST_STATE_WAIT_MS)
      publish(null)
      await vi.advanceTimersByTimeAsync(FIRST_STATE_WAIT_MS / 2)
      expect(sent).toEqual(['metered'])

      publish('online')
      await vi.advanceTimersByTimeAsync(0)
      expect(sent).toEqual(['metered', 'online'])
      reporter.stop()
    })

    it('sends no state at once when a disabled signalk-internet clears it', async () => {
      const { app, publish } = serverWith('metered')
      const reporter = new UplinkReporter({
        app,
        target: () => target,
        getPluginsList: pluginsList(false)
      })
      reporter.start()
      await vi.advanceTimersByTimeAsync(0)
      publish(null)
      await vi.advanceTimersByTimeAsync(0)
      expect(sent).toEqual(['metered', null])
      reporter.stop()
    })
  })
})
