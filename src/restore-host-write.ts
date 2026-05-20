// Plugin-side "restore to anywhere on the host" route. Bypasses the
// backup-server container's filesystem entirely: the plugin streams
// the requested sub-path from /api/backups/:id/download-subtree on the
// upstream and writes the bytes locally under the SignalK process's
// permissions. That lets the user pick paths the container can't see
// (/tmp, /media/usb/..., ~/wherever), which the in-container kopia
// restore couldn't reach.

import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { IRouter, Request, Response } from 'express'
import unzipper from 'unzipper'

export interface RestoreHostWriteOptions {
  /**
   * Resolve the upstream base URL (e.g. `http://127.0.0.1:3010`) for
   * the backup-server. Returns null when the container isn't ready —
   * the route surfaces that as 503 so the UI can surface "wait and
   * retry".
   */
  getUpstreamBase: () => string | null
  /** Optional debug logger. */
  log?: (msg: string) => void
}

// Status of the in-flight restore. Mirrors the partial-restore-service
// shape so the UI can poll the same way for both code paths.
export interface HostRestoreStatus {
  state:
    | 'idle'
    | 'preparing'
    | 'streaming'
    | 'extracting'
    | 'completed'
    | 'failed'
    | 'rolling_back'
    | 'rolled_back'
  progress: number
  statusMessage: string
  error?: string
  backupId?: string
  sourcePath?: string
  targetPath?: string
}

interface HostRestoreRequest {
  backupId: string
  sourcePath: string
  customPath: string
  /** Set by the caller (matches the snapshot entry's isDir). */
  isDir: boolean
  confirmOverwrite?: boolean
}

class HostRestoreState {
  status: HostRestoreStatus = {
    state: 'idle',
    progress: 0,
    statusMessage: ''
  }

  reset(): void {
    this.status = { state: 'idle', progress: 0, statusMessage: '' }
  }

  isRunning(): boolean {
    return ['preparing', 'streaming', 'extracting', 'rolling_back'].includes(this.status.state)
  }
}

const state = new HostRestoreState()

export function registerHostRestoreRoutes(router: IRouter, opts: RestoreHostWriteOptions): void {
  router.get('/api/restore-partial-host/status', (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: state.status,
      timestamp: new Date().toISOString()
    })
  })

  router.post('/api/restore-partial-host/reset', (_req: Request, res: Response) => {
    state.reset()
    res.json({
      success: true,
      data: { message: 'Host-restore state reset' },
      timestamp: new Date().toISOString()
    })
  })

  router.post('/api/restore-partial-host', async (req: Request, res: Response) => {
    const body = req.body as Partial<HostRestoreRequest>
    if (
      typeof body.backupId !== 'string' ||
      typeof body.sourcePath !== 'string' ||
      typeof body.customPath !== 'string' ||
      typeof body.isDir !== 'boolean'
    ) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'backupId, sourcePath, customPath, isDir are required'
        },
        timestamp: new Date().toISOString()
      })
      return
    }
    const { backupId, sourcePath, customPath, isDir, confirmOverwrite } = body as HostRestoreRequest

    // Same sourcePath safety as the server: reject .. segments and NUL
    // bytes. We don't run the original-mode reject-list (package.json
    // etc.) — the explicit point of host-restore is "copy anywhere I
    // can write", so the in-container side-effect concerns don't apply.
    if (sourcePath.includes('\0') || customPath.includes('\0')) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'paths must not contain NUL bytes' },
        timestamp: new Date().toISOString()
      })
      return
    }
    if (sourcePath.split('/').some((p) => p === '..')) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'sourcePath must not contain ".." segments' },
        timestamp: new Date().toISOString()
      })
      return
    }

    if (state.isRunning()) {
      res.status(409).json({
        success: false,
        error: {
          code: 'RESTORE_IN_PROGRESS',
          message: 'A host-restore is already in progress'
        },
        timestamp: new Date().toISOString()
      })
      return
    }

    const target = resolveHostTarget(customPath, isDir, sourcePath)

    // Conflict probe — surface the existing entry so the UI shows a diff.
    if (!confirmOverwrite) {
      const existing = await safeStat(target.absoluteTarget)
      if (existing) {
        res.status(409).json({
          success: false,
          error: {
            code: 'TARGET_EXISTS',
            message: `Target '${target.absoluteTarget}' already exists; resubmit with confirmOverwrite=true to proceed`
          },
          data: {
            conflict: {
              targetPath: target.absoluteTarget,
              mtime: existing.mtime.toISOString(),
              size: existing.size
            }
          },
          timestamp: new Date().toISOString()
        })
        return
      }
    }

    const base = opts.getUpstreamBase()
    if (!base) {
      res.status(503).json({
        success: false,
        error: { code: 'UPSTREAM_NOT_READY', message: 'backup-server not ready' },
        timestamp: new Date().toISOString()
      })
      return
    }

    // Kick off async; respond 202. The status route is the truth.
    state.status = {
      state: 'preparing',
      progress: 0,
      statusMessage: 'Preparing host-restore…',
      backupId,
      sourcePath,
      targetPath: target.absoluteTarget
    }
    res.status(202).json({
      success: true,
      data: { started: true },
      timestamp: new Date().toISOString()
    })

    runRestore({
      backupId,
      sourcePath,
      isDir,
      target,
      upstreamBase: base,
      log: opts.log
    }).catch((err: unknown) => {
      opts.log?.(`host-restore failed: ${errMsg(err)}`)
      state.status = {
        ...state.status,
        state: 'failed',
        error: errMsg(err),
        statusMessage: 'Host-restore failed'
      }
    })
  })
}

