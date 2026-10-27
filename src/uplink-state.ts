import type { Context, Delta, Path } from '@signalk/server-api'
import type { BackupServerAPI } from './types.js'

// The values signalk-internet publishes at network.internet.state; anything else is unknown.
export type UplinkState = 'online' | 'metered' | 'captive' | 'offline' | null

const UPLINK_PATH = 'network.internet.state'
const KNOWN_STATES: ReadonlySet<string> = new Set(['online', 'metered', 'captive', 'offline'])
export const SIGNALK_INTERNET_PLUGIN_ID = 'signalk-internet'

// The backup server keeps the state in memory only, and after a restart waits up to three minutes for it; re-sending it this often covers a restart the plugin did not see.
export const UPLINK_RESEND_MS = 2 * 60_000
// How long a start, or a restart of signalk-internet, waits for an enabled signalk-internet's state before reporting none.
export const FIRST_STATE_WAIT_MS = 60_000

/** One of the states the backup server knows, or null for anything else: no value, a cleared state, or a value from a newer signalk-internet. */
export function toUplinkState(value: unknown): UplinkState {
  return typeof value === 'string' && KNOWN_STATES.has(value) ? (value as UplinkState) : null
}

export interface PluginListEntry {
  id: string
  enabled: boolean
}

// Signal K's app.getPluginsList, which @signalk/server-api does not declare.
export type GetPluginsList = () => Promise<PluginListEntry[]>

export interface UplinkReporterOptions {
  app: Pick<BackupServerAPI, 'subscriptionmanager' | 'debug'>
  // Null while no backup server is connected.
  target: () => { putUplinkState(state: UplinkState): Promise<void> } | null
  // Without it a missing state is never waited for.
  getPluginsList?: GetPluginsList
}

// Tells the backup server what signalk-internet says about the link, so its automatic cloud syncs wait while the link is metered or down.
// The state comes from one subscription, from start() to stop(); the server sends the last value when it starts.
// A published state is believed without asking the plugin list: signalk-internet publishes null when it is disabled. Releases up to 0.7.1 do not, and their last state stays until Signal K restarts.
export class UplinkReporter {
  private resendTimer: NodeJS.Timeout | null = null
  // Set while a missing state is waited for: from start(), and again from the null signalk-internet publishes when it stops.
  private waitTimer: NodeJS.Timeout | null = null
  private unsubscribes: Array<() => void> = []
  // signalk-internet's last value since start(); undefined before the first.
  private value: unknown = undefined
  private last: { target: object; state: UplinkState } | null = null
  private sending = false
  // A report asked for while one was in flight; it runs once that one settles.
  private queued = false
  // Bumped by stop(), so a send still in flight cannot restore what stop() cleared.
  private generation = 0

  constructor(private readonly opts: UplinkReporterOptions) {}

  /** Subscribes to the state and reports it; calling it again first undoes the previous start. */
  start(): void {
    this.stop()
    this.startWait()
    this.resendTimer = setInterval(() => {
      this.last = null
      void this.report()
    }, UPLINK_RESEND_MS)
    this.opts.app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self' as Context,
        subscribe: [{ path: UPLINK_PATH as Path, policy: 'instant' }]
      },
      this.unsubscribes,
      (err) => {
        this.opts.app.debug(
          `Internet link state subscription: ${err instanceof Error ? err.message : String(err)}`
        )
      },
      (delta) => {
        this.onDelta(delta)
      }
    )
    void this.report()
  }

  /** Unsubscribes and forgets the last report, so the next start() reports to the server again. */
  stop(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    if (this.resendTimer) clearInterval(this.resendTimer)
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.resendTimer = null
    this.waitTimer = null
    this.value = undefined
    this.last = null
    this.generation++
  }

  /** Sends the current state unless the target already has it. One send runs at a time; a call during a send runs once after it. */
  async report(): Promise<void> {
    if (this.sending) {
      this.queued = true
      return
    }
    const target = this.opts.target()
    if (!target) return
    this.sending = true
    try {
      await this.send(target)
    } finally {
      this.sending = false
    }
    if (this.queued) {
      this.queued = false
      await this.report()
    }
  }

  /** The state to report, or 'waiting' while an enabled signalk-internet has not given one since start() or its own restart. */
  async currentState(): Promise<UplinkState | 'waiting'> {
    const state = toUplinkState(this.value)
    if (state !== null || !this.waiting()) return state
    // Asked now rather than at start: the server adds a plugin to its list only after starting it.
    if (!(await this.publisherEnabled())) return null
    return toUplinkState(this.value) ?? (this.waiting() ? 'waiting' : null)
  }

  /** Takes the state from a delta; a null (signalk-internet stopped) starts a new wait. */
  private onDelta(delta: Delta): void {
    for (const update of delta.updates) {
      if (!('values' in update)) continue
      for (const pv of update.values) {
        if (pv.path !== UPLINK_PATH) continue
        this.value = pv.value
        if (pv.value === null) this.startWait()
      }
    }
    void this.report()
  }

  /** A null sent before signalk-internet's first probe would end the server's startup hold on syncs, or lift a metered hold while signalk-internet restarts; so nothing is sent until a state comes or the wait is over. */
  private startWait(): void {
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null
      void this.report()
    }, FIRST_STATE_WAIT_MS)
  }

  /** True for FIRST_STATE_WAIT_MS after start() and after each null; a state that arrives meanwhile is reported anyway. */
  private waiting(): boolean {
    return this.waitTimer !== null
  }

  /** One report to the target; a send that stop() overtook does not record what it sent. */
  private async send(
    target: NonNullable<ReturnType<UplinkReporterOptions['target']>>
  ): Promise<void> {
    const generation = this.generation
    const state = await this.currentState()
    // The state arriving, or the wait ending, reports again.
    if (state === 'waiting') return
    const last = this.last
    if (last && last.target === target && last.state === state) return
    try {
      await target.putUplinkState(state)
      if (generation === this.generation) this.last = { target, state }
    } catch (err) {
      // A backup server older than the uplink endpoint answers 404; it simply keeps syncing as before.
      this.opts.app.debug(
        `Could not report internet link state: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /** Whether signalk-internet is installed and enabled; false when the server cannot list its plugins. */
  private async publisherEnabled(): Promise<boolean> {
    if (!this.opts.getPluginsList) return false
    try {
      const plugins = await this.opts.getPluginsList()
      return plugins.some((p) => p.id === SIGNALK_INTERNET_PLUGIN_ID && p.enabled)
    } catch {
      return false
    }
  }
}
