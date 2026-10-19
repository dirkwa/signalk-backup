import { describe, it, expect, vi } from 'vitest'
import { installServerVersion, pickServerUpdate } from '../src/server-update.js'
import { errMsg } from '../src/errors.js'

const NONE = new Set<string>()

describe('pickServerUpdate', () => {
  it('moves to a newer release of the running major', () => {
    expect(pickServerUpdate('1.2.0', '1.2.1', NONE)).toBe('1.2.1')
    expect(pickServerUpdate('1.2.0', '1.3.0', NONE)).toBe('1.3.0')
  })

  it('stays on the running version when the release is not newer', () => {
    expect(pickServerUpdate('1.3.0', '1.3.0', NONE)).toBeNull()
    // An API blip or a re-tagged old release must not downgrade a boat.
    expect(pickServerUpdate('1.3.0', '1.2.9', NONE)).toBeNull()
  })

  it('leaves a new major to a plugin release', () => {
    // A major is a breaking server change the installed plugin may not speak.
    expect(pickServerUpdate('1.9.0', '2.0.0', NONE)).toBeNull()
  })

  it('never moves onto a prerelease', () => {
    expect(pickServerUpdate('1.2.0', '1.3.0-beta.1', NONE)).toBeNull()
  })

  it('skips a release that already failed to start', () => {
    expect(pickServerUpdate('1.2.0', '1.3.0', new Set(['1.3.0']))).toBeNull()
  })

  it('ignores a missing or non-semver lookup result', () => {
    expect(pickServerUpdate('1.2.0', null, NONE)).toBeNull()
    expect(pickServerUpdate('1.2.0', undefined, NONE)).toBeNull()
    expect(pickServerUpdate('1.2.0', 'latest', NONE)).toBeNull()
    expect(pickServerUpdate('latest', '1.3.0', NONE)).toBeNull()
  })
})

describe('installServerVersion', () => {
  it('swaps to the target and checks that it answers', async () => {
    const swap = vi.fn(() => Promise.resolve())
    const waitReady = vi.fn(() => Promise.resolve())

    await installServerVersion('1.3.0', '1.2.0', { swap, waitReady })

    expect(swap.mock.calls).toEqual([['1.3.0']])
    expect(waitReady).toHaveBeenCalledTimes(1)
  })

  it('puts the previous version back when the target does not come up', async () => {
    const swap = vi.fn<(tag: string) => Promise<void>>(() => Promise.resolve())
    const waitReady = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('no answer on /api/health'))
      .mockResolvedValueOnce(undefined)

    const err = await installServerVersion('1.3.0', '1.2.0', { swap, waitReady }).catch(
      (e: unknown) => e
    )

    expect(swap.mock.calls).toEqual([['1.3.0'], ['1.2.0']])
    expect(errMsg(err)).toBe(
      'backup server 1.3.0 did not start, back on 1.2.0: no answer on /api/health'
    )
  })

  it('rolls back when the swap itself fails', async () => {
    const swap = vi
      .fn<(tag: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('recreate failed'))
      .mockResolvedValueOnce(undefined)
    const waitReady = vi.fn(() => Promise.resolve())

    await expect(installServerVersion('1.3.0', '1.2.0', { swap, waitReady })).rejects.toThrow(
      /back on 1\.2\.0/
    )
    expect(swap.mock.calls).toEqual([['1.3.0'], ['1.2.0']])
  })

  it('names both failures when the rollback fails too', async () => {
    const swap = vi.fn<(tag: string) => Promise<void>>(() => Promise.resolve())
    const waitReady = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('target down'))
      .mockRejectedValueOnce(new Error('previous down'))

    const err = await installServerVersion('1.3.0', '1.2.0', { swap, waitReady }).catch(
      (e: unknown) => e
    )

    expect(errMsg(err)).toBe(
      'backup server 1.3.0 did not start (target down), and 1.2.0 did not come back either: previous down'
    )
  })
})
