import { describe, it, expect } from 'vitest'
import { ConfigSchema, SCHEMA_DEFAULTS } from '../src/config/schema.js'
import { Value } from '@sinclair/typebox/value'

describe('config schema', () => {
  it('SCHEMA_DEFAULTS is a valid Config', () => {
    expect(Value.Check(ConfigSchema, SCHEMA_DEFAULTS)).toBe(true)
  })

  it('rejects invalid log level', () => {
    expect(Value.Check(ConfigSchema, { ...SCHEMA_DEFAULTS, logLevel: 'verbose' as never })).toBe(
      false
    )
  })

  it('accepts a config with externalUrl set when managedContainer is false', () => {
    const cfg = {
      ...SCHEMA_DEFAULTS,
      managedContainer: false,
      externalUrl: 'http://192.168.1.50:3001'
    }
    expect(Value.Check(ConfigSchema, cfg)).toBe(true)
  })
})
