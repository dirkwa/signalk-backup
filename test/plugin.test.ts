import { describe, it, expect } from 'vitest'
import { ConfigSchema, SCHEMA_DEFAULTS } from '../src/config/schema.js'
import { Value } from '@sinclair/typebox/value'

describe('config schema', () => {
  it('SCHEMA_DEFAULTS is a valid Config', () => {
    expect(Value.Check(ConfigSchema, SCHEMA_DEFAULTS)).toBe(true)
  })

  it('rejects out-of-range databaseExport.intervalMinutes', () => {
    expect(
      Value.Check(ConfigSchema, {
        ...SCHEMA_DEFAULTS,
        databaseExport: { questdb: false, intervalMinutes: 1 }
      })
    ).toBe(false)
    expect(
      Value.Check(ConfigSchema, {
        ...SCHEMA_DEFAULTS,
        databaseExport: { questdb: false, intervalMinutes: 9999 }
      })
    ).toBe(false)
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
