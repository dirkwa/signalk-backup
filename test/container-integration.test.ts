import { describe, it, expect } from 'vitest'
import { SCHEMA_DEFAULTS, Config } from '../src/config/schema'

/**
 * Regression tests for the schema-defaults merge in start().
 *
 * Signal K only uses the schema's `default` annotations to seed the
 * Admin UI form — it does NOT inject defaults into the runtime config
 * passed to plugin.start(). When the plugin is auto-enabled via
 * `signalk-plugin-enabled-by-default: true`, start() receives `{}`.
 *
 * If we forget the `{ ...SCHEMA_DEFAULTS, ...config }` merge in start(),
 * `settings.managedContainer` is undefined, the container-startup branch
 * is skipped, and the plugin sits idle. These tests guard against that.
 */
describe('SCHEMA_DEFAULTS merge', () => {
  it('merging empty config yields a complete Config', () => {
    const config: Partial<Config> = {}
    const merged: Config = { ...SCHEMA_DEFAULTS, ...config }
    expect(merged.managedContainer).toBe(true)
    expect(merged.imageTag).toBe('latest')
    expect(merged.logLevel).toBe('info')
    expect(merged.externalUrl).toBe('')
  })

  it('user-supplied fields override defaults', () => {
    const config: Partial<Config> = {
      managedContainer: false,
      externalUrl: 'http://server:3001',
      logLevel: 'debug'
    }
    const merged: Config = { ...SCHEMA_DEFAULTS, ...config }
    expect(merged.managedContainer).toBe(false)
    expect(merged.externalUrl).toBe('http://server:3001')
    expect(merged.logLevel).toBe('debug')
    expect(merged.imageTag).toBe('latest') // unchanged from defaults
  })

  it('SCHEMA_DEFAULTS is itself a valid Config (defends against renames)', () => {
    const merged: Config = { ...SCHEMA_DEFAULTS }
    expect(typeof merged.managedContainer).toBe('boolean')
    expect(typeof merged.imageTag).toBe('string')
    expect(typeof merged.externalUrl).toBe('string')
    expect(typeof merged.logLevel).toBe('string')
  })
})
