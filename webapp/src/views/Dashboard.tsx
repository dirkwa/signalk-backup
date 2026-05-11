import { Alert, Badge, Button, Card, CardBody, CardHeader, Col, Row, Spinner } from 'reactstrap'
import { api, formatDate, type PluginStatus, type SchedulerStatus } from '../api'
import { useApi } from '../useApi'

function StatusPill({ status }: { status: PluginStatus | null }) {
  if (!status) return <Badge color="secondary">Unknown</Badge>
  if (!status.ready) {
    return <Badge color="warning">Not ready</Badge>
  }
  return <Badge color="success">Ready</Badge>
}

function SchedulerCounts({ scheduler }: { scheduler: SchedulerStatus }) {
  return (
    <Row className="g-2 mt-2">
      <Col xs={3}>
        <small className="text-muted d-block">Hourly</small>
        <div>{scheduler.backupCounts.hourly}</div>
      </Col>
      <Col xs={3}>
        <small className="text-muted d-block">Daily</small>
        <div>{scheduler.backupCounts.daily}</div>
      </Col>
      <Col xs={3}>
        <small className="text-muted d-block">Weekly</small>
        <div>{scheduler.backupCounts.weekly}</div>
      </Col>
      <Col xs={3}>
        <small className="text-muted d-block">Manual</small>
        <div>{scheduler.backupCounts.manual}</div>
      </Col>
    </Row>
  )
}

export function Dashboard() {
  const status = useApi(() => api.pluginStatus(), { intervalMs: 5000 })
  const scheduler = useApi(() => api.scheduler(), { intervalMs: 15000 })
  const backups = useApi(() => api.listBackups(), { intervalMs: 30000 })

  const refreshAll = (): void => {
    status.refresh()
    scheduler.refresh()
    backups.refresh()
  }

  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">Dashboard</h2>
        <Button
          color="secondary"
          outline
          size="sm"
          onClick={refreshAll}
          disabled={status.loading || scheduler.loading || backups.loading}
        >
          Refresh
        </Button>
      </div>

      <Row>
        <Col xs={12} md={6}>
          <Card className="mb-3">
            <CardHeader>
              <strong>Plugin status</strong>
            </CardHeader>
            <CardBody>
              {status.loading && !status.data ? (
                <Spinner size="sm" />
              ) : status.error ? (
                <Alert color="danger" className="mb-0">
                  {status.error}
                </Alert>
              ) : (
                <>
                  <div className="mb-2">
                    <StatusPill status={status.data} />
                  </div>
                  {status.data && (
                    <dl className="row mb-0">
                      <dt className="col-sm-4">Image</dt>
                      <dd className="col-sm-8 text-truncate">
                        <code>{status.data.container.image}</code>
                      </dd>
                      <dt className="col-sm-4">Container</dt>
                      <dd className="col-sm-8">
                        {status.data.container.state}{' '}
                        {status.data.container.managed && (
                          <small className="text-muted">(managed)</small>
                        )}
                      </dd>
                    </dl>
                  )}
                </>
              )}
            </CardBody>
          </Card>
        </Col>

        <Col xs={12} md={6}>
          <Card className="mb-3">
            <CardHeader>
              <strong>Scheduler</strong>
            </CardHeader>
            <CardBody>
              {scheduler.loading && !scheduler.data ? (
                <Spinner size="sm" />
              ) : scheduler.error ? (
                <Alert color="danger" className="mb-0">
                  {scheduler.error}
                </Alert>
              ) : scheduler.data ? (
                <>
                  <div className="mb-2">
                    <Badge color={scheduler.data.enabled ? 'success' : 'secondary'}>
                      {scheduler.data.enabled ? 'Running' : 'Stopped'}
                    </Badge>
                  </div>
                  <Row className="g-2">
                    <Col xs={6}>
                      <small className="text-muted d-block">Last backup</small>
                      <div>{formatDate(scheduler.data.lastBackup)}</div>
                    </Col>
                    <Col xs={6}>
                      <small className="text-muted d-block">Total snapshots</small>
                      <div>{scheduler.data.backupCounts.total}</div>
                    </Col>
                  </Row>
                  <SchedulerCounts scheduler={scheduler.data} />
                </>
              ) : null}
            </CardBody>
          </Card>
        </Col>
      </Row>

      <Card>
        <CardHeader>
          <strong>Recent backups</strong>
        </CardHeader>
        <CardBody>
          {backups.loading && !backups.data ? (
            <Spinner size="sm" />
          ) : backups.error ? (
            <Alert color="danger" className="mb-0">
              {backups.error}
            </Alert>
          ) : backups.data && backups.data.backups.length > 0 ? (
            <ul className="list-unstyled mb-0">
              {backups.data.backups.slice(0, 5).map((b) => (
                <li key={b.id} className="d-flex justify-content-between border-bottom py-2">
                  <span>
                    <Badge color="light" className="text-dark me-2">
                      {b.type}
                    </Badge>
                    {formatDate(b.createdAt)}
                  </span>
                  <code className="text-muted small">{b.id.slice(0, 12)}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted mb-0">No backups yet.</p>
          )}
        </CardBody>
      </Card>
    </>
  )
}
