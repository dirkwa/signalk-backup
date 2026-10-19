import { compareSemver, isConcreteSemver } from './config/image-tag.js'
import { errMsg } from './errors.js'

// Returns the release "auto" should move to, or null to stay. Only a newer
// final release of the running major qualifies: a prerelease is opt-in, and a
// new major is a breaking server change that needs a plugin release first.
export function pickServerUpdate(
  current: string,
  latest: string | null | undefined,
  failed: ReadonlySet<string>
): string | null {
  if (!latest || !isConcreteSemver(latest) || latest.includes('-')) return null
  if (!isConcreteSemver(current) || compareSemver(latest, current) <= 0) return null
  if (majorOf(latest) !== majorOf(current)) return null
  if (failed.has(latest)) return null
  return latest
}

function majorOf(tag: string): number {
  return Number(tag.split('.')[0])
}

export interface ServerInstallSteps {
  /** Recreate the container on `tag`, whose image is already pulled. */
  swap: (tag: string) => Promise<void>
  /** Resolve once the recreated server answers /api/health; reject when it does not. */
  waitReady: () => Promise<void>
}

// Recreating removes the old container before the new one starts, so a
// release that will not come up must not leave the boat without backups:
// on any failure after the swap, the previous version is put back.
export async function installServerVersion(
  target: string,
  previous: string,
  steps: ServerInstallSteps
): Promise<void> {
  try {
    await steps.swap(target)
    await steps.waitReady()
  } catch (err) {
    try {
      await steps.swap(previous)
      await steps.waitReady()
    } catch (rollbackErr) {
      throw new Error(
        `backup server ${target} did not start (${errMsg(err)}), and ${previous} did not come back either`,
        { cause: rollbackErr }
      )
    }
    // errMsg appends the cause, so the reason is not repeated in the message.
    throw new Error(`backup server ${target} did not start, back on ${previous}`, { cause: err })
  }
}
