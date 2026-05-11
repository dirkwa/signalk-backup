import { useEffect, useMemo, useState } from 'react'
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
import { api, formatBytes } from '../api'
import { useApi } from '../useApi'

// ---------------------------------------------------------------------------
// Scheduler card
// ---------------------------------------------------------------------------
function SchedulerCard() {
  const status = useApi(() => api.scheduler(), { intervalMs: 15000 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onToggle = async (enabling: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (enabling) {
        await api.schedulerStart()
      } else {
        await api.schedulerStop()
      }
      status.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-3">
      <CardHeader>
        <strong>Scheduler</strong>
      </CardHeader>
      <CardBody>
        {status.loading && !status.data ? (
          <Spinner size="sm" />
        ) : status.error ? (
          <Alert color="danger" className="mb-0">
            {status.error}
          </Alert>
        ) : status.data ? (
          <>
            <div className="mb-2">
              <Badge color={status.data.enabled ? 'success' : 'secondary'}>
                {status.data.enabled ? 'Running' : 'Stopped'}
              </Badge>
            </div>
            <p className="text-muted small mb-3">
              When running, the backup-server creates hourly, daily, and weekly snapshots
              automatically per its retention policy. Manual backups still work either way.
            </p>
            {status.data.enabled ? (
              <Button color="warning" outline disabled={busy} onClick={() => void onToggle(false)}>
                {busy ? <Spinner size="sm" /> : 'Stop scheduler'}
              </Button>
            ) : (
              <Button color="primary" disabled={busy} onClick={() => void onToggle(true)}>
                {busy ? <Spinner size="sm" /> : 'Start scheduler'}
              </Button>
            )}
            {error && (
              <Alert color="danger" className="mt-2 mb-0">
                {error}
              </Alert>
            )}
          </>
        ) : null}
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Exclusions card
// ---------------------------------------------------------------------------
//
// The server returns three things:
//   - GET /exclusions         { exclusions: string[] }  — user-editable patterns
//   - GET /data-dirs          [{ name, size, excluded, type }]
//   - GET /plugin-data-dirs   [{ name, size, excluded, lockedExcluded, lockReason }]
// The data-dirs and plugin-data-dirs `excluded` booleans are computed on
// the server from the patterns above plus locked rules. We let the user
// toggle each dir; on Save we compute a new patterns list:
//   - keep raw patterns the user didn't touch (we can't introspect them
//     so just round-trip them)
//   - per-dir: emit "<name>/" when the user wants it excluded
// Locked plugin dirs are non-editable (the server enforces them anyway).
function ExclusionsCard() {
  const dirs = useApi(() => api.dataDirs())
  const pluginDirs = useApi(() => api.pluginDataDirs())
  const exclusions = useApi(() => api.exclusions())

  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Reset overrides whenever the server-side state changes (post-save reload,
  // or another client edited it).
  useEffect(() => {
    setOverrides({})
  }, [exclusions.data, dirs.data, pluginDirs.data])

  const allDirs: {
    name: string
    size: number
    excluded: boolean
    locked?: boolean
    lockReason?: string
  }[] = useMemo(() => {
    const result: {
      name: string
      size: number
      excluded: boolean
      locked?: boolean
      lockReason?: string
    }[] = []
    for (const d of dirs.data ?? []) {
      result.push({ name: d.name, size: d.size, excluded: d.excluded })
    }
    for (const p of pluginDirs.data ?? []) {
      result.push({
        name: `plugin-config-data/${p.name}/`,
        size: p.size,
        excluded: p.excluded,
        locked: p.lockedExcluded,
        lockReason: p.lockReason
      })
    }
    return result
  }, [dirs.data, pluginDirs.data])

  const isExcluded = (name: string, defaultExcluded: boolean): boolean =>
    overrides[name] ?? defaultExcluded

  // Toggle the dir's effective excluded state. If the new value matches
  // the server default, drop the override key entirely — otherwise Save
  // would stay enabled with no real diff to send.
  const toggle = (name: string, currentEffective: boolean, serverDefault: boolean): void => {
    const next = !currentEffective
    setOverrides((prev) => {
      if (next === serverDefault) {
        if (!(name in prev)) return prev
        return Object.fromEntries(Object.entries(prev).filter(([k]) => k !== name))
      }
      if (prev[name] === next) return prev
      return { ...prev, [name]: next }
    })
  }

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      // Build the new patterns: raw patterns the user couldn't edit
      // (anything that doesn't match a dir name or plugin path) +
      // <name> patterns for dirs the user wants excluded.
      const dirNames = new Set<string>()
      for (const d of dirs.data ?? []) dirNames.add(d.name + '/')
      for (const p of pluginDirs.data ?? []) dirNames.add(`plugin-config-data/${p.name}/`)

      const previousRawPatterns = (exclusions.data?.exclusions ?? []).filter(
        (p) => !dirNames.has(p)
      )

      const dirPatterns: string[] = []
      for (const d of dirs.data ?? []) {
        if (isExcluded(d.name, d.excluded)) dirPatterns.push(d.name + '/')
      }
      for (const p of pluginDirs.data ?? []) {
        const fullName = `plugin-config-data/${p.name}/`
        if (isExcluded(fullName, p.excluded)) dirPatterns.push(fullName)
      }

      const next = [...previousRawPatterns, ...dirPatterns]
      await api.setExclusions(next)
      exclusions.refresh()
      dirs.refresh()
      pluginDirs.refresh()
      setSavedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const dirty = Object.keys(overrides).length > 0

  return (
    <Card className="mb-3">
      <CardHeader>
        <strong>Backup exclusions</strong>
      </CardHeader>
      <CardBody>
        {dirs.loading || pluginDirs.loading || exclusions.loading ? (
          <Spinner size="sm" />
        ) : dirs.error || pluginDirs.error || exclusions.error ? (
          <Alert color="danger" className="mb-0">
            {dirs.error ?? pluginDirs.error ?? exclusions.error}
          </Alert>
        ) : (
          <>
            <p className="text-muted small mb-3">
              Uncheck a directory to exclude it from backups. Some plugin directories are
              locked-excluded by the server (live database state, our own kopia repo); see the note
              next to each.
            </p>
            <Table responsive striped size="sm" className="mb-3">
              <thead>
                <tr>
                  <th>Include</th>
                  <th>Directory</th>
                  <th>Size</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {allDirs.map((d) => {
                  const excluded = isExcluded(d.name, d.excluded)
                  return (
                    <tr key={d.name}>
                      <td>
                        <Input
                          type="checkbox"
                          checked={!excluded}
                          disabled={d.locked}
                          onChange={() => {
                            toggle(d.name, excluded, d.excluded)
                          }}
                          aria-label={`Include ${d.name}`}
                        />
                      </td>
                      <td>
                        <code className="small">{d.name}</code>
                      </td>
                      <td>{formatBytes(d.size)}</td>
                      <td className="text-muted small">{d.lockReason ?? ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>

            <div className="d-flex align-items-center gap-2">
              <Button color="primary" disabled={!dirty || saving} onClick={() => void onSave()}>
                {saving ? <Spinner size="sm" /> : 'Save'}
              </Button>
              {dirty && (
                <Button
                  color="secondary"
                  outline
                  disabled={saving}
                  onClick={() => {
                    setOverrides({})
                  }}
                >
                  Discard changes
                </Button>
              )}
              {savedAt && !dirty && <small className="text-success">Saved.</small>}
            </div>

            {error && (
              <Alert color="danger" className="mt-2 mb-0">
                {error}
              </Alert>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Encryption password card
// ---------------------------------------------------------------------------
function PasswordCard() {
  const status = useApi(() => api.passwordStatus(), { intervalMs: 0 })
  const [editing, setEditing] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  // Default masked — user opts in by clicking Show. Shoulder-surfing
  // protection only matters for custom passwords; the default kopia
  // password is publicly known anyway.
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  const onCopy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
      }, 1500)
    } catch {
      // Clipboard API can be blocked (non-HTTPS, permissions); fall
      // back silently — the user can still see + select-to-copy.
    }
  }

  const onSave = async (): Promise<void> => {
    setError(null)
    setSuccess(null)
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    setSaving(true)
    try {
      await api.setPassword(password)
      setEditing(false)
      setPassword('')
      setConfirm('')
      status.refresh()
      setSuccess('Password updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const onReset = async (): Promise<void> => {
    setResetting(true)
    setError(null)
    try {
      await api.resetPassword()
      setConfirmReset(false)
      status.refresh()
      setSuccess('Password reset to default.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResetting(false)
    }
  }

  const hasCustom = status.data?.hasCustomPassword ?? false

  return (
    <Card>
      <CardHeader>
        <strong>Encryption password</strong>
      </CardHeader>
      <CardBody>
        <p className="text-muted small mb-3">
          The kopia repository is encrypted at rest with this password. The default is publicly
          known; set a custom one if your backup destination (cloud sync, external drive) is
          accessible to anyone besides you.{' '}
          <strong>Forgetting your custom password makes existing backups unreadable.</strong>
        </p>

        {status.loading && !status.data ? (
          <Spinner size="sm" />
        ) : status.error ? (
          <Alert color="danger" className="mb-0">
            {status.error}
          </Alert>
        ) : (
          <>
            <div className="mb-3">
              <Badge color={hasCustom ? 'success' : 'warning'}>
                {hasCustom ? 'Custom password set' : 'Default password (publicly known)'}
              </Badge>
            </div>

            {!editing && status.data?.password
              ? (() => {
                  const pw = status.data.password
                  return (
                    <FormGroup>
                      <Label for="current-password">Current password</Label>
                      <div className="d-flex gap-2 align-items-center">
                        <Input
                          id="current-password"
                          type={revealed ? 'text' : 'password'}
                          value={pw}
                          readOnly
                          style={{ fontFamily: 'monospace', maxWidth: '24rem' }}
                        />
                        <Button
                          size="sm"
                          color="secondary"
                          outline
                          onClick={() => {
                            setRevealed((v) => !v)
                          }}
                          aria-label={revealed ? 'Hide password' : 'Show password'}
                        >
                          {revealed ? 'Hide' : 'Show'}
                        </Button>
                        <Button
                          size="sm"
                          color="secondary"
                          outline
                          onClick={() => {
                            void onCopy(pw)
                          }}
                        >
                          {copied ? 'Copied!' : 'Copy'}
                        </Button>
                      </div>
                    </FormGroup>
                  )
                })()
              : null}

            {editing ? (
              <Form
                onSubmit={(e) => {
                  e.preventDefault()
                  void onSave()
                }}
              >
                <FormGroup>
                  <Label for="new-password">New password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                    }}
                    minLength={8}
                    required
                    disabled={saving}
                    autoComplete="new-password"
                  />
                </FormGroup>
                <FormGroup>
                  <Label for="confirm-password">Confirm password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.target.value)
                    }}
                    minLength={8}
                    required
                    disabled={saving}
                    autoComplete="new-password"
                  />
                </FormGroup>
                <div className="d-flex gap-2">
                  <Button color="primary" type="submit" disabled={saving}>
                    {saving ? <Spinner size="sm" /> : 'Save'}
                  </Button>
                  <Button
                    color="secondary"
                    outline
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setEditing(false)
                      setPassword('')
                      setConfirm('')
                      setError(null)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </Form>
            ) : (
              <div className="d-flex flex-wrap gap-2 align-items-center">
                <Button
                  color="primary"
                  onClick={() => {
                    setEditing(true)
                    setError(null)
                    setSuccess(null)
                  }}
                >
                  {hasCustom ? 'Change password' : 'Set custom password'}
                </Button>
                {hasCustom &&
                  (confirmReset ? (
                    <>
                      <span>Reset to default?</span>
                      <Button
                        color="warning"
                        size="sm"
                        disabled={resetting}
                        onClick={() => void onReset()}
                      >
                        {resetting ? <Spinner size="sm" /> : 'Reset'}
                      </Button>
                      <Button
                        color="secondary"
                        outline
                        size="sm"
                        disabled={resetting}
                        onClick={() => {
                          setConfirmReset(false)
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      color="warning"
                      outline
                      onClick={() => {
                        setConfirmReset(true)
                      }}
                    >
                      Reset to default
                    </Button>
                  ))}
              </div>
            )}

            {error && (
              <Alert color="danger" className="mt-3 mb-0">
                {error}
              </Alert>
            )}
            {success && (
              <Alert
                color="success"
                className="mt-3 mb-0"
                toggle={() => {
                  setSuccess(null)
                }}
              >
                {success}
              </Alert>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function Settings() {
  return (
    <>
      <h2 className="mb-3">Settings</h2>
      <SchedulerCard />
      <ExclusionsCard />
      <PasswordCard />
    </>
  )
}
