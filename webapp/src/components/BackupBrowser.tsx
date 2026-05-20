import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner
} from 'reactstrap'
import {
  api,
  formatBytes,
  type BackupMetadata,
  type BackupTreeEntry,
  type PartialRestoreInput
} from '../api'
import { PartialRestoreModal } from './PartialRestoreModal'

interface Props {
  backup: BackupMetadata
  isOpen: boolean
  onClose: () => void
  /** Optional sub-path to scope the browser to. Empty = snapshot root.
   *  Used by the Database Exports view to root the picker on the
   *  database-exports subtree. */
  initialPath?: string
  /** Called when a partial restore is kicked off; the parent should
   *  refresh its restore-status poller so the banner appears quickly. */
  onRestoreStarted?: () => void
}

interface FolderState {
  // null while loading, string when an error happened, array when loaded.
  entries: BackupTreeEntry[] | null
  error: string | null
}

// Per-folder lazy cache keyed by full path-from-root (or '' for root).
// Empty string is the snapshot root by convention with the server.
type Cache = Record<string, FolderState | undefined>

function joinPath(prefix: string, name: string): string {
  if (!prefix) return name
  return `${prefix}/${name}`
}

export function BackupBrowser({ backup, isOpen, onClose, initialPath, onRestoreStarted }: Props) {
  const rootPath = (initialPath ?? '').replace(/^\/+|\/+$/g, '')
  const [cache, setCache] = useState<Cache>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]))
  const [restoreTarget, setRestoreTarget] = useState<
    (BackupTreeEntry & { fullPath: string }) | null
  >(null)

  // Reset when the user opens the browser against a different backup or
  // root — without this, switching backups would show stale entries from
  // the previous one until each folder was re-fetched.
  useEffect(() => {
    if (!isOpen) return
    setCache({})
    setExpanded(new Set([rootPath]))
    setRestoreTarget(null)
  }, [isOpen, backup.id, rootPath])

  const loadFolder = useCallback(
    async (folderPath: string): Promise<void> => {
      setCache((c) => ({ ...c, [folderPath]: { entries: null, error: null } }))
      try {
        const res = await api.listBackupTree(backup.id, folderPath)
        setCache((c) => ({ ...c, [folderPath]: { entries: res.entries, error: null } }))
      } catch (err) {
        setCache((c) => ({
          ...c,
          [folderPath]: {
            entries: null,
            error: err instanceof Error ? err.message : String(err)
          }
        }))
      }
    },
    [backup.id]
  )

  // Auto-load the root (and any pre-expanded path) when the modal opens.
  useEffect(() => {
    if (!isOpen) return
    if (cache[rootPath] === undefined) {
      void loadFolder(rootPath)
    }
  }, [isOpen, rootPath, cache, loadFolder])

  const toggleFolder = (folderPath: string): void => {
    const next = new Set(expanded)
    if (next.has(folderPath)) {
      next.delete(folderPath)
    } else {
      next.add(folderPath)
      if (cache[folderPath] === undefined) {
        void loadFolder(folderPath)
      }
    }
    setExpanded(next)
  }

  const startRestore = (entry: BackupTreeEntry, fullPath: string): void => {
    setRestoreTarget({ ...entry, fullPath })
  }

  const onRestoreSubmitted = (): void => {
    setRestoreTarget(null)
    onRestoreStarted?.()
    // Don't close the browser — the user might want to grab another file.
  }

  return (
    <Modal isOpen={isOpen} toggle={onClose} size="lg" scrollable>
      <ModalHeader toggle={onClose}>
        Browse backup <code className="small ms-1">{backup.id.slice(0, 12)}</code>
      </ModalHeader>
      <ModalBody>
        <div className="text-muted small mb-2">
          {rootPath ? (
            <>
              Scoped to <code>{rootPath}/</code>
            </>
          ) : (
            <>Showing snapshot root</>
          )}
        </div>
        <FolderNode
          backupId={backup.id}
          path={rootPath}
          depth={0}
          cache={cache}
          expanded={expanded}
          onToggle={toggleFolder}
          onRetry={loadFolder}
          onStartRestore={startRestore}
        />
      </ModalBody>
      <ModalFooter>
        <Button color="secondary" outline onClick={onClose}>
          Close
        </Button>
      </ModalFooter>

      {restoreTarget && (
        <PartialRestoreModal
          backup={backup}
          sourceEntry={restoreTarget}
          sourcePath={restoreTarget.fullPath}
          onClose={() => {
            setRestoreTarget(null)
          }}
          onSubmitted={onRestoreSubmitted}
        />
      )}
    </Modal>
  )
}

