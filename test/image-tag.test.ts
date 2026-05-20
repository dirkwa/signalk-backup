import { describe, it, expect } from 'vitest'
import { BACKUP_SERVER_VERSION, resolveImageTag } from '../src/config/image-tag.js'

describe('resolveImageTag', () => {
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
})
