import { buildVersionSource } from 'signalk-container-helper'
import { ContainerManagerApi } from '../types.js'
import { BACKUP_SERVER_REPO, compareSemver, isConcreteSemver } from './image-tag.js'

// Shorter than the source's own 10s: boats boot without internet routinely.
const DEFAULT_TIMEOUT_MS = 5000

export interface ResolveAutoTagOptions {
  manager: ContainerManagerApi | undefined
  persisted: string
  floor: string
  timeoutMs?: number
  debug: (msg: string) => void
}

// Prefers the persisted tag (no network, so repeat boots reuse one image), then the
// newest release, then the floor. Never returns a floating tag.
export async function resolveAutoTag(opts: ResolveAutoTagOptions): Promise<string> {
  const { persisted, floor, debug } = opts

  if (isConcreteSemver(persisted) && compareSemver(persisted, floor) >= 0) {
    debug(`auto: using persisted tag ${persisted}`)
    return persisted
  }

  const latest = await fetchLatestRelease(opts)
  if (latest === null) return floor

  if (!isConcreteSemver(latest)) {
    debug(`auto: ignoring non-semver release "${latest}", using ${floor}`)
    return floor
  }
  // An API blip or re-tagged old release must not downgrade a running boat.
  if (compareSemver(latest, floor) < 0) {
    debug(`auto: release ${latest} is older than floor ${floor}, using ${floor}`)
    return floor
  }

  debug(`auto: resolved to ${latest}`)
  return latest
}

// Null when unavailable for any reason; never throws.
async function fetchLatestRelease(opts: ResolveAutoTagOptions): Promise<string | null> {
  const { manager, floor, debug } = opts
  if (!manager) {
    debug(`auto: container manager unavailable, using ${floor}`)
    return null
  }

  const runtime = manager.getRuntime()
  if (!runtime) {
    debug(`auto: container runtime not ready, using ${floor}`)
    return null
  }

  let timer: NodeJS.Timeout | undefined
  try {
    const source = buildVersionSource(manager.updates, { githubReleases: BACKUP_SERVER_REPO })
    // Cleared in `finally`, never unref'd: unref lets an idle loop exit before this resolves.
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null)
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })
    const result = await Promise.race([source.fetch(runtime), timeout])

    if (result === null) {
      debug(`auto: release lookup timed out, using ${floor}`)
      return null
    }
    if (result.kind !== 'version') {
      const detail = result.kind === 'error' ? result.error : `unexpected result "${result.kind}"`
      debug(`auto: release lookup failed (${detail}), using ${floor}`)
      return null
    }
    return result.latest
  } catch (err) {
    debug(
      `auto: release lookup threw (${err instanceof Error ? err.message : String(err)}), using ${floor}`
    )
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
