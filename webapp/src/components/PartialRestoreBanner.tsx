import { Alert, Button, Progress } from 'reactstrap'
import {
  toHostPath,
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

interface Props {
  status: PartialRestoreStatus
  /** Container→host path mapping from /status; undefined in external
   *  mode. When supplied, targetPath under the mapped prefix is shown
   *  as its host equivalent instead of the container path. */
  pathMapping?: PluginStatus['pathMapping']
  onReset: () => void
}

export function PartialRestoreBanner({ status, pathMapping, onReset }: Props) {
  if (status.state === 'idle') return null

  const active = ACTIVE_PARTIAL_STATES.has(status.state)
  const failed = status.state === 'failed' || status.state === 'rolled_back'
  const completed = status.state === 'completed'
  const hostTargetPath = toHostPath(status.targetPath, pathMapping)

  return (
    <Alert
      color={failed ? 'danger' : completed ? 'success' : 'info'}
      className="d-flex flex-column gap-2"
    >
      <div className="d-flex justify-content-between align-items-start">
        <div>
          <strong>Partial restore: {status.state}</strong>
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

export { ACTIVE_PARTIAL_STATES }
