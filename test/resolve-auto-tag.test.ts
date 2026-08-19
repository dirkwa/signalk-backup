import { describe, it, expect, vi } from 'vitest'
import { resolveAutoTag } from '../src/config/resolve-auto-tag.js'
import { ContainerManagerApi } from '../src/types.js'

const FLOOR = '1.0.0'

type FetchResult = unknown

function makeManager(
  fetchImpl: () => Promise<FetchResult>,
  runtime: unknown = { runtime: 'podman', version: '5.0.0' }
) {
  const fetchSpy = vi.fn(fetchImpl)
  const manager = {
    getRuntime: () => runtime,
    updates: {
      sources: { githubReleases: () => ({ fetch: fetchSpy }) }
    }
  } as unknown as ContainerManagerApi
  return { manager, fetchSpy }
}

const silent = () => {}

describe('resolveAutoTag', () => {
  it('returns the newest release when it is concrete semver above the floor', async () => {
    const { manager } = makeManager(() => Promise.resolve({ kind: 'version', latest: '1.1.0' }))
    expect(await resolveAutoTag({ manager, persisted: '', floor: FLOOR, debug: silent })).toBe(
      '1.1.0'
    )
  })

  it('falls back to the floor on a source error', async () => {
    const { manager } = makeManager(() =>
      Promise.resolve({ kind: 'error', error: 'GitHub API 503' })
    )
    expect(await resolveAutoTag({ manager, persisted: '', floor: FLOOR, debug: silent })).toBe(
      FLOOR
    )
  })

  it('falls back to the floor on an unrecognised result shape', async () => {
    // The fake manager in status-ready.test.ts resolves {} — must not throw.
    const { manager } = makeManager(() => Promise.resolve({}))
    expect(await resolveAutoTag({ manager, persisted: '', floor: FLOOR, debug: silent })).toBe(
      FLOOR
    )
  })

  it('rejects a floating tag from the source', async () => {
    // Guards the core invariant: never hand signalk-container a non-semver tag.
    const { manager } = makeManager(() => Promise.resolve({ kind: 'version', latest: 'latest' }))
    expect(await resolveAutoTag({ manager, persisted: '', floor: FLOOR, debug: silent })).toBe(
      FLOOR
    )
  })

  it('never downgrades below the floor', async () => {
    const { manager } = makeManager(() => Promise.resolve({ kind: 'version', latest: '0.5.0' }))
    expect(await resolveAutoTag({ manager, persisted: '', floor: FLOOR, debug: silent })).toBe(
      FLOOR
    )
  })

  it('falls back to the floor when the source throws', async () => {
    const { manager } = makeManager(() => Promise.reject(new Error('network down')))
    expect(await resolveAutoTag({ manager, persisted: '', floor: FLOOR, debug: silent })).toBe(
      FLOOR
    )
  })

  it('falls back to the floor when the lookup exceeds its budget', async () => {
    // Guards against unref(): an unref'd timeout never settles on an idle loop.
    const { manager } = makeManager(() => new Promise<FetchResult>(() => {}))
    const started = Date.now()
    const resolved = await resolveAutoTag({
      manager,
      persisted: '',
      floor: FLOOR,
      timeoutMs: 20,
      debug: silent
    })
    expect(resolved).toBe(FLOOR)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('falls back to the floor without a container manager', async () => {
    expect(
      await resolveAutoTag({ manager: undefined, persisted: '', floor: FLOOR, debug: silent })
    ).toBe(FLOOR)
  })

  it('falls back to the floor before the runtime is ready', async () => {
    const { manager, fetchSpy } = makeManager(
      () => Promise.resolve({ kind: 'version', latest: '1.1.0' }),
      null
    )
    expect(await resolveAutoTag({ manager, persisted: '', floor: FLOOR, debug: silent })).toBe(
      FLOOR
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses the persisted tag without any network call', async () => {
    const { manager, fetchSpy } = makeManager(() =>
      Promise.resolve({ kind: 'version', latest: '2.0.0' })
    )
    expect(await resolveAutoTag({ manager, persisted: '1.1.0', floor: FLOOR, debug: silent })).toBe(
      '1.1.0'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('re-resolves when the persisted tag is below the floor', async () => {
    // A floor bump must be able to pull a boat forward off an older pin.
    const { manager, fetchSpy } = makeManager(() =>
      Promise.resolve({ kind: 'version', latest: '1.2.0' })
    )
    expect(
      await resolveAutoTag({ manager, persisted: '0.6.10', floor: FLOOR, debug: silent })
    ).toBe('1.2.0')
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('ignores a corrupt persisted value', async () => {
    const { manager } = makeManager(() => Promise.resolve({ kind: 'version', latest: '1.1.0' }))
    expect(
      await resolveAutoTag({ manager, persisted: 'garbage', floor: FLOOR, debug: silent })
    ).toBe('1.1.0')
  })
})
