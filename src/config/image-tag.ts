import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The backup-server image is published in lockstep with this plugin
// (CI tags `vX.Y.Z` produce `ghcr.io/.../signalk-backup-server:X.Y.Z`),
// so reading our own package.json version is the authoritative source
// for the "auto" tag.
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
