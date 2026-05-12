import { useEffect, useState } from 'react'
import { Alert, Button, FormGroup, Input, Label, Spinner } from 'reactstrap'
import { api, type SmbDiscoveredHost } from '../api'

interface Props {
  /** Called after a successful /cloud/smb/connect. */
  onConnected: () => void
  onError: (msg: string) => void
}

/**
 * SMB share configurator.
 *
 * On mount, runs mDNS discovery on _smb._tcp.local. Returns whatever
 * responds within 2s; an empty list isn't an error, the manual host
 * field below works regardless. The plugin runs the discovery in the
 * SignalK process so multicast doesn't have to cross the backup-server
 * container's network.
 *
 * Credentials are stored in clear text in rclone.conf (matches what
 * `rclone config` writes by default). The warning surfaces this to
 * the user.
 */
export function SmbConnectForm({ onConnected, onError }: Props) {
  const [hosts, setHosts] = useState<SmbDiscoveredHost[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [host, setHost] = useState('')
  const [share, setShare] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [domain, setDomain] = useState('')

  const scan = async (): Promise<void> => {
    setScanning(true)
    try {
      const { hosts } = await api.smbDiscover()
      setHosts(hosts)
    } catch (err) {
      // Opportunistic — manual host entry still works. Don't fire the
      // top-level onError (which surfaces a global red Alert) for what
      // the user didn't explicitly ask for.
      // eslint-disable-next-line no-console
      console.debug('SMB mDNS discovery failed:', err)
      setHosts([])
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void scan()
    // Empty deps; user can re-trigger via "Re-scan".
  }, [])

  const submit = async (e?: React.SyntheticEvent): Promise<void> => {
    e?.preventDefault()
    if (!host.trim() || !share.trim() || !user.trim() || !password) return
    setSubmitting(true)
    try {
      await api.smbConnect({
        host: host.trim(),
        share: share.trim(),
        user: user.trim(),
        password,
        ...(domain.trim() ? { domain: domain.trim() } : {})
      })
      // Wipe the password from local state on success — there's no
      // reason to keep it around once it's persisted in rclone.conf.
      setPassword('')
      onConnected()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Alert color="warning" className="mb-3 small">
        <strong>Heads up:</strong> SMB credentials are stored in plain text in rclone&apos;s config
        file (mode 0o600, owner-only). Anyone with read access to the backup-server container can
        see the password.
      </Alert>

      <FormGroup>
        <Label for="smb-host">Host</Label>
        <div className="d-flex gap-2">
          <Input
            id="smb-host"
            type="text"
            placeholder="synology.local or 192.168.1.50"
            value={host}
            disabled={submitting}
            onChange={(e) => {
              setHost(e.target.value)
            }}
            list="smb-discovered-hosts"
            required
          />
          <Button
            color="secondary"
            outline
            type="button"
            disabled={scanning || submitting}
            onClick={() => void scan()}
            title="Re-scan _smb._tcp.local on the LAN"
          >
            {scanning ? <Spinner size="sm" /> : 'Scan LAN'}
          </Button>
        </div>
        {hosts !== null && hosts.length > 0 && (
          <datalist id="smb-discovered-hosts">
            {hosts.map((h) => (
              <option key={h.address} value={h.address}>
                {h.name}
              </option>
            ))}
          </datalist>
        )}
        {hosts !== null && hosts.length === 0 && !scanning && (
          <small className="text-muted">
            No SMB devices announced on the LAN — type the host manually.
          </small>
        )}
      </FormGroup>

      <FormGroup>
        <Label for="smb-share">Share</Label>
        <Input
          id="smb-share"
          type="text"
          placeholder="backups"
          value={share}
          disabled={submitting}
          onChange={(e) => {
            setShare(e.target.value)
          }}
          required
        />
      </FormGroup>

      <FormGroup>
        <Label for="smb-user">Username</Label>
        <Input
          id="smb-user"
          type="text"
          autoComplete="off"
          value={user}
          disabled={submitting}
          onChange={(e) => {
            setUser(e.target.value)
          }}
          required
        />
      </FormGroup>

      <FormGroup>
        <Label for="smb-password">Password</Label>
        <Input
          id="smb-password"
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={submitting}
          onChange={(e) => {
            setPassword(e.target.value)
          }}
          required
        />
      </FormGroup>

      <FormGroup>
        <Label for="smb-domain">Domain (optional)</Label>
        <Input
          id="smb-domain"
          type="text"
          placeholder="WORKGROUP"
          value={domain}
          disabled={submitting}
          onChange={(e) => {
            setDomain(e.target.value)
          }}
        />
      </FormGroup>

      <Button color="primary" type="submit" disabled={submitting}>
        {submitting ? <Spinner size="sm" /> : 'Connect'}
      </Button>
    </form>
  )
}
