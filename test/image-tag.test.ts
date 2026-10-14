import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  BACKUP_SERVER_VERSION,
  SERVER_PIN_FILE,
  compareSemver,
  isConcreteSemver,
  parseServerPin,
  resolveImageTag
} from '../src/config/image-tag.js'

describe('resolveImageTag', () => {
  // The floor is the version an offline or first-boot "auto" install gets, and
  // it gates the persisted tag — a boat on the previous version stays there
  // until the floor passes it. Dependabot bumps it in server-image/Dockerfile.
  it('floors "auto" at the server version pinned in server-image/Dockerfile', () => {
    const pin = readFileSync(SERVER_PIN_FILE, 'utf8')
    expect(pin).toContain(`FROM ghcr.io/dirkwa/signalk-backup-server:${BACKUP_SERVER_VERSION}\n`)
  })

  it('reads the pin from the FROM line and rejects a floating or missing tag', () => {
    expect(parseServerPin('# comment\nFROM ghcr.io/dirkwa/signalk-backup-server:1.2.3\n')).toBe(
      '1.2.3'
    )
    expect(() => parseServerPin('FROM ghcr.io/dirkwa/signalk-backup-server:latest\n')).toThrow()
    expect(() => parseServerPin('FROM ghcr.io/dirkwa/other:1.2.3\n')).toThrow()
  })

  it('"auto" resolves to BACKUP_SERVER_VERSION', () => {
    expect(resolveImageTag('auto')).toBe(BACKUP_SERVER_VERSION)
  })

  it('BACKUP_SERVER_VERSION is a semver string', () => {
    expect(BACKUP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
  })

  it('legacy "latest" is passed through verbatim', () => {
    expect(resolveImageTag('latest')).toBe('latest')
  })

  it('user-pinned semver is passed through verbatim', () => {
    expect(resolveImageTag('0.3.0')).toBe('0.3.0')
    expect(resolveImageTag('1.2.3-beta.4')).toBe('1.2.3-beta.4')
  })

  it('"beta" floating tag is passed through verbatim', () => {
    expect(resolveImageTag('beta')).toBe('beta')
  })

  it('a resolved override replaces "auto"', () => {
    expect(resolveImageTag('auto', '1.2.0')).toBe('1.2.0')
  })

  it('an override never hijacks a user-pinned tag', () => {
    expect(resolveImageTag('0.4.0', '1.2.0')).toBe('0.4.0')
    expect(resolveImageTag('latest', '1.2.0')).toBe('latest')
  })

  it('a missing or non-semver override falls back to BACKUP_SERVER_VERSION', () => {
    expect(resolveImageTag('auto', null)).toBe(BACKUP_SERVER_VERSION)
    expect(resolveImageTag('auto', '')).toBe(BACKUP_SERVER_VERSION)
    expect(resolveImageTag('auto', 'latest')).toBe(BACKUP_SERVER_VERSION)
  })
})

describe('isConcreteSemver', () => {
  it('accepts concrete versions', () => {
    expect(isConcreteSemver('1.0.0')).toBe(true)
    expect(isConcreteSemver('1.2.3-beta.4')).toBe(true)
  })

  it('rejects floating and malformed tags', () => {
    // Gates the "auto" lookup only: a user-set "latest" is a valid tag and is
    // the default, it just must never be what "auto" resolves to.
    expect(isConcreteSemver('latest')).toBe(false)
    expect(isConcreteSemver('auto')).toBe(false)
    expect(isConcreteSemver('1.0')).toBe(false)
    expect(isConcreteSemver('')).toBe(false)
  })

  it('rejects malformed semver that would become a bad image tag', () => {
    expect(isConcreteSemver('1.0.0-')).toBe(false)
    expect(isConcreteSemver('1.0.0-alpha..1')).toBe(false)
    expect(isConcreteSemver('01.2.3')).toBe(false)
    expect(isConcreteSemver('1.0.0-alpha.01')).toBe(false)
  })
})

describe('compareSemver', () => {
  it('orders by numeric precedence, not string order', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareSemver('0.6.10', '1.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
  })

  it('sorts a prerelease below its release', () => {
    expect(compareSemver('1.0.0-beta.1', '1.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0)
  })

  it('compares dotted prerelease identifiers by semver precedence', () => {
    // A plain string compare gets this backwards: "2" > "11" lexically.
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.11')).toBeLessThan(0)
    expect(compareSemver('1.0.0-beta.11', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
  })

  it('ranks numeric prerelease identifiers below non-numeric ones', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    // Fewer identifiers wins when the shared prefix is equal.
    expect(compareSemver('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0)
  })
})
