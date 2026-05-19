import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// CI publishes signalk-backup-server:X.Y.Z in lockstep with this plugin's package.json version.
export const PLUGIN_VERSION = (() => {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
  const raw = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown }
  if (typeof raw.version !== 'string') {
    throw new Error('signalk-backup package.json has no version field')
  }
  return raw.version
})()

// 'auto' resolves to PLUGIN_VERSION so the container tracks plugin upgrades; other tags pass through.
export function resolveImageTag(tag: string): string {
  return tag === 'auto' ? PLUGIN_VERSION : tag
}
