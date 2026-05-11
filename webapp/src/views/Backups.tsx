import { useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Col,
  Form,
  FormGroup,
  Input,
  Label,
  Progress,
  Row,
  Spinner,
  Table
} from 'reactstrap'
import { api, formatBytes, formatDate, type BackupMetadata, type RestoreState } from '../api'
import { useApi } from '../useApi'

// In-progress restore states (anything other than idle/completed/rolled_back/failed
// terminal markers we want to keep showing the banner for).
const ACTIVE_RESTORE_STATES: ReadonlySet<RestoreState> = new Set<RestoreState>([
  'preparing',
  'extracting',
  'installing',
  'restarting',
  'verifying',
  'rolling_back'
])

function RestoreBanner({
  status,
  onReset
}: {
  status: { state: RestoreState; progress: number; statusMessage: string; error?: string }
  onReset: () => void
}) {
  if (status.state === 'idle') return null

  const active = ACTIVE_RESTORE_STATES.has(status.state)
  const failed = status.state === 'failed' || status.state === 'rolled_back'
  const completed = status.state === 'completed'

  return (
    <Alert
      color={failed ? 'danger' : completed ? 'success' : 'info'}
      className="d-flex flex-column gap-2"
    >
      <div className="d-flex justify-content-between align-items-start">
        <div>
          <strong>Restore: {status.state}</strong>
          <div className="small">{status.statusMessage}</div>
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

export function Backups() {
  const list = useApi(() => api.listBackups(), { intervalMs: 30000 })
  // Restore status polled at 2s when active, 15s when idle. Two hooks so
  // the polling rate doesn't depend on render-time decisions.
  const restore = useApi(() => api.restoreStatus(), { intervalMs: 2000 })

  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadDescription, setUploadDescription] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const onCreate = async (): Promise<void> => {
    setCreating(true)
    setCreateError(null)
    try {
      await api.createBackup(description.trim() || undefined)
      setDescription('')
      list.refresh()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const onUpload = async (): Promise<void> => {
    const file = fileInputRef.current?.files?.[0]
    if (!file) {
      setUploadError('Select a file first.')
      return
    }
    setUploading(true)
    setUploadError(null)
    try {
      await api.uploadBackup(file, uploadDescription.trim() || undefined)
      setUploadDescription('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      list.refresh()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  const onDelete = async (b: BackupMetadata): Promise<void> => {
    if (!window.confirm(`Delete backup ${b.id.slice(0, 12)} (${formatDate(b.createdAt)})?`)) {
      return
    }
    setDeletingId(b.id)
    try {
      await api.deleteBackup(b.id)
      list.refresh()
    } catch (err) {
      window.alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeletingId(null)
    }
  }

  const onRestore = async (b: BackupMetadata): Promise<void> => {
    const ok = window.confirm(
      `Restore backup ${b.id.slice(0, 12)} (${formatDate(b.createdAt)})?\n\n` +
        'This OVERWRITES the current SignalK config and restarts the server. ' +
        'A safety backup is taken first, so the operation can be rolled back ' +
        'on failure — but any in-flight changes since the safety backup will be lost.'
    )
    if (!ok) return
    setRestoringId(b.id)
    try {
      await api.startRestore(b.id)
      restore.refresh()
    } catch (err) {
      window.alert(`Restore failed to start: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestoringId(null)
    }
  }

  const onResetRestore = async (): Promise<void> => {
    try {
      await api.resetRestoreState()
      restore.refresh()
    } catch (err) {
      window.alert(`Reset failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const allBackups = list.data?.backups ?? []
  const restoreActive = restore.data ? ACTIVE_RESTORE_STATES.has(restore.data.state) : false

  return (
    <>
      <h2 className="mb-3">Backups</h2>

      {restore.data && (
        <RestoreBanner status={restore.data} onReset={() => void onResetRestore()} />
      )}

      <Row className="mb-3">
        <Col xs={12} md={6}>
          <Card>
            <CardHeader>
              <strong>Create new backup</strong>
            </CardHeader>
            <CardBody>
              <Form
                onSubmit={(e) => {
                  e.preventDefault()
                  void onCreate()
                }}
              >
                <FormGroup>
                  <Label for="backup-description">Description (optional)</Label>
                  <Input
                    id="backup-description"
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value)
                    }}
                    placeholder="e.g. before plugin upgrade"
                    disabled={creating}
                  />
                </FormGroup>
                <Button color="primary" type="submit" disabled={creating}>
                  {creating ? (
                    <>
                      <Spinner size="sm" /> Creating…
                    </>
                  ) : (
                    'Create backup'
                  )}
                </Button>
                {createError && (
                  <Alert color="danger" className="mt-3 mb-0">
                    {createError}
                  </Alert>
                )}
              </Form>
            </CardBody>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <CardHeader>
              <strong>Upload backup</strong>
            </CardHeader>
            <CardBody>
              <Form
                onSubmit={(e) => {
                  e.preventDefault()
                  void onUpload()
                }}
              >
                <FormGroup>
                  <Label for="backup-upload-file">Backup ZIP file</Label>
                  <Input
                    id="backup-upload-file"
                    type="file"
                    accept=".zip,application/zip"
                    innerRef={fileInputRef}
                    disabled={uploading}
                  />
                </FormGroup>
                <FormGroup>
                  <Label for="backup-upload-description">Description (optional)</Label>
                  <Input
                    id="backup-upload-description"
                    value={uploadDescription}
                    onChange={(e) => {
                      setUploadDescription(e.target.value)
                    }}
                    placeholder="e.g. recovered from external drive"
                    disabled={uploading}
                  />
                </FormGroup>
                <Button color="primary" type="submit" disabled={uploading}>
                  {uploading ? (
                    <>
                      <Spinner size="sm" /> Uploading…
                    </>
                  ) : (
                    'Upload'
                  )}
                </Button>
                {uploadError && (
                  <Alert color="danger" className="mt-3 mb-0">
                    {uploadError}
                  </Alert>
                )}
              </Form>
            </CardBody>
          </Card>
        </Col>
      </Row>

      <Card>
        <CardHeader className="d-flex justify-content-between align-items-center">
          <strong>All backups ({allBackups.length})</strong>
          <Button
            color="secondary"
            outline
            size="sm"
            onClick={list.refresh}
            disabled={list.loading}
          >
            Refresh
          </Button>
        </CardHeader>
        <CardBody className="p-0">
          {list.loading && !list.data ? (
            <div className="text-center py-3">
              <Spinner size="sm" />
            </div>
          ) : list.error ? (
            <Alert color="danger" className="m-3 mb-0">
              {list.error}
            </Alert>
          ) : allBackups.length === 0 ? (
            <p className="text-muted m-3 mb-0">
              No backups yet. Create one above, or wait for the scheduler.
            </p>
          ) : (
            <Table responsive striped className="mb-0">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Created</th>
                  <th>Size</th>
                  <th>Description</th>
                  <th>ID</th>
                  <th className="text-end">Actions</th>
                </tr>
              </thead>
              <tbody>
                {allBackups.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Badge color="light" className="text-dark">
                        {b.type}
                      </Badge>
                    </td>
                    <td>{formatDate(b.createdAt)}</td>
                    <td>{formatBytes(b.size)}</td>
                    <td className="text-muted">{b.description ?? ''}</td>
                    <td>
                      <code className="small">{b.id.slice(0, 12)}</code>
                    </td>
                    <td className="text-end">
                      <a
                        href={api.downloadUrl(b.id)}
                        className="btn btn-outline-secondary btn-sm me-1"
                        download
                      >
                        Download
                      </a>
                      <Button
                        color="warning"
                        outline
                        size="sm"
                        className="me-1"
                        disabled={restoringId === b.id || restoreActive}
                        onClick={() => void onRestore(b)}
                      >
                        {restoringId === b.id ? <Spinner size="sm" /> : 'Restore'}
                      </Button>
                      <Button
                        color="danger"
                        outline
                        size="sm"
                        disabled={deletingId === b.id || restoreActive}
                        onClick={() => void onDelete(b)}
                      >
                        {deletingId === b.id ? <Spinner size="sm" /> : 'Delete'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  )
}
