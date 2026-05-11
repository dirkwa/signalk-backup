import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Col,
  FormGroup,
  Input,
  Label,
  Row,
  Spinner
} from 'reactstrap'
import {
  api,
  formatDate,
  type CloudStatus,
  type CloudSyncFrequency,
  type CloudSyncMode,
  type CloudSyncProvider
} from '../api'
import { useApi } from '../useApi'
import { LocalConfigureForm } from '../components/LocalConfigureForm'

function providerLabel(provider: CloudSyncProvider): string {
  switch (provider) {
    case 'gdrive':
      return 'Drive'
    case 'local':
      return 'Local destination'
  }
}

function StatusBadges({ status }: { status: CloudStatus }) {
  const isLocal = status.provider === 'local'
  return (
    <div className="mb-2 d-flex gap-2 flex-wrap">
      <Badge color={status.connected ? 'success' : 'secondary'}>
        {status.connected
          ? `${providerLabel(status.provider)} connected`
          : `${providerLabel(status.provider)} not configured`}
      </Badge>
      {status.syncing && <Badge color="info">Syncing</Badge>}
      {/* Internet check is only meaningful for rclone-backed providers (gdrive). */}
      {!isLocal && status.internetAvailable === false && <Badge color="warning">Offline</Badge>}
    </div>
  )
}

// Connect flow:
//   1. POST /cloud/gdrive/connect → { authUrl }
//   2. open authUrl in new tab → user signs in to Google
//   3. Google redirects back to rclone's loopback listener on :53682
//   4. We poll /cloud/gdrive/auth-state every 2s for completed | failed
//   Fallback (browser on a different host than rclone): user copies the
//   callback URL from their browser address bar and submits it via
//   auth-callback. We surface the textarea after 15s OR immediately on
//   macOS/Windows where the rclone-in-Podman-VM can't reach :53682.
function ConnectFlow({ onDone, onError }: { onDone: () => void; onError: (msg: string) => void }) {
  const [polling, setPolling] = useState(false)
  const [showFallback, setShowFallback] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [forwarding, setForwarding] = useState(false)
  const startedAtRef = useRef<number>(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const windowRef = useRef<Window | null>(null)
  // A ref guard (not state) so a fast double-click is rejected without
  // waiting for React to re-render — the click handler reads the latest
  // value synchronously.
  const connectingRef = useRef(false)

  const stopPolling = (): void => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = undefined
    }
    setPolling(false)
  }

  useEffect(() => {
    return () => {
      stopPolling()
      connectingRef.current = false
    }
  }, [])

  const onConnect = async (): Promise<void> => {
    if (connectingRef.current) return
    connectingRef.current = true
    // Pre-open a window during the user gesture (mobile Safari etc. block
    // window.open from outside a click handler). We'll set its location
    // to the OAuth URL once we have it.
    windowRef.current = window.open('about:blank', '_blank')
    try {
      const { authUrl } = await api.gdriveConnect()
      if (windowRef.current && !windowRef.current.closed) {
        windowRef.current.location.href = authUrl
      } else {
        // Popup blocker may have killed the pre-opened window — user gets
        // a copy-paste fallback below.
        setShowFallback(true)
      }
      setPolling(true)
      startedAtRef.current = Date.now()
      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const state = await api.gdriveAuthState()
            if (state.state === 'completed') {
              stopPolling()
              connectingRef.current = false
              setShowFallback(false)
              setCallbackUrl('')
              onDone()
            } else if (state.state === 'failed') {
              stopPolling()
              connectingRef.current = false
              setShowFallback(false)
              onError(state.error ?? 'Authorization failed')
            } else if (Date.now() - startedAtRef.current > 15_000) {
              setShowFallback(true)
            }
          } catch {
            // ignore poll errors — next tick will retry
          }
        })()
      }, 2000)
    } catch (err) {
      windowRef.current?.close()
      connectingRef.current = false
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  const onCancel = async (): Promise<void> => {
    stopPolling()
    connectingRef.current = false
    setShowFallback(false)
    setCallbackUrl('')
    try {
      await api.gdriveCancel()
    } catch {
      // ignore — the auth state will move to idle on its own
    }
  }

  const onForward = async (): Promise<void> => {
    if (!callbackUrl.trim()) return
    setForwarding(true)
    try {
      await api.gdriveAuthCallback(callbackUrl.trim())
      setCallbackUrl('')
      // The poll picks up state.completed and fires onDone.
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setForwarding(false)
    }
  }

  if (!polling) {
    return (
      <Button color="primary" onClick={() => void onConnect()}>
        Connect Google Drive
      </Button>
    )
  }

  return (
    <div>
      <div className="d-flex align-items-center gap-2 mb-3">
        <Spinner size="sm" />
        <span>Waiting for Google authorization…</span>
        <Button color="secondary" outline size="sm" onClick={() => void onCancel()}>
          Cancel
        </Button>
      </div>
      {showFallback && (
        <Alert color="info" className="mb-0">
          <p className="mb-2">
            <strong>Browser on a different machine than this server?</strong>
          </p>
          <p className="small mb-2">
            After granting access in Google, your browser is redirected to a URL starting with
            <code> http://127.0.0.1:53682/</code>. Copy that whole URL from your browser's address
            bar and paste it here.
          </p>
          <FormGroup>
            <Label for="callback-url">Callback URL</Label>
            <Input
              id="callback-url"
              type="text"
              value={callbackUrl}
              onChange={(e) => {
                setCallbackUrl(e.target.value)
              }}
              placeholder="http://127.0.0.1:53682/?code=..."
              disabled={forwarding}
            />
          </FormGroup>
          <Button
            color="primary"
            size="sm"
            disabled={forwarding || !callbackUrl.trim()}
            onClick={() => void onForward()}
          >
            {forwarding ? <Spinner size="sm" /> : 'Submit callback'}
          </Button>
        </Alert>
      )}
    </div>
  )
}

