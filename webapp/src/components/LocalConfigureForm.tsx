import { useEffect, useState } from 'react'
import { Alert, Button, FormGroup, Input, Label, Spinner } from 'reactstrap'
import { api, type LocalCandidate } from '../api'

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

interface Props {
  /** Called once a destination has been successfully configured. */
  onConfigured: () => void
  onError: (msg: string) => void
}

// Map a host-side path the user types (e.g. `/media/dirk/USB-SSD`) to
// the equivalent container-side path the backup engine sees. Returns
// null when the host path isn't under one of the bind-mounted prefixes
// so the caller can surface a clear validation error instead of letting
// the server reject it later.
//
// Defense in depth against path traversal: any `..` segment short-
// circuits to null. The backend re-validates with realpath, but
// catching it here gives a clearer UI error and avoids round-tripping
// obvious junk to the server.
function hostPathToContainerPath(hostPath: string): string | null {
  const normalized = hostPath.trim().replace(/\/+$/, '')
  if (normalized.split('/').some((segment) => segment === '..')) {
    return null
  }
  if (normalized === '/media' || normalized.startsWith('/media/')) {
    return '/host-media' + normalized.slice('/media'.length)
  }
  if (normalized === '/mnt' || normalized.startsWith('/mnt/')) {
    return '/host-mnt' + normalized.slice('/mnt'.length)
  }
  return null
}

/**
 * Picker for the `local` destination. Lists candidates from
 * /cloud/local/discover (subdirectories of `/media` and `/mnt` on the
 * host, surfaced inside the container under `/host-media` and
 * `/host-mnt`) and lets the user pick one. A manual host-path text
 * field is the escape hatch for paths that don't show up in discovery.
 */
export function LocalConfigureForm({ onConfigured, onError }: Props) {
  const [candidates, setCandidates] = useState<LocalCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState<string>('')
  const [manualPath, setManualPath] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  const scan = async (): Promise<void> => {
    setScanning(true)
    try {
      const { candidates } = await api.localDiscover()
      setCandidates(candidates)

      // If the user had picked a path that's no longer in the discovery
      // list (drive unplugged, mount removed), drop the stale selection
      // so the dropdown doesn't keep showing it as "—" or letting them
      // submit a vanished path.
      const stillPresent = selected && candidates.some((c) => c.containerPath === selected)
      if (selected && !stillPresent) {
        setSelected('')
      }

      // Auto-select the largest free-bytes *writable* candidate if the
      // user hasn't picked one — saves a click in the common single-
      // USB case. Skip read-only / not-writable entries (CD-ROM, root-
      // owned dirs) so we never auto-pick something that would fail at
      // submit time. `writable === undefined` is treated as "unknown,
      // include" for compatibility with older engines that didn't ship
      // the field.
      if ((!selected || !stillPresent) && candidates.length > 0) {
        const eligible = candidates.filter((c) => c.writable !== false)
        const [best] = [...eligible].sort((a, b) => (b.freeBytes ?? 0) - (a.freeBytes ?? 0))
        if (best) setSelected(best.containerPath)
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  // Run once on mount; user can re-trigger via "Re-scan" button. The
  // empty-deps array is intentional — `scan` doesn't depend on props.
  useEffect(() => {
    void scan()
  }, [])

  const submit = async (containerPath: string, hostPath: string): Promise<void> => {
    setSubmitting(true)
    try {
      await api.localConfigure(containerPath, hostPath)
      onConfigured()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const onUseSelected = (): void => {
    const c = candidates?.find((c) => c.containerPath === selected)
    if (!c) return
    void submit(c.containerPath, c.hostPath)
  }

  const onUseManual = (): void => {
    const hostPath = manualPath.trim()
    if (!hostPath) return
    const containerPath = hostPathToContainerPath(hostPath)
    if (!containerPath) {
      onError(
        `Path must live under /media or /mnt — those are the only host ` +
          `locations the backup engine can see. Plug a USB drive in (it ` +
          `auto-mounts under /media), or have the system administrator ` +
          `mount your destination under /mnt.`
      )
      return
    }
    void submit(containerPath, hostPath)
  }

  return (
    <div>
      <FormGroup>
        <Label for="local-candidate">Pick a drive or mounted folder</Label>
        <div className="d-flex gap-2">
          <Input
            id="local-candidate"
            type="select"
            value={selected}
            disabled={scanning || submitting}
            onChange={(e) => {
              setSelected(e.target.value)
            }}
          >
            <option value="">— select —</option>
            {(candidates ?? []).map((c) => {
              const sizeSuffix =
                c.freeBytes != null && c.totalBytes != null
                  ? ` (${formatBytes(c.freeBytes)} free of ${formatBytes(c.totalBytes)})`
                  : ''
              // Non-writable entries (CD-ROMs, root-owned dirs) stay in
              // the list so the user can see they exist but can't be
              // picked. The suffix names *why* so the user can act.
              const writableSuffix = c.writable === false ? ' — not writable' : ''
              return (
                <option
                  key={c.containerPath}
                  value={c.containerPath}
                  disabled={c.writable === false}
                >
                  {c.hostPath}
                  {sizeSuffix}
                  {writableSuffix}
                </option>
              )
            })}
          </Input>
          <Button
            color="secondary"
            outline
            disabled={scanning || submitting}
            onClick={() => void scan()}
            title="Re-scan /media and /mnt"
          >
            {scanning ? <Spinner size="sm" /> : 'Re-scan'}
          </Button>
        </div>
      </FormGroup>

      {candidates !== null && candidates.length === 0 && (
        <Alert color="warning" className="mt-2 mb-2">
          No candidates found. Plug in a USB drive (and mount it under
          <code> /media</code>), or mount a network share under <code>/mnt</code>
          on the host, then click <strong>Re-scan</strong>.
        </Alert>
      )}

      <Button
        color="primary"
        disabled={!selected || submitting}
        onClick={onUseSelected}
        className="me-2"
      >
        {submitting ? <Spinner size="sm" /> : 'Use this'}
      </Button>

      <hr className="my-3" />

      <FormGroup>
        <Label for="manual-path">Or type a host path manually</Label>
        <div className="d-flex gap-2">
          <Input
            id="manual-path"
            type="text"
            placeholder="/media/dirk/USB-SSD or /mnt/nfs-share"
            value={manualPath}
            disabled={submitting}
            onChange={(e) => {
              setManualPath(e.target.value)
            }}
          />
          <Button
            color="secondary"
            disabled={!manualPath.trim() || submitting}
            onClick={onUseManual}
          >
            Use
          </Button>
        </div>
        <small className="text-muted">
          Enter the path the way you see it on the host — <code>/media/...</code> for plugged-in USB
          drives, <code>/mnt/...</code> for network shares mounted by the system. The backup engine
          sees the same locations.
        </small>
      </FormGroup>
    </div>
  )
}
