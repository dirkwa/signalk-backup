import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveSignalkBaseUrl, type SignalKPortConfig } from '../src/signalk-base-url.js'

type Settings = NonNullable<NonNullable<SignalKPortConfig['config']>['settings']>

function app(settings: Settings): SignalKPortConfig {
  return { config: { settings } }
}

describe('resolveSignalkBaseUrl', () => {
  const saved = { PORT: process.env['PORT'], SSLPORT: process.env['SSLPORT'] }

  beforeEach(() => {
    delete process.env['PORT']
    delete process.env['SSLPORT']
  })

  afterEach(() => {
    if (saved.PORT === undefined) delete process.env['PORT']
    else process.env['PORT'] = saved.PORT
    if (saved.SSLPORT === undefined) delete process.env['SSLPORT']
    else process.env['SSLPORT'] = saved.SSLPORT
  })

  // The issue-#90 regression: port lives in settings.json, not the env.
  it('uses settings.port when PORT is unset', () => {
    expect(resolveSignalkBaseUrl(app({ port: 80 }))).toBe('http://127.0.0.1:80')
  })

  it('accepts a stringified settings.port', () => {
    expect(resolveSignalkBaseUrl(app({ port: '6543' }))).toBe('http://127.0.0.1:6543')
  })

  it('prefers process.env.PORT over settings.port', () => {
    process.env['PORT'] = '4000'
    expect(resolveSignalkBaseUrl(app({ port: 80 }))).toBe('http://127.0.0.1:4000')
  })

  it('falls back to 3000 with no env and no settings', () => {
    expect(resolveSignalkBaseUrl({})).toBe('http://127.0.0.1:3000')
    expect(resolveSignalkBaseUrl(app({}))).toBe('http://127.0.0.1:3000')
  })

  it('uses https on the ssl port when ssl is enabled', () => {
    expect(resolveSignalkBaseUrl(app({ ssl: true, sslport: 443, port: 80 }))).toBe(
      'https://127.0.0.1:443'
    )
  })

  it('defaults the ssl port to 3443', () => {
    expect(resolveSignalkBaseUrl(app({ ssl: true }))).toBe('https://127.0.0.1:3443')
  })

  it('prefers process.env.SSLPORT when ssl is enabled', () => {
    process.env['SSLPORT'] = '8443'
    expect(resolveSignalkBaseUrl(app({ ssl: true, sslport: 443 }))).toBe('https://127.0.0.1:8443')
  })

  it('ignores ssl when it is not exactly true', () => {
    expect(resolveSignalkBaseUrl(app({ ssl: false, port: 80, sslport: 443 }))).toBe(
      'http://127.0.0.1:80'
    )
  })

  it('skips unusable port values and falls through', () => {
    expect(resolveSignalkBaseUrl(app({ port: 0 }))).toBe('http://127.0.0.1:3000')
    expect(resolveSignalkBaseUrl(app({ port: '' }))).toBe('http://127.0.0.1:3000')
    expect(resolveSignalkBaseUrl(app({ port: 'not-a-port' }))).toBe('http://127.0.0.1:3000')
    expect(resolveSignalkBaseUrl(app({ port: 1.5 }))).toBe('http://127.0.0.1:3000')
    expect(resolveSignalkBaseUrl(app({ port: 65536 }))).toBe('http://127.0.0.1:3000')
    expect(resolveSignalkBaseUrl(app({ port: -80 }))).toBe('http://127.0.0.1:3000')
  })

  it('ignores a blank PORT env and uses settings.port', () => {
    process.env['PORT'] = ''
    expect(resolveSignalkBaseUrl(app({ port: 80 }))).toBe('http://127.0.0.1:80')
  })

  it('never emits a trailing slash', () => {
    expect(resolveSignalkBaseUrl(app({ port: 80 }))).not.toMatch(/\/$/)
  })
})
