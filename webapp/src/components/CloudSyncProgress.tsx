import { Progress } from 'reactstrap'
import type { SyncProgress } from '../api'
import { computeSyncDisplay } from './cloud-sync-progress-display'

interface Props {
  syncProgress: SyncProgress | undefined
  startedAt: number | null
  /** Pinned timestamp for tests / parents that want deterministic elapsed text. */
  now?: number
}

export function CloudSyncProgress({ syncProgress, startedAt, now }: Props) {
  const display = computeSyncDisplay(syncProgress, startedAt, now)
  const isDeterminate = display.phase === 'determinate'

  return (
    <div className="mb-3">
      <div className="small text-body mb-1">{display.label}</div>
      <Progress
        animated={!isDeterminate}
        striped={!isDeterminate}
        value={display.percent}
        max={100}
        color="info"
      />
    </div>
  )
}
