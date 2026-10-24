import type { BackupServerAPI } from './types.js'

// The values signalk-internet publishes at network.internet.state; anything else is unknown.
export type UplinkState = 'online' | 'metered' | 'captive' | 'offline' | null

const UPLINK_PATH = 'network.internet.state'
const KNOWN_STATES: ReadonlySet<string> = new Set(['online', 'metered', 'captive', 'offline'])
export const SIGNALK_INTERNET_PLUGIN_ID = 'signalk-internet'

// The backup server keeps the state in memory only, and after a restart waits up to three minutes for it; re-sending it at this age covers a restart the plugin did not see.
export const UPLINK_RESEND_MS = 2 * 60_000
export const UPLINK_POLL_MS = 60_000
// How long a start waits for an enabled signalk-internet's first state before reporting none.
export const FIRST_STATE_WAIT_MS = 60_000
export const FIRST_STATE_POLL_MS = 1_000

export function readUplinkState(app: Pick<BackupServerAPI, 'getSelfPath'>): UplinkState {
  const node = app.getSelfPath(UPLINK_PATH)
  const value = node !== null && typeof node === 'object' && 'value' in node ? node.value : node
  return typeof value === 'string' && KNOWN_STATES.has(value) ? (value as UplinkState) : null
}

export interface PluginListEntry {
  id: string
  enabled: boolean
}

// Signal K's app.getPluginsList, which @signalk/server-api does not declare.
export type GetPluginsList = () => Promise<PluginListEntry[]>

export interface UplinkReporterOptions {
  app: Pick<BackupServerAPI, 'getSelfPath' | 'debug'>
  // Null while no backup server is connected.
  target: () => { putUplinkState(state: UplinkState): Promise<void> } | null
  // Without it a published state is always believed.
  getPluginsList?: GetPluginsList
  now?: () => number
}

// Tells the backup server what signalk-internet says about the link, so its automatic cloud syncs wait while the link is metered or down.
export class UplinkReporter {
  private timer: NodeJS.Timeout | null = null
  private firstStateRetry: NodeJS.Timeout | null = null
  private startedAt = -Infinity
  private last: { target: object; state: UplinkState; at: number } | null = null
  private sending = false
  // A report asked for while one was in flight; it runs once that one settles.
  private queued = false
  // Bumped by stop(), so a send still in flight cannot restore what stop() cleared.
  private generation = 0

  constructor(private readonly opts: UplinkReporterOptions) {}

  start(): void {
    this.stop()
    this.startedAt = this.now()
    this.timer = setInterval(() => void this.report(), UPLINK_POLL_MS)
    void this.report()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.firstStateRetry) clearTimeout(this.firstStateRetry)
    this.timer = null
    this.firstStateRetry = null
    this.last = null
    this.generation++
  }

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

  private async send(
    target: NonNullable<ReturnType<UplinkReporterOptions['target']>>
  ): Promise<void> {
    const generation = this.generation
    const state = await this.currentState()
    if (state === 'waiting') {
      if (generation !== this.generation) return
      this.firstStateRetry ??= setTimeout(() => {
        this.firstStateRetry = null
        void this.report()
      }, FIRST_STATE_POLL_MS)
      return
    }
    const now = this.now()
    const last = this.last
    if (
      last &&
      last.target === target &&
      last.state === state &&
      now - last.at < UPLINK_RESEND_MS
    ) {
      return
    }
    try {
      await target.putUplinkState(state)
      if (generation === this.generation) this.last = { target, state, at: now }
    } catch (err) {
      // A backup server older than the uplink endpoint answers 404; it simply keeps syncing as before.
      this.opts.app.debug(
        `Could not report internet link state: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // The state stays in the data model after signalk-internet is disabled or removed, so it is believed only while that plugin is enabled.
  private async currentState(): Promise<UplinkState | 'waiting'> {
    const state = readUplinkState(this.opts.app)
    const publisherEnabled = await this.publisherEnabled()
    if (publisherEnabled === false) return null
    if (
      publisherEnabled === true &&
      state === null &&
      this.now() - this.startedAt < FIRST_STATE_WAIT_MS
    ) {
      return 'waiting'
    }
    return state
  }

  // Undefined when the server cannot tell.
  private async publisherEnabled(): Promise<boolean | undefined> {
    if (!this.opts.getPluginsList) return undefined
    try {
      const plugins = await this.opts.getPluginsList()
      return plugins.some((p) => p.id === SIGNALK_INTERNET_PLUGIN_ID && p.enabled)
    } catch {
      return undefined
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }
}