interface NodeProps {
  backupId: string
  path: string
  depth: number
  cache: Cache
  expanded: Set<string>
  onToggle: (path: string) => void
  onRetry: (path: string) => Promise<void>
  onStartRestore: (entry: BackupTreeEntry, fullPath: string) => void
}

function FolderNode({
  backupId,
  path: folderPath,
  depth,
  cache,
  expanded,
  onToggle,
  onRetry,
  onStartRestore
}: NodeProps) {
  const state = cache[folderPath]

  if (!state || (state.entries === null && !state.error)) {
    return (
      <div className="ps-3 py-1">
        <Spinner size="sm" /> Loading…
      </div>
    )
  }
  if (state.error) {
    return (
      <div className="ps-3 py-1">
        <Alert color="danger" className="mb-1 py-1 small">
          {state.error}
        </Alert>
        <Button size="sm" color="secondary" outline onClick={() => void onRetry(folderPath)}>
          Retry
        </Button>
      </div>
    )
  }
  const entries = state.entries ?? []
  if (entries.length === 0) {
    return <div className="ps-3 py-1 text-muted small">(empty)</div>
  }

  // Sort: dirs first, then alphabetical. Same convention as a typical
  // file manager — keeps the tree scannable when a folder has many files
  // mixed with a handful of subdirectories.
  const sorted = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <ul className="list-unstyled mb-0" style={{ marginLeft: depth === 0 ? 0 : '1rem' }}>
      {sorted.map((entry) => {
        const fullPath = joinPath(folderPath, entry.name)
        const isExpanded = entry.isDir && expanded.has(fullPath)
        return (
          <li key={entry.name} className="py-1">
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <Button
                color="link"
                size="sm"
                className="p-0 text-decoration-none"
                onClick={() => {
                  if (entry.isDir) onToggle(fullPath)
                }}
                style={{ minWidth: '1.2em' }}
                aria-expanded={entry.isDir ? isExpanded : undefined}
              >
                {entry.isDir ? (isExpanded ? '▾' : '▸') : ''}
              </Button>
              <span
                className={entry.isDir ? 'fw-semibold' : ''}
                onClick={() => {
                  if (entry.isDir) onToggle(fullPath)
                }}
                style={entry.isDir ? { cursor: 'pointer' } : undefined}
              >
                {entry.name}
                {entry.isDir ? '/' : ''}
              </span>
              {!entry.isDir && <span className="text-muted small">{formatBytes(entry.size)}</span>}
              <span className="ms-auto">
                <a
                  href={api.downloadSubtreeUrl(backupId, fullPath)}
                  className="btn btn-outline-secondary btn-sm me-1"
                  download
                >
                  Download
                  {entry.isDir && (
                    <Badge color="light" className="text-dark ms-1">
                      ZIP
                    </Badge>
                  )}
                </a>
                <Button
                  color="warning"
                  outline
                  size="sm"
                  onClick={() => {
                    onStartRestore(entry, fullPath)
                  }}
                >
                  Restore…
                </Button>
              </span>
            </div>
            {entry.isDir && isExpanded && (
              <FolderNode
                backupId={backupId}
                path={fullPath}
                depth={depth + 1}
                cache={cache}
                expanded={expanded}
                onToggle={onToggle}
                onRetry={onRetry}
                onStartRestore={onStartRestore}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

// Re-export the type used by the restore modal so callers don't have to
// import both files.
export type { PartialRestoreInput }
