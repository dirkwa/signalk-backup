import { Alert, Button, Progress } from 'reactstrap'
import {
  toHostPath,
  type HostRestoreStatus,
  type PartialRestoreState,
  type PartialRestoreStatus,
  type PluginStatus
} from '../api'

const ACTIVE_PARTIAL_STATES: ReadonlySet<PartialRestoreState> = new Set<PartialRestoreState>([
  'preparing',
  'safety_snapshotting',
  'extracting',
  'verifying',
  'rolling_back'
])

const ACTIVE_HOST_STATES = new Set<HostRestoreStatus['state']>([
  'preparing',
  'streaming',
  'extracting',
  'rolling_back'
])

interface Props {
  status: PartialRestoreStatus | HostRestoreStatus
  // Set "Host restore" for the host-side banner so it's distinguishable when both fire.
  title?: string
  // From /status — used to translate container paths to host paths.
  pathMapping?: PluginStatus['pathMapping']
  // Set false when targetPath is already a host path (the host-restore
  // writer writes locally, so the status already carries the host
  // path) — running it through toHostPath would mis-remap if the
  // chosen path happens to share the container prefix.
  mapTargetPath?: boolean
  onReset: () => void
}

function isActive(state: string): boolean {
  return (
    ACTIVE_PARTIAL_STATES.has(state as PartialRestoreState) ||
    ACTIVE_HOST_STATES.has(state as HostRestoreStatus['state'])
  )
}

export function PartialRestoreBanner({
  status,
  title,
  pathMapping,
  mapTargetPath = true,
  onReset
}: Props) {
  if (status.state === 'idle') return null

  const active = isActive(status.state)
  const failed = status.state === 'failed' || status.state === 'rolled_back'
  const completed = status.state === 'completed'
  const hostTargetPath = mapTargetPath
    ? toHostPath(status.targetPath, pathMapping)
    : status.targetPath

  return (
    <Alert
      color={failed ? 'danger' : completed ? 'success' : 'info'}
      className="d-flex flex-column gap-2"
    >
      <div className="d-flex justify-content-between align-items-start">
        <div>
          <strong>
            {title ?? 'Partial restore'}: {status.state}
          </strong>
          <div className="small">{status.statusMessage}</div>
          {status.sourcePath && (
            <div className="small text-muted">
              source <code>{status.sourcePath}</code>
              {hostTargetPath && (
                <>
                  {' '}
                  → target <code>{hostTargetPath}</code>
                </>
              )}
            </div>
          )}
          {status.error && <div className="small text-danger">Error: {status.error}</div>}
        </div>
        {!active && (
          <Button size="sm" outline color={failed ? 'danger' : 'success'} onClick={onReset}>
            Dismiss
          </Button>
        )}
      </div>
      {active && (
        <Progress
          animated
          striped
          value={status.progress}
          max={100}
          color={failed ? 'danger' : 'info'}
        >
          {status.progress > 0 ? `${status.progress.toFixed(0)}%` : ''}
        </Progress>
      )}
    </Alert>
  )
}

export { ACTIVE_PARTIAL_STATES, ACTIVE_HOST_STATES }
