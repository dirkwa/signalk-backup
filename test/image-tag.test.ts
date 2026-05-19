import { describe, it, expect } from 'vitest'
import { PLUGIN_VERSION, resolveImageTag } from '../src/config/image-tag.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('resolveImageTag', () => {
  it('PLUGIN_VERSION matches package.json version', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }
    expect(PLUGIN_VERSION).toBe(pkg.version)
  })

  it('"auto" resolves to the plugin version', () => {
    expect(resolveImageTag('auto')).toBe(PLUGIN_VERSION)
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
