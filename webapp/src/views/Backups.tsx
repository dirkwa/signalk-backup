import { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Form,
  FormGroup,
  Input,
  Label,
  Spinner,
  Table
} from 'reactstrap'
import { api, formatBytes, formatDate, type BackupMetadata } from '../api'
import { useApi } from '../useApi'

export function Backups() {
  const { data, loading, error, refresh } = useApi(() => api.listBackups(), {
    intervalMs: 30000
  })

  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const onCreate = async (): Promise<void> => {
    setCreating(true)
    setCreateError(null)
    try {
      await api.createBackup(description.trim() || undefined)
      setDescription('')
      refresh()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const onDelete = async (b: BackupMetadata): Promise<void> => {
    if (!window.confirm(`Delete backup ${b.id.slice(0, 12)} (${formatDate(b.createdAt)})?`)) {
      return
    }
    setDeletingId(b.id)
    try {
      await api.deleteBackup(b.id)
      refresh()
    } catch (err) {
      // The list refresh will overwrite this if the delete actually
      // worked — only persistent errors stay visible.
      window.alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeletingId(null)
    }
  }

  const allBackups = data?.backups ?? []

  return (
    <>
      <h2 className="mb-3">Backups</h2>

      <Card className="mb-3">
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

      <Card>
        <CardHeader className="d-flex justify-content-between align-items-center">
          <strong>All backups ({allBackups.length})</strong>
          <Button color="secondary" outline size="sm" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </CardHeader>
        <CardBody className="p-0">
          {loading && !data ? (
            <div className="text-center py-3">
              <Spinner size="sm" />
            </div>
          ) : error ? (
            <Alert color="danger" className="m-3 mb-0">
              {error}
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
                  <th></th>
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
                      <Button
                        color="danger"
                        outline
                        size="sm"
                        disabled={deletingId === b.id}
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
