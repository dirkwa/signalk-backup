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
import { api, formatBytes, formatDate, type BackupMetadata } from '../api'
import { useApi } from '../useApi'
import { BackupBrowser } from '../components/BackupBrowser'

// Path inside every snapshot where the plugin's DB-export tick lands
// its parquet shards. The browser picker is scoped to this so the user
// doesn't have to navigate the whole tree just to grab DB shards.
const STAGING_SUBPATH = 'plugin-config-data/signalk-backup/database-exports'

export function DatabaseExports() {
  const staging = useApi(() => api.listStaging(), { intervalMs: 30000 })
  const backups = useApi(() => api.listBackups(), { intervalMs: 60000 })
  const pluginStatus = useApi(() => api.pluginStatus(), { intervalMs: 60000 })
  const [browseBackup, setBrowseBackup] = useState<BackupMetadata | null>(null)
  const [selectedBackupId, setSelectedBackupId] = useState<string>('')

  const stagingEntries = staging.data?.entries ?? []
  const allBackups = backups.data?.backups ?? []

  const onOpenBackup = (): void => {
    const b = allBackups.find((x) => x.id === selectedBackupId)
    if (b) setBrowseBackup(b)
  }

  return (
    <>
      <h2 className="mb-3">Database exports</h2>
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
          onClose={() => {
            setBrowseBackup(null)
          }}
        />
      )}
    </>
  )
}
