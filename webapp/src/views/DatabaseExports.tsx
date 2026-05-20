import { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Label,
  Spinner,
  Table
} from 'reactstrap'
import { api, formatBytes, formatDate, type BackupMetadata, type RestoreState } from '../api'
import { useApi } from '../useApi'
import { BackupBrowser } from '../components/BackupBrowser'
import {
  ACTIVE_HOST_STATES,
  ACTIVE_PARTIAL_STATES,
  PartialRestoreBanner
} from '../components/PartialRestoreBanner'

// Path inside every snapshot where the plugin's DB-export tick lands
// its parquet shards. The browser picker is scoped to this so the user
// doesn't have to navigate the whole tree just to grab DB shards.
const STAGING_SUBPATH = 'plugin-config-data/signalk-backup/database-exports'

// Full-restore in-progress markers — same set Backups.tsx uses. A full
// restore from any view should also disable partial/host actions here,
// so the user gets a clear "wait" rather than a server-side 409.
const ACTIVE_RESTORE_STATES: ReadonlySet<RestoreState> = new Set<RestoreState>([
  'preparing',
  'extracting',
  'installing',
  'restarting',
  'verifying',
  'rolling_back'
])

export function DatabaseExports() {
  const staging = useApi(() => api.listStaging(), { intervalMs: 30000 })
  const backups = useApi(() => api.listBackups(), { intervalMs: 60000 })
  const pluginStatus = useApi(() => api.pluginStatus(), { intervalMs: 60000 })
  // Partial + host restore are reachable from this view via the
  // BackupBrowser modal, so we surface the same status banners and
  // restore-lock here as on the Backups view.
  const restore = useApi(() => api.restoreStatus(), { intervalMs: 2000 })
  const restorePartial = useApi(() => api.restorePartialStatus(), { intervalMs: 2000 })
  const restorePartialHost = useApi(() => api.restorePartialHostStatus(), { intervalMs: 2000 })
  const [browseBackup, setBrowseBackup] = useState<BackupMetadata | null>(null)
  const [selectedBackupId, setSelectedBackupId] = useState<string>('')

  const stagingEntries = staging.data?.entries ?? []
  const allBackups = backups.data?.backups ?? []

  const onOpenBackup = (): void => {
    const b = allBackups.find((x) => x.id === selectedBackupId)
    if (b) setBrowseBackup(b)
  }

  const onResetRestorePartial = async (): Promise<void> => {
    try {
      await api.resetRestorePartialState()
      restorePartial.refresh()
    } catch (err) {
      window.alert(`Reset failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const onResetRestorePartialHost = async (): Promise<void> => {
    try {
      await api.resetRestorePartialHostState()
      restorePartialHost.refresh()
    } catch (err) {
      window.alert(`Reset failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const restoreActive = restore.data ? ACTIVE_RESTORE_STATES.has(restore.data.state) : false
  const restorePartialActive = restorePartial.data
    ? ACTIVE_PARTIAL_STATES.has(restorePartial.data.state)
    : false
  const restorePartialHostActive = restorePartialHost.data
    ? ACTIVE_HOST_STATES.has(restorePartialHost.data.state)
    : false
  const restoreLocked = restoreActive || restorePartialActive || restorePartialHostActive

  return (
    <>
      <h2 className="mb-3">Database exports</h2>
      {restorePartial.data && (
        <PartialRestoreBanner
          status={restorePartial.data}
          pathMapping={pluginStatus.data?.pathMapping}
          onReset={() => void onResetRestorePartial()}
        />
      )}
      {restorePartialHost.data && (
        <PartialRestoreBanner
          status={restorePartialHost.data}
          title="Host restore"
          pathMapping={pluginStatus.data?.pathMapping}
          mapTargetPath={false}
          onReset={() => void onResetRestorePartialHost()}
        />
      )}
      <p className="text-muted">
        QuestDB, Grafana and signalk-database exports staged by the plugin. The top card extracts
        the database-exports subtree from any historical backup without pulling the whole snapshot;
        the live list below shows what's on disk right now (the next backup will include these).
      </p>

      <Card className="mb-3">
        <CardHeader>
          <strong>Extract from a historical backup</strong>{' '}
          <Badge color="light" className="text-dark ms-1">
            Browser scoped to {STAGING_SUBPATH}
          </Badge>
        </CardHeader>
        <CardBody>
          <p className="small text-muted mb-3">
            Pick a backup and open the database-exports subtree. From there you can download
            individual files (octet-stream) or whole subdirectories (ZIP) without pulling the full
            snapshot.
          </p>

          {backups.loading && !backups.data ? (
            <Spinner size="sm" />
          ) : backups.error ? (
            <Alert color="danger" className="mb-0">
              {backups.error}
            </Alert>
          ) : allBackups.length === 0 ? (
            <p className="text-muted mb-0">
              No backups yet. Once the scheduler runs (or you create a manual one), it will appear
              here.
            </p>
          ) : (
            <div className="d-flex gap-2 align-items-end flex-wrap">
              <div style={{ minWidth: '20rem', flex: '1 1 20rem' }}>
                <Label for="db-export-backup-picker">Backup</Label>
                <Input
                  id="db-export-backup-picker"
                  type="select"
                  value={selectedBackupId}
                  onChange={(e) => {
                    setSelectedBackupId(e.target.value)
                  }}
                >
                  <option value="">— select a backup —</option>
                  {allBackups.map((b) => (
                    <option key={b.id} value={b.id}>
                      {formatDate(b.createdAt)} · {b.type} · {b.id.slice(0, 12)}
                    </option>
                  ))}
                </Input>
              </div>
              <Button color="primary" disabled={!selectedBackupId} onClick={onOpenBackup}>
                Open browser
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="d-flex justify-content-between align-items-center">
          <strong>Live staging ({stagingEntries.length})</strong>
          <Button
            color="secondary"
            outline
            size="sm"
            onClick={staging.refresh}
            disabled={staging.loading}
          >
            Refresh
          </Button>
        </CardHeader>
        <CardBody className="p-0">
          {staging.loading && !staging.data ? (
            <div className="text-center py-3">
              <Spinner size="sm" />
            </div>
          ) : staging.error ? (
            <Alert color="danger" className="m-3 mb-0">
              {staging.error}
            </Alert>
          ) : stagingEntries.length === 0 ? (
            <p className="text-muted m-3 mb-0">
              Nothing staged yet. Enable the relevant exporter in Settings → Database export, or
              wait for the next scheduler tick.
            </p>
          ) : (
            <Table responsive striped className="mb-0">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Size</th>
                  <th>Modified</th>
                  <th className="text-end">Actions</th>
                </tr>
              </thead>
              <tbody>
                {stagingEntries.map((e) => (
                  <tr key={e.path}>
                    <td>
                      <code className="small">{e.path}</code>
                    </td>
                    <td>{formatBytes(e.size)}</td>
                    <td className="small text-muted">{formatDate(e.mtime)}</td>
                    <td className="text-end">
                      <a
                        href={api.stagingDownloadUrl(e.path)}
                        className="btn btn-outline-secondary btn-sm"
                        download
                      >
                        Download
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {staging.data?.stagingRoot && (
            <div className="px-3 py-2 small text-muted border-top">
              Staging root: <code>{staging.data.stagingRoot}</code>
            </div>
          )}
        </CardBody>
      </Card>

      {browseBackup && (
        <BackupBrowser
          backup={browseBackup}
          isOpen
          initialPath={STAGING_SUBPATH}
          pathMapping={pluginStatus.data?.pathMapping}
          restoreLocked={restoreLocked}
          onClose={() => {
            setBrowseBackup(null)
          }}
          onRestoreStarted={() => {
            // Modal kicks off either flow depending on targetMode;
            // refresh both to surface whichever banner becomes active.
            restorePartial.refresh()
            restorePartialHost.refresh()
          }}
        />
      )}
    </>
  )
}
