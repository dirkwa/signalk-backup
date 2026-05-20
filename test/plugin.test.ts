import { describe, it, expect } from 'vitest'
import { ConfigSchema, SCHEMA_DEFAULTS } from '../src/config/schema.js'
import { Value } from '@sinclair/typebox/value'

describe('config schema', () => {
  it('SCHEMA_DEFAULTS is a valid Config', () => {
    expect(Value.Check(ConfigSchema, SCHEMA_DEFAULTS)).toBe(true)
  })

  it('default imageTag is "auto" so it tracks the plugin version', () => {
    expect(SCHEMA_DEFAULTS.imageTag).toBe('auto')
  })

  it('databaseExport is off-schema (webapp Settings tab owns the UI; runtime route enforces ranges)', () => {
    // The schema doesn't describe databaseExport so it can't reject
    // out-of-range intervalMinutes — that check moved to the
    // /api/db-export/config POST handler. The schema should accept
    // anything in the databaseExport slot now.
    expect(
      Value.Check(ConfigSchema, {
        ...SCHEMA_DEFAULTS,
        databaseExport: { questdb: false, intervalMinutes: 1 }
      })
    ).toBe(true)
    expect(
      Value.Check(ConfigSchema, {
        ...SCHEMA_DEFAULTS,
        databaseExport: { questdb: false, intervalMinutes: 9999 }
      })
    ).toBe(true)
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