export function Cloud() {
  const cloud = useApi(() => api.cloudStatus(), { intervalMs: 5000 })
  const local = useApi(() => api.localStatus(), { intervalMs: 5000 })
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState<'sync' | 'cancel' | 'disconnect' | 'config' | 'switch' | null>(
    null
  )
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  // The dropdown reflects user intent immediately so picking "Local"
  // from the gdrive view surfaces the configure form. Server provider
  // doesn't actually flip until configure succeeds.
  const [pendingProvider, setPendingProvider] = useState<CloudSyncProvider | null>(null)
  const activeProvider: CloudSyncProvider = pendingProvider ?? cloud.data?.provider ?? 'gdrive'

  /**
   * Switch the active provider. For gdrive ↔ local, this just rewrites
   * settings.cloudSync.provider; the backend keeps prior config so
   * switching back doesn't require re-authing or re-picking a path.
   *
   * Local → Gdrive flips immediately via /local/disconnect.
   * Gdrive → Local opens the LocalConfigureForm; selection there flips
   * provider via /local/configure (which sets provider='local').
   */
  const switchProviderToGdrive = async (): Promise<void> => {
    setBusy('switch')
    setError(null)
    try {
      await api.localDisconnect()
      setPendingProvider(null)
      cloud.refresh()
      local.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const onSync = async (): Promise<void> => {
    setBusy('sync')
    setError(null)
    setSuccess(null)
    try {
      await api.cloudSync()
      cloud.refresh()
      setSuccess('Sync started')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const onCancelSync = async (): Promise<void> => {
    setBusy('cancel')
    try {
      await api.cloudSyncCancel()
      cloud.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const onDisconnect = async (): Promise<void> => {
    setBusy('disconnect')
    setError(null)
    try {
      await api.gdriveDisconnect()
      cloud.refresh()
      setConfirmDisconnect(false)
      setSuccess('Google Drive disconnected')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const onUpdateConfig = async (update: {
    syncMode?: CloudSyncMode
    syncFrequency?: CloudSyncFrequency
  }): Promise<void> => {
    setBusy('config')
    setError(null)
    try {
      await api.cloudConfig(update)
      cloud.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h2 className="mb-3">Cloud sync</h2>

      {error && (
        <Alert
          color="danger"
          toggle={() => {
            setError(null)
          }}
        >
          {error}
        </Alert>
      )}
      {success && (
        <Alert
          color="success"
          toggle={() => {
            setSuccess(null)
          }}
        >
          {success}
        </Alert>
      )}

      <Card className="mb-3">
        <CardHeader>
          <strong>Destination</strong>
        </CardHeader>
        <CardBody>
          {cloud.loading && !cloud.data ? (
            <Spinner size="sm" />
          ) : cloud.error ? (
            <Alert color="danger" className="mb-0">
              {cloud.error}
            </Alert>
          ) : cloud.data ? (
            <>
              <StatusBadges status={cloud.data} />

              <FormGroup className="mb-3">
                <Label for="provider-select">Where backups go</Label>
                <Input
                  id="provider-select"
                  type="select"
                  value={activeProvider}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const next = e.target.value as CloudSyncProvider
                    if (next === activeProvider) return
                    if (next === 'gdrive') {
                      void switchProviderToGdrive()
                    } else {
                      // Surface the LocalConfigureForm immediately. Server
                      // provider only flips once the user picks a path and
                      // /local/configure succeeds.
                      setPendingProvider('local')
                    }
                  }}
                >
                  <option value="gdrive">Google Drive</option>
                  <option value="local">Local drive / mounted folder</option>
                </Input>
              </FormGroup>

              {activeProvider === 'gdrive' && (
                <>
                  {cloud.data.email && (
                    <p className="text-muted small mb-2">Account: {cloud.data.email}</p>
                  )}
                  {cloud.data.connected ? (
                    <>
                      {confirmDisconnect ? (
                        <div className="d-flex gap-2 align-items-center">
                          <span>Really disconnect?</span>
                          <Button
                            color="danger"
                            size="sm"
                            disabled={busy === 'disconnect'}
                            onClick={() => void onDisconnect()}
                          >
                            {busy === 'disconnect' ? <Spinner size="sm" /> : 'Disconnect'}
                          </Button>
                          <Button
                            color="secondary"
                            outline
                            size="sm"
                            onClick={() => {
                              setConfirmDisconnect(false)
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          color="danger"
                          outline
                          onClick={() => {
                            setConfirmDisconnect(true)
                          }}
                        >
                          Disconnect
                        </Button>
                      )}
                    </>
                  ) : (
                    <ConnectFlow
                      onDone={() => {
                        cloud.refresh()
                        setSuccess('Google Drive connected')
                      }}
                      onError={setError}
                    />
                  )}
                </>
              )}

              {activeProvider === 'local' && (
                <>
                  {local.data?.connected ? (
                    <>
                      <p className="text-muted small mb-2">
                        Backing up to <code>{local.data.hostPath ?? local.data.containerPath}</code>
                        {local.data.freeBytes != null && (
                          <> — {Math.round(local.data.freeBytes / 1e9)} GB free</>
                        )}
                      </p>
                      <Button
                        color="danger"
                        outline
                        disabled={busy !== null}
                        onClick={() => void switchProviderToGdrive()}
                      >
                        {busy === 'switch' ? <Spinner size="sm" /> : 'Switch back to Google Drive'}
                      </Button>
                    </>
                  ) : (
                    <>
                      {local.data?.error && (
                        <Alert color="warning" className="mb-2">
                          {local.data.error}
                        </Alert>
                      )}
                      <LocalConfigureForm
                        onConfigured={() => {
                          setPendingProvider(null)
                          cloud.refresh()
                          local.refresh()
                          setSuccess('Local destination configured')
                        }}
                        onError={setError}
                      />
                    </>
                  )}
                </>
              )}
            </>
          ) : null}
        </CardBody>
      </Card>

      {cloud.data?.connected && (
        <Card className="mb-3">
          <CardHeader>
            <strong>Sync</strong>
          </CardHeader>
          <CardBody>
            <Row className="g-3 mb-3">
              <Col xs={12} md={6}>
                <FormGroup>
                  <Label for="sync-mode">Sync mode</Label>
                  <Input
                    id="sync-mode"
                    type="select"
                    value={cloud.data.syncMode ?? 'manual'}
                    disabled={busy === 'config'}
                    onChange={(e) => {
                      const syncMode = e.target.value as CloudSyncMode
                      // Switching to scheduled with no prior frequency would
                      // leave it null on the server and the schedule wouldn't
                      // fire — default to daily in that case.
                      const update: {
                        syncMode: CloudSyncMode
                        syncFrequency?: CloudSyncFrequency
                      } = { syncMode }
                      if (syncMode === 'scheduled' && !cloud.data?.syncFrequency) {
                        update.syncFrequency = 'daily'
                      }
                      void onUpdateConfig(update)
                    }}
                  >
                    <option value="manual">Manual only</option>
                    <option value="after_backup">After every backup</option>
                    <option value="scheduled">On a schedule</option>
                  </Input>
                </FormGroup>
              </Col>
              {cloud.data.syncMode === 'scheduled' && (
                <Col xs={12} md={6}>
                  <FormGroup>
                    <Label for="sync-frequency">Schedule</Label>
                    <Input
                      id="sync-frequency"
                      type="select"
                      value={cloud.data.syncFrequency ?? 'daily'}
                      disabled={busy === 'config'}
                      onChange={(e) => {
                        void onUpdateConfig({
                          syncFrequency: e.target.value as CloudSyncFrequency
                        })
                      }}
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </Input>
                  </FormGroup>
                </Col>
              )}
            </Row>

            <div className="d-flex gap-2 align-items-center mb-3">
              {cloud.data.syncing ? (
                <Button
                  color="warning"
                  outline
                  disabled={busy === 'cancel'}
                  onClick={() => void onCancelSync()}
                >
                  {busy === 'cancel' ? <Spinner size="sm" /> : 'Cancel sync'}
                </Button>
              ) : (
                <Button color="primary" disabled={busy === 'sync'} onClick={() => void onSync()}>
                  {busy === 'sync' ? <Spinner size="sm" /> : 'Sync now'}
                </Button>
              )}
            </div>

            <dl className="row mb-0">
              <dt className="col-sm-3">Last sync</dt>
              <dd className="col-sm-9">{formatDate(cloud.data.lastSync)}</dd>
              {cloud.data.lastSyncError && (
                <>
                  <dt className="col-sm-3">Last error</dt>
                  <dd className="col-sm-9 text-danger">{cloud.data.lastSyncError}</dd>
                </>
              )}
            </dl>
          </CardBody>
        </Card>
      )}
    </>
  )
}
