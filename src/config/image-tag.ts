// Offline floor for "auto", not the target — never couple it to this plugin's own version. See AGENTS.md.
export const BACKUP_SERVER_VERSION = '1.0.0'

// Shared by the startup resolver and the update registration so the two cannot drift.
export const BACKUP_SERVER_REPO = 'dirkwa/signalk-backup-server'

// Rejects floating tags: signalk-container treats them as non-semver and pulls the image on every update check.
const NUM = '0|[1-9]\\d*'
const PRE_ID = `(?:${NUM}|\\d*[a-zA-Z-][a-zA-Z0-9-]*)`
const SEMVER_PATTERN = new RegExp(
  `^(?:${NUM})\\.(?:${NUM})\\.(?:${NUM})(?:-${PRE_ID}(?:\\.${PRE_ID})*)?$`
)

export function isConcreteSemver(tag: string): boolean {
  return SEMVER_PATTERN.test(tag)
}

// Returns <0, 0 or >0. Both arguments must satisfy isConcreteSemver.
export function compareSemver(a: string, b: string): number {
  const [aCore, aPre] = splitPrerelease(a)
  const [bCore, bPre] = splitPrerelease(b)
  for (let i = 0; i < 3; i++) {
    const diff = (aCore[i] ?? 0) - (bCore[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (aPre === bPre) return 0
  if (aPre === null) return 1
  if (bPre === null) return -1
  return comparePrerelease(aPre, bPre)
}

// Numeric identifiers compare numerically (beta.2 < beta.11, which a string compare gets backwards).
function comparePrerelease(a: string, b: string): number {
  const aParts = a.split('.')
  const bParts = b.split('.')
  const len = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < len; i++) {
    const x = aParts[i]
    const y = bParts[i]
    // A shorter identifier set has lower precedence when all else is equal.
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) return Number(x) - Number(y)
    if (xNum) return -1
    if (yNum) return 1
    return x < y ? -1 : 1
  }
  return 0
}

function splitPrerelease(tag: string): [number[], string | null] {
  const dash = tag.indexOf('-')
  const core = dash === -1 ? tag : tag.slice(0, dash)
  const pre = dash === -1 ? null : tag.slice(dash + 1)
  return [core.split('.').map(Number), pre]
}

// `override` applies only to "auto": a user-pinned tag is never hijacked by a live lookup.
export function resolveImageTag(tag: string, override?: string | null): string {
  if (tag !== 'auto') return tag
  return override && isConcreteSemver(override) ? override : BACKUP_SERVER_VERSION
}
