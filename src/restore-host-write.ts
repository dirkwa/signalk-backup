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
    // Refuse to reset mid-flight — would clear the single-flight slot
    // and let a second restore start while the first still has files
    // open. Caller has to wait for the active restore to terminate.
    if (state.isRunning()) {
      res.status(409).json({
        success: false,
        error: {
          code: 'RESTORE_IN_PROGRESS',
          message: 'Cannot reset while a host-restore is in progress'
        },
        timestamp: new Date().toISOString()
      })
      return
    }
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
    // Reject empty customPath up front — an empty string would silently
    // resolve to process.cwd() and write somewhere the user didn't ask.
    if (body.customPath.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'customPath must not be empty' },
        timestamp: new Date().toISOString()
      })
      return
    }
    // Type-check confirmOverwrite if present: a non-boolean truthy
    // value (e.g. the string "false" from a misbuilt form) would
    // otherwise bypass the conflict probe and silently overwrite.
    if ('confirmOverwrite' in body && typeof body.confirmOverwrite !== 'boolean') {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'confirmOverwrite must be a boolean when provided'
        },
        timestamp: new Date().toISOString()
      })
      return
    }
    const { backupId, sourcePath, customPath, isDir, confirmOverwrite } = body as HostRestoreRequest

    // sourcePath safety: reject `..` segments and NUL bytes. No reject-list
    // (package.json etc.) — the explicit point of host-restore is "copy
    // anywhere I can write", so the in-container side-effect concerns
    // don't apply.
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
    // Reserve the single-flight slot synchronously so a concurrent
    // POST sees state.isRunning() === true before either request hits
    // its first await. Any early-return path below clears the slot
    // via state.reset() so the user can retry.
    state.status = {
      state: 'preparing',
      progress: 0,
      statusMessage: 'Preparing host-restore…',
      backupId,
      sourcePath,
      targetPath: target.absoluteTarget
    }

    // Conflict probe — surface the existing entry so the UI shows a diff.
    if (!confirmOverwrite) {
      const existing = await safeStat(target.absoluteTarget)
      if (existing) {
        state.reset()
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
      state.reset()
      res.status(503).json({
        success: false,
        error: { code: 'UPSTREAM_NOT_READY', message: 'backup-server not ready' },
        timestamp: new Date().toISOString()
      })
      return
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

    const nodeStream = Readable.fromWeb(upstream.body)

    if (ctx.isDir) {
      state.status = {
        ...state.status,
        state: 'extracting',
        progress: 60,
        statusMessage: 'Extracting ZIP…'
      }
      await mkdir(ctx.target.absoluteTarget, { recursive: true })
      // Per-entry path-traversal guard: unzipper.Extract uses a string
      // prefix check that doesn't catch ../ sequences inside an entry
      // name. Parse the ZIP and resolve each entry against the target;
      // reject anything that escapes via path.relative starting with '..'.
      await extractZipSafely(nodeStream, ctx.target.absoluteTarget)
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
    // Always scrub the partial output, even when there's no stash to
    // swap back in. Without this, a failed download mid-way through a
    // fresh-target restore leaves bytes lying on disk.
    await rm(ctx.target.absoluteTarget, { recursive: true, force: true }).catch(() => undefined)
    if (safetyStashed) {
      state.status = {
        ...state.status,
        state: 'rolling_back',
        statusMessage: 'Rolling back…'
      }
      try {
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

// Resolve a ZIP entry path against the target directory. Returns the
// absolute destination when the entry is contained inside targetDir,
// or null when the entry name is empty, contains '..' segments, or
// the resolved path otherwise escapes via path.relative. We reject
// '..' outright (rather than silently dropping it) so a malicious
// snapshot can't smuggle data into unintended locations under the
// target — even if the resolved path stays inside the root, the
// shape of the entry path is suspicious enough to refuse.
export function resolveZipEntryPath(entryPath: string, targetDir: string): string | null {
  const resolvedTarget = path.resolve(targetDir)
  const parts = entryPath.split(/[/\\]/).filter((p) => p.length > 0)
  if (parts.length === 0) return null
  if (parts.some((p) => p === '..')) return null
  const dest = path.resolve(resolvedTarget, parts.join('/'))
  const rel = path.relative(resolvedTarget, dest)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return dest
}

// Per-entry path validation while extracting the server's directory
// ZIP. unzipper.Extract uses a string-prefix check that doesn't catch
// `../` inside entry names; consume entries through Parse so we can
// resolve each path ourselves and reject anything that escapes.
async function extractZipSafely(input: Readable, targetDir: string): Promise<void> {
  const resolvedTarget = path.resolve(targetDir)
  await pipeline(input, unzipper.Parse(), async (parsed: AsyncIterable<unzipper.Entry>) => {
    for await (const entry of parsed) {
      const dest = resolveZipEntryPath(entry.path, resolvedTarget)
      if (!dest) {
        entry.autodrain()
        throw new Error(`ZIP entry "${entry.path}" escapes the target directory`)
      }
      if (entry.type === 'Directory') {
        await mkdir(dest, { recursive: true })
        entry.autodrain()
      } else {
        await mkdir(path.dirname(dest), { recursive: true })
        await pipeline(entry, createWriteStream(dest))
      }
    }
  })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
