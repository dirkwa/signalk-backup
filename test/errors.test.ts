import { describe, it, expect } from 'vitest'
import { errMsg } from '../src/errors.js'

describe('errMsg', () => {
  it('renders a plain Error message', () => {
    expect(errMsg(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error values', () => {
    expect(errMsg('boom')).toBe('boom')
    expect(errMsg(42)).toBe('42')
  })

  it('unwraps the undici fetch-failed shape', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3010'), {
      code: 'ECONNREFUSED'
    })
    const err = new TypeError('fetch failed', { cause })
    expect(errMsg(err)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:3010')
  })

  it('flattens a Happy-Eyeballs AggregateError cause', () => {
    const agg = new AggregateError([
      new Error('connect ECONNREFUSED 127.0.0.1:3010'),
      new Error('connect ECONNREFUSED ::1:3010')
    ])
    const err = new TypeError('fetch failed', { cause: agg })
    expect(errMsg(err)).toBe(
      'fetch failed: connect ECONNREFUSED 127.0.0.1:3010; connect ECONNREFUSED ::1:3010'
    )
  })

  it('keeps an AggregateError message when it carries one', () => {
    const agg = new AggregateError([new Error('a'), new Error('b')], 'both probes failed')
    expect(errMsg(agg)).toBe('both probes failed: a; b')
  })

  it('renders non-Error causes', () => {
    expect(errMsg(new Error('write failed', { cause: 'disk full' }))).toBe(
      'write failed: disk full'
    )
  })

  it('ignores a null cause', () => {
    expect(errMsg(new Error('boom', { cause: null }))).toBe('boom')
  })

  it('caps recursion into nested AggregateErrors', () => {
    let agg = new AggregateError([new Error('leaf')], 'level-6')
    for (let i = 5; i >= 0; i--) {
      agg = new AggregateError([agg], `level-${i}`)
    }
    const rendered = errMsg(agg)
    expect(rendered).toContain('level-0')
    expect(rendered).toContain('level-4')
    expect(rendered).not.toContain('leaf')
  })

  it('survives a cyclic AggregateError', () => {
    // AggregateError snapshots its errors at construction — a genuine cycle needs the own-property override.
    const agg = new AggregateError([], 'cycle')
    Object.defineProperty(agg, 'errors', { value: [agg] })
    expect(errMsg(agg)).toContain('cycle')
  })

  it('caps the cause chain depth', () => {
    let err = new Error('level-6')
    for (let i = 5; i >= 0; i--) {
      err = new Error(`level-${i}`, { cause: err })
    }
    const rendered = errMsg(err)
    expect(rendered).toContain('level-0')
    expect(rendered).toContain('level-4')
    expect(rendered).not.toContain('level-5')
  })
})
