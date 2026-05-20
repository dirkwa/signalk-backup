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
  type BackupMetadata,
  type BackupTreeEntry,
  type PartialRestoreConflict,
  type PartialRestoreInput,
  type PartialRestoreTargetMode
} from '../api'

interface Props {
  backup: BackupMetadata
  sourceEntry: BackupTreeEntry
  /** Path inside the snapshot, relative to root. */
  sourcePath: string
  onClose: () => void
  /** Called after the server accepts the request (HTTP 202). */
  onSubmitted: () => void
}

export function PartialRestoreModal({
  backup,
  sourceEntry,
  sourcePath,
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
      await api.restorePartial(backup.id, buildInput(confirmOverwrite))
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
              Custom path (must resolve under SignalK config root)
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
                placeholder="e.g. restored/settings.json"
              />
              <small className="text-muted">
                Relative or absolute. Absolute paths must stay inside the SignalK config root; the
                server rejects anything that resolves outside.
              </small>
            </FormGroup>
          )}
        </FormGroup>

        {conflict && (
          <Alert color="warning" className="mt-3 mb-0">
            <div className="fw-semibold">Target already exists</div>
            <div className="small mb-2">
              <code>{conflict.targetPath}</code>
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