interface ResolvedHostTarget {
  /** Absolute path the bytes land at on disk. */
  absoluteTarget: string
  /** Sibling path that holds the existing target during the rename
   *  swap; cleaned up on success, restored on failure. */
  safetyPath: string
}

// Mirror of the server's trailing-slash interpretation: if the user
// types `tmp/` the source basename is appended so a file restore lands
// at `tmp/<filename>` instead of overwriting `tmp` as a file.
export function resolveHostTarget(
  customPath: string,
  _isDir: boolean,
  sourcePath: string
): ResolvedHostTarget {
  const explicitDir = /[/\\]$/.test(customPath)
  const stripped = explicitDir ? customPath.replace(/[/\\]+$/, '') : customPath
  const baseCustom =
    explicitDir && stripped === '' && path.isAbsolute(customPath) ? customPath : stripped
  const joined = path.isAbsolute(baseCustom) ? baseCustom : path.resolve(baseCustom)
  const absoluteTarget = explicitDir ? path.join(joined, path.basename(sourcePath)) : joined
  return {
    absoluteTarget,
    safetyPath: makeSafetyPath(absoluteTarget)
  }
}

function makeSafetyPath(targetAbs: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${targetAbs}.partial-restore-backup-${stamp}`
}

interface RestoreContext {
  backupId: string
  sourcePath: string
  isDir: boolean
  target: ResolvedHostTarget
  upstreamBase: string
  log?: (msg: string) => void
}

async function runRestore(ctx: RestoreContext): Promise<void> {
  let safetyStashed: string | null = null
  try {
    // Stash any existing target so a failure mid-write can be rolled
    // back. Same sibling-rename pattern as the server's partial-restore-
    // service — atomic on the same filesystem.
    const existing = await safeStat(ctx.target.absoluteTarget)
    if (existing) {
      await rename(ctx.target.absoluteTarget, ctx.target.safetyPath)
      safetyStashed = ctx.target.safetyPath
    }

    state.status = {
      ...state.status,
      state: 'streaming',
      progress: 25,
      statusMessage: 'Downloading from backup-server…'
    }

    const url =
      ctx.upstreamBase.replace(/\/$/, '') +
      `/api/backups/${encodeURIComponent(ctx.backupId)}/download-subtree?path=${encodeURIComponent(ctx.sourcePath)}`
    const upstream = await fetch(url)
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      throw new Error(`upstream ${upstream.status}: ${text.slice(0, 200)}`)
    }

    const nodeStream = Readable.fromWeb(upstream.body as never)

    if (ctx.isDir) {
      state.status = {
        ...state.status,
        state: 'extracting',
        progress: 60,
        statusMessage: 'Extracting ZIP…'
      }
      // The server returns a ZIP for directory sources. Extract into the
      // final target dir — unzipper handles nested entries, file modes,
      // and creates parents as needed.
      await mkdir(ctx.target.absoluteTarget, { recursive: true })
      await pipeline(nodeStream, unzipper.Extract({ path: ctx.target.absoluteTarget }))
    } else {
      state.status = {
        ...state.status,
        state: 'streaming',
        progress: 60,
        statusMessage: 'Writing file…'
      }
      // Single-file source. Make sure the parent exists; absolute or
      // relative the user gave us, the dirname may not.
      await mkdir(path.dirname(ctx.target.absoluteTarget), { recursive: true })
      await pipeline(nodeStream, createWriteStream(ctx.target.absoluteTarget))
    }

    state.status = {
      ...state.status,
      state: 'completed',
      progress: 100,
      statusMessage: 'Host-restore complete'
    }

    // Clean up the safety stash on success — best-effort.
    if (safetyStashed) {
      await rm(safetyStashed, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch (err) {
    const message = errMsg(err)
    ctx.log?.(`host-restore error: ${message}`)
    if (safetyStashed) {
      state.status = {
        ...state.status,
        state: 'rolling_back',
        statusMessage: 'Rolling back…'
      }
      try {
        await rm(ctx.target.absoluteTarget, { recursive: true, force: true })
        await rename(safetyStashed, ctx.target.absoluteTarget)
        state.status = {
          ...state.status,
          state: 'rolled_back',
          error: message,
          statusMessage: 'Rolled back to previous target'
        }
        return
      } catch (rollbackErr) {
        ctx.log?.(`host-restore rollback failed: ${errMsg(rollbackErr)}`)
      }
    }
    state.status = {
      ...state.status,
      state: 'failed',
      error: message,
      statusMessage: 'Host-restore failed'
    }
  }
}

async function safeStat(p: string): Promise<{ mtime: Date; size: number } | null> {
  try {
    const s = await stat(p)
    return { mtime: s.mtime, size: s.size }
  } catch {
    return null
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
