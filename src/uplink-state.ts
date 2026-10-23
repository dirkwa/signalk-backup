import type { BackupServerAPI } from './types.js'

// The values signalk-internet publishes at network.internet.state; anything else is unknown.
export type UplinkState = 'online' | 'metered' | 'captive' | 'offline' | null

const UPLINK_PATH = 'network.internet.state'
const KNOWN_STATES: ReadonlySet<string> = new Set(['online', 'metered', 'captive', 'offline'])

// The backup server keeps the state in memory only; re-sending it at this age covers a server restart the plugin did not see.
export const UPLINK_RESEND_MS = 15 * 60_000
export const UPLINK_POLL_MS = 60_000

export function readUplinkState(app: Pick<BackupServerAPI, 'getSelfPath'>): UplinkState {
  const node = app.getSelfPath(UPLINK_PATH)
  const value = node !== null && typeof node === 'object' && 'value' in node ? node.value : node
  return typeof value === 'string' && KNOWN_STATES.has(value) ? (value as UplinkState) : null
}

export interface UplinkReporterOptions {
  app: Pick<BackupServerAPI, 'getSelfPath' | 'debug'>
  // Null while no backup server is connected.
  target: () => { putUplinkState(state: UplinkState): Promise<void> } | null
  now?: () => number
}

// Tells the backup server what signalk-internet says about the link, so its automatic cloud syncs wait while the link is metered or down.
export class UplinkReporter {
  private timer: NodeJS.Timeout | null = null
  private last: { target: object; state: UplinkState; at: number } | null = null
  private sending = false
  // A report asked for while one was in flight; it runs once that one settles.
  private queued = false
  // Bumped by stop(), so a send still in flight cannot restore what stop() cleared.
  private generation = 0

  constructor(private readonly opts: UplinkReporterOptions) {}

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.report(), UPLINK_POLL_MS)
    void this.report()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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
    const state = readUplinkState(this.opts.app)
    const now = (this.opts.now ?? Date.now)()
    const last = this.last
    if (
      last &&
      last.target === target &&
      last.state === state &&
      now - last.at < UPLINK_RESEND_MS
    ) {
      return
    }
    const generation = this.generation
    this.sending = true
    try {
      await target.putUplinkState(state)
      if (generation === this.generation) this.last = { target, state, at: now }
    } catch (err) {
      // A backup server older than the uplink endpoint answers 404; it simply keeps syncing as before.
      this.opts.app.debug(
        `Could not report internet link state: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      this.sending = false
    }
    if (this.queued) {
      this.queued = false
      await this.report()
    }
  }
}
