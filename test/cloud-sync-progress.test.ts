import { describe, it, expect } from 'vitest'
import { computeSyncDisplay } from '../webapp/src/components/cloud-sync-progress-display.js'

describe('computeSyncDisplay', () => {
  it('determinate phase: percent + "X / Y blobs (Z MB)" label when blob counts are known', () => {
    const out = computeSyncDisplay(
      { totalBytes: 100_000_000, processedBlobs: 10, totalBlobs: 40, processedBytes: 5_242_880 },
      null
    )
    expect(out.phase).toBe('determinate')
    expect(out.percent).toBe(25)
    expect(out.label).toBe('10 / 40 blobs (5.0 MB)')
  })

  it('determinate phase: omits MB suffix when processedBytes is not yet known', () => {
    const out = computeSyncDisplay(
      { totalBytes: 100_000_000, processedBlobs: 1, totalBlobs: 4 },
      null
    )
    expect(out.phase).toBe('determinate')
    expect(out.percent).toBe(25)
    expect(out.label).toBe('1 / 4 blobs')
  })

  it('bytes-only phase: indeterminate striped label when only processedBytes is set (rclone upload phase)', () => {
    const out = computeSyncDisplay({ totalBytes: 100_000_000, processedBytes: 12_582_912 }, null)
    expect(out.phase).toBe('bytes-only')
    expect(out.percent).toBe(100)
    expect(out.label).toBe('Syncing… 12.0 MB transferred so far')
  })

  it('elapsed-only phase: indeterminate label with elapsed time when no progress fields are populated', () => {
    const startedAt = 1_700_000_000_000
    const now = startedAt + 75_000 // 1m 15s later
    const out = computeSyncDisplay({ totalBytes: 100_000_000 }, startedAt, now)
    expect(out.phase).toBe('elapsed-only')
    expect(out.percent).toBe(100)
    expect(out.label).toBe('Syncing… (elapsed 1m 15s)')
  })

  it('elapsed-only phase: formats sub-minute elapsed as seconds only', () => {
    const startedAt = 1_700_000_000_000
    const now = startedAt + 45_000
    const out = computeSyncDisplay({ totalBytes: 100_000_000 }, startedAt, now)
    expect(out.label).toBe('Syncing… (elapsed 45s)')
  })

  it('elapsed-only phase: falls back gracefully when syncProgress is undefined and startedAt is null', () => {
    const out = computeSyncDisplay(undefined, null, 1_700_000_000_000)
    expect(out.phase).toBe('elapsed-only')
    expect(out.label).toBe('Syncing… (elapsed 0s)')
  })

  it('determinate phase caps percent at 100 if processedBlobs somehow exceeds totalBlobs', () => {
    const out = computeSyncDisplay({ totalBytes: 100, processedBlobs: 50, totalBlobs: 40 }, null)
    expect(out.percent).toBe(100)
  })
})
