import { useState } from 'react'
import {
  Alert,
  Button,
  FormGroup,
  Input,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner
} from 'reactstrap'
import {
  api,
  formatBytes,
  formatDate,
  PartialRestoreConflictError,
  toHostPath,
  type BackupMetadata,
  type BackupTreeEntry,
  type PartialRestoreConflict,
  type PartialRestoreInput,
  type PartialRestoreTargetMode,
  type PluginStatus
} from '../api'

interface Props {
  backup: BackupMetadata
  sourceEntry: BackupTreeEntry
  /** Path inside the snapshot, relative to root. */
  sourcePath: string
  /** Container→host path mapping; passed through from the parent so
   *  conflict-diff targets display as user-meaningful host paths. */
  pathMapping?: PluginStatus['pathMapping']
  onClose: () => void
  /** Called after the server accepts the request (HTTP 202). */
  onSubmitted: () => void
}

export function PartialRestoreModal({
  backup,
  sourceEntry,
  sourcePath,
  pathMapping,
  onClose,
  onSubmitted
}: Props) {
  const [mode, setMode] = useState<PartialRestoreTargetMode>('original')
  const [customPath, setCustomPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<PartialRestoreConflict | null>(null)

  const buildInput = (confirmOverwrite: boolean): PartialRestoreInput => ({
    sourcePath,
    targetMode: mode,
    ...(mode === 'custom' ? { customPath: customPath.trim() } : {}),
    confirmOverwrite
  })

  const submit = async (confirmOverwrite: boolean): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      // Custom-mode goes through the plugin's host-write route so the
      // restore can land anywhere the SignalK process can write,
      // including paths outside the container's view (/tmp, /media/*).
      // Original-mode stays on the container path because it
      // overwrites the live SignalK tree.
      if (mode === 'custom') {
        await api.restorePartialHost({
          backupId: backup.id,
          sourcePath,
          customPath: customPath.trim(),
          isDir: sourceEntry.isDir,
          confirmOverwrite
        })
      } else {
        await api.restorePartial(backup.id, buildInput(confirmOverwrite))
      }
      onSubmitted()
    } catch (err) {
      if (err instanceof PartialRestoreConflictError) {
        setConflict(err.conflict)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const disableSubmit = submitting || (mode === 'custom' && customPath.trim().length === 0)

  return (
    <Modal isOpen toggle={submitting ? undefined : onClose} size="md" backdrop="static">
      <ModalHeader toggle={submitting ? undefined : onClose}>
        Restore {sourceEntry.isDir ? 'directory' : 'file'}
      </ModalHeader>
      <ModalBody>
        <div className="mb-3 small text-muted">
          Source:{' '}
          <code>
            {sourcePath}
            {sourceEntry.isDir ? '/' : ''}
          </code>{' '}
          ({formatBytes(sourceEntry.size)})
        </div>

        <FormGroup tag="fieldset" disabled={submitting}>
          <legend className="h6">Restore target</legend>
          <FormGroup check>
            <Label check>
              <Input
                type="radio"
                name="partial-restore-mode"
                checked={mode === 'original'}
                onChange={() => {
                  setMode('original')
                  setConflict(null)
                }}
              />{' '}
              Original location (under SignalK config root)
            </Label>
          </FormGroup>
          <FormGroup check>
            <Label check>
              <Input
                type="radio"
                name="partial-restore-mode"
                checked={mode === 'custom'}
                onChange={() => {
                  setMode('custom')
                  setConflict(null)
                }}
              />{' '}
              Custom path (anywhere the SignalK user can write)
            </Label>
          </FormGroup>
          {mode === 'custom' && (
            <FormGroup className="mt-2">
              <Label for="partial-restore-custom-path">Custom path</Label>
              <Input
                id="partial-restore-custom-path"
                value={customPath}
                onChange={(e) => {
                  setCustomPath(e.target.value)
                  setConflict(null)
                }}
                placeholder="e.g. /tmp/restored or /media/usb/backups/"
              />
              <small className="text-muted">
                Relative or absolute. The plugin writes locally under the SignalK process's
                permissions, so anywhere your user can write works — including /tmp, /media/usb/…,
                or under your home directory. Add a trailing slash to land inside as a directory.
              </small>
            </FormGroup>
          )}
        </FormGroup>

        {conflict && (
          <Alert color="warning" className="mt-3 mb-0">
            <div className="fw-semibold">Target already exists</div>
            <div className="small mb-2">
              <code>{toHostPath(conflict.targetPath, pathMapping)}</code>
            </div>
            <div className="small">
              <div>
                Existing size: {conflict.size != null ? formatBytes(conflict.size) : 'unknown'}
              </div>
              <div>Existing mtime: {conflict.mtime ? formatDate(conflict.mtime) : 'unknown'}</div>
              <div>Snapshot entry size: {formatBytes(sourceEntry.size)}</div>
              <div>Snapshot entry mtime: {sourceEntry.mtime}</div>
            </div>
            <div className="mt-2 d-flex gap-2">
              <Button
                color="danger"
                size="sm"
                disabled={submitting}
                onClick={() => void submit(true)}
              >
                {submitting ? <Spinner size="sm" /> : 'Overwrite'}
              </Button>
              <Button
                color="secondary"
                outline
                size="sm"
                disabled={submitting}
                onClick={() => {
                  setConflict(null)
                }}
              >
                Cancel
              </Button>
            </div>
          </Alert>
        )}

        {error && (
          <Alert color="danger" className="mt-3 mb-0">
            {error}
          </Alert>
        )}
      </ModalBody>
      <ModalFooter>
        <Button color="secondary" outline disabled={submitting} onClick={onClose}>
          Cancel
        </Button>
        <Button
          color="primary"
          disabled={disableSubmit || conflict !== null}
          onClick={() => void submit(false)}
        >
          {submitting ? (
            <>
              <Spinner size="sm" /> Starting…
            </>
          ) : (
            'Restore'
          )}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
