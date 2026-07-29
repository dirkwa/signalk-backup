import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAllExports } from '../src/database-export/index.js'

// Exporters are constructed internally, so global fetch is the only seam; an
// unreachable base URL reproduces #90 exactly.
describe('runAllExports', () => {
  let dir: string
  const realFetch = globalThis.fetch

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sk-backup-orch-'))
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    await rm(dir, { recursive: true, force: true })
  })

  it('warns operator-visibly when an enabled exporter fails detect', async () => {
    globalThis.fetch = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3000'))

    const warnings: string[] = []
    const results = await runAllExports({
      signalkConfigRoot: dir,
      signalkBaseUrl: 'http://127.0.0.1:3000',
      warn: (m) => warnings.push(m),
      enabled: { questdb: true }
    })

    expect(results).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('signalk-questdb')
    expect(warnings[0]).toContain('http://127.0.0.1:3000')
  })

  it('stays silent about exporters the user did not enable', async () => {
    globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'))

    const warnings: string[] = []
    await runAllExports({
      signalkConfigRoot: dir,
      signalkBaseUrl: 'http://127.0.0.1:3000',
      warn: (m) => warnings.push(m),
      enabled: {}
    })

    expect(warnings).toEqual([])
  })

  it('reports every unreachable exporter, not just the first', async () => {
    globalThis.fetch = () => {
      throw new Error('kaboom')
    }

    const warnings: string[] = []
    const results = await runAllExports({
      signalkConfigRoot: dir,
      signalkBaseUrl: 'http://127.0.0.1:3000',
      warn: (m) => warnings.push(m),
      enabled: { questdb: true, grafana: true, signalkDatabase: true }
    })

    expect(results).toEqual([])
    expect(warnings).toHaveLength(3)
    const joined = warnings.join('\n')
    expect(joined).toContain('signalk-questdb')
    expect(joined).toContain('signalk-grafana')
    expect(joined).toContain('signalk-database')
  })
})
