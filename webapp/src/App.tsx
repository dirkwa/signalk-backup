import { useEffect, useState } from 'react'
import { Container, Alert, Spinner, Card, CardBody, CardTitle } from 'reactstrap'
import { api, type PluginStatus, type BackupServerHealth } from './api'

interface State {
  loading: boolean
  status: PluginStatus | null
  health: BackupServerHealth | null
  error: string | null
}

export function App() {
  const [state, setState] = useState<State>({
    loading: true,
    status: null,
    health: null,
    error: null
  })

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const [status, health] = await Promise.all([
          api.pluginStatus(),
          api.health().catch(() => null)
        ])
        if (cancelled) return
        setState({ loading: false, status, health, error: null })
      } catch (err) {
        if (cancelled) return
        setState({
          loading: false,
          status: null,
          health: null,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Container className="py-4">
      <h1 className="mb-4">SignalK Backup</h1>

      {state.loading && (
        <div className="text-center py-5">
          <Spinner /> <span className="ms-2">Loading…</span>
        </div>
      )}

      {state.error && (
        <Alert color="danger">
          <strong>Error:</strong> {state.error}
        </Alert>
      )}

      {state.status && (
        <Card className="mb-3">
          <CardBody>
            <CardTitle tag="h5">Backup engine</CardTitle>
            <dl className="row mb-0">
              <dt className="col-sm-3">Image</dt>
              <dd className="col-sm-9">
                <code>{state.status.container.image}</code>
              </dd>
              <dt className="col-sm-3">Container</dt>
              <dd className="col-sm-9">
                {state.status.container.state}{' '}
                {state.status.container.managed && (
                  <span className="text-muted">(managed by signalk-container)</span>
                )}
              </dd>
              <dt className="col-sm-3">Ready</dt>
              <dd className="col-sm-9">
                {state.status.ready ? (
                  <span className="text-success">✓ ready</span>
                ) : (
                  <span className="text-warning">⚠ not ready (waiting for backup-server)</span>
                )}
              </dd>
              {state.health && (
                <>
                  <dt className="col-sm-3">Engine version</dt>
                  <dd className="col-sm-9">
                    <code>{state.health.version ?? 'unknown'}</code>
                  </dd>
                </>
              )}
            </dl>
          </CardBody>
        </Card>
      )}

      <Alert color="info">
        Backups, settings, and cloud sync UI land in the next iteration. For now this is the
        skeleton — proxy + admin-CSS bootstrap proven, no views ported yet.
      </Alert>
    </Container>
  )
}
