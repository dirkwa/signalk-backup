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

/**
 * Picker for the `local` destination. Lists candidates from
 * /cloud/local/discover (subdirs of /host-media + /host-mnt) and lets
 * the user pick one. A manual `containerPath` text field is the escape
 * hatch for paths that don't show up in discovery.
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

      // Auto-select the largest free-bytes candidate if the user hasn't
      // picked one — saves a click in the common single-USB case.
      if ((!selected || !stillPresent) && candidates.length > 0) {
        const [best] = [...candidates].sort((a, b) => (b.freeBytes ?? 0) - (a.freeBytes ?? 0))
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
    if (!manualPath.trim()) return
    // Manual path must already be the container-side path (under
    // /host-media or /host-mnt). Server validates and rejects with 400
    // if not.
    void submit(manualPath.trim(), manualPath.trim())
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
            {(candidates ?? []).map((c) => (
              <option key={c.containerPath} value={c.containerPath}>
                {c.hostPath}
                {c.freeBytes != null && c.totalBytes != null
                  ? ` (${formatBytes(c.freeBytes)} free of ${formatBytes(c.totalBytes)})`
                  : ''}
              </option>
            ))}
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
        <Label for="manual-path">Or type a container path manually</Label>
        <div className="d-flex gap-2">
          <Input
            id="manual-path"
            type="text"
            placeholder="/host-media/USB-SSD or /host-mnt/nfs-share"
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
          Path must live under <code>/host-media</code> or <code>/host-mnt</code> — those are the
          baseline mounts the backup engine sees from the host.
        </small>
      </FormGroup>
    </div>
  )
}
