/**
 * Structural shape of the server's `syncProgress` field. Defined inline here
 * (instead of importing `SyncProgress` from `../api`) so this module has no
 * DOM-side dependencies and can be unit-tested from the Node-only test
 * project without pulling in `fetch` etc.
 */
export interface SyncProgressInput {
  totalBytes: number
  processedBlobs?: number
  totalBlobs?: number
  processedBytes?: number
}

export type SyncPhase = 'determinate' | 'bytes-only' | 'elapsed-only'

export interface SyncDisplay {
  phase: SyncPhase
  /** Percent 0..100 — only meaningful for `determinate`. */
  percent: number
  label: string
}

const MB = 1024 * 1024

function formatMB(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/**
 * Decide which Progress-bar variant to render for an in-flight cloud sync.
 * Pure so the UI logic can be unit-tested without spinning up a DOM.
 */
export function computeSyncDisplay(
  syncProgress: SyncProgressInput | undefined,
  startedAt: number | null,
  now: number = Date.now()
): SyncDisplay {
  const processedBlobs = syncProgress?.processedBlobs
  const totalBlobs = syncProgress?.totalBlobs
  const processedBytes = syncProgress?.processedBytes

  if (typeof processedBlobs === 'number' && typeof totalBlobs === 'number' && totalBlobs > 0) {
    const percent = Math.min(100, (processedBlobs / totalBlobs) * 100)
    const bytesPart = typeof processedBytes === 'number' ? ` (${formatMB(processedBytes)})` : ''
    return {
      phase: 'determinate',
      percent,
      label: `${processedBlobs} / ${totalBlobs} blobs${bytesPart}`
    }
  }

  if (typeof processedBytes === 'number') {
    return {
      phase: 'bytes-only',
      percent: 100,
      label: `Syncing… ${formatMB(processedBytes)} transferred so far`
    }
  }

  const elapsedMs = startedAt !== null ? Math.max(0, now - startedAt) : 0
  return {
    phase: 'elapsed-only',
    percent: 100,
    label: `Syncing… (elapsed ${formatElapsed(elapsedMs)})`
  }
}
