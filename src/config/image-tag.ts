// The signalk-backup-server image version that "auto" resolves to.
// Bump this when a new signalk-backup-server release is published to ghcr.io.
// Independent of signalk-backup's own package.json version — the two repos
// release on independent cadences. See AGENTS.md "Gotchas" for rationale.
export const BACKUP_SERVER_VERSION = '0.6.6'

export function resolveImageTag(tag: string): string {
  return tag === 'auto' ? BACKUP_SERVER_VERSION : tag
}
