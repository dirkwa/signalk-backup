// Plugin-side routes for the database-export staging tree. The
// orchestrator at runAllExports() writes Parquet shards + per-source
// MANIFEST.json files to <stagingRoot>/<sourcePluginId>/...; these
// routes let the webapp list and download those files without pulling
// the whole snapshot from the backup-server. For "download from a
// historical backup" the webapp uses the server's /download-subtree
// endpoint instead — both pipes feed the same UI tab.
//
// stagingRoot is hard-pinned by the caller (typically
// `<getDataDirPath()>/database-exports`) and is the only directory
// these handlers will read. A `file` query param is path-resolved and
// rejected if it escapes that root, so a manipulated request can't
// turn this into an arbitrary file lister.

import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { IRouter, Request, Response } from 'express'

export interface StagingEntry {
  /** Path relative to stagingRoot, using forward slashes. */
  path: string
  /** File size in bytes. */
  size: number
  /** Last-modified time, ISO-8601. */
  mtime: string
}

export interface StagingRoutesOptions {
  /**
   * Absolute path to the database-exports root. Files outside this
   * directory are never served.
   */
  getStagingRoot: () => string
  /** Optional debug logger. */
  log?: (msg: string) => void
}

/**
 * Register `GET /api/db-export/staging` (list) and
 * `GET /api/db-export/staging/download` (stream one file) on `router`.
 * Must be registered before the `/api/*` proxy catch-all so it isn't
 * forwarded to the backup-server.
 */
export function registerStagingRoutes(router: IRouter, opts: StagingRoutesOptions): void {
  router.get('/api/db-export/staging', async (_req: Request, res: Response) => {
    const root = opts.getStagingRoot()
    try {
      const entries = await listStagingFiles(root)
      res.json({
        success: true,
        data: { stagingRoot: root, entries },
        timestamp: new Date().toISOString()
      })
    } catch (err) {
      opts.log?.(`staging list failed: ${errMsg(err)}`)
      if (isENOENT(err)) {
        res.json({
          success: true,
          data: { stagingRoot: root, entries: [] },
          timestamp: new Date().toISOString()
        })
        return
      }
      res.status(500).json({
        success: false,
        error: { code: 'STAGING_LIST_FAILED', message: errMsg(err) },
        timestamp: new Date().toISOString()
      })
    }
  })

  router.get('/api/db-export/staging/download', async (req: Request, res: Response) => {
    const fileParam = typeof req.query.file === 'string' ? req.query.file : ''
    if (!fileParam) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'file query parameter is required'
        },
        timestamp: new Date().toISOString()
      })
      return
    }

    const root = opts.getStagingRoot()
    let absoluteFile: string
    try {
      absoluteFile = await resolveStagingFile(root, fileParam)
    } catch (err) {
      const status = err instanceof StagingPathError ? err.status : 500
      res.status(status).json({
        success: false,
        error: {
          code: err instanceof StagingPathError ? err.code : 'INTERNAL',
          message: errMsg(err)
        },
        timestamp: new Date().toISOString()
      })
      return
    }

    // Stat is the final gate: if the resolved path is a directory we
    // refuse — directory downloads go through the server's zip-subtree
    // endpoint, not here.
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(absoluteFile)
    } catch (err) {
      const status = isENOENT(err) ? 404 : 500
      res.status(status).json({
        success: false,
        error: {
          code: status === 404 ? 'FILE_NOT_FOUND' : 'STAT_FAILED',
          message: errMsg(err)
        },
        timestamp: new Date().toISOString()
      })
      return
    }
    if (!s.isFile()) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NOT_A_FILE',
          message:
            'staging download only serves regular files; use the snapshot subtree endpoint for directories'
        },
        timestamp: new Date().toISOString()
      })
      return
    }

    const safeName = path.basename(fileParam).replace(/[^A-Za-z0-9._-]/g, '_') || 'staging-file'
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
    res.setHeader('Content-Length', String(s.size))
    const stream = createReadStream(absoluteFile)
    stream.on('error', (err) => {
      opts.log?.(`staging stream error for ${absoluteFile}: ${errMsg(err)}`)
      if (!res.headersSent) {
        res.status(500).end()
      } else {
        res.end()
      }
    })
    stream.pipe(res)
  })
}

/**
 * List every regular file under `stagingRoot`, recursively. Returns an
 * empty list when the root doesn't exist (DB exports never ran).
 * Symlinks and special files are skipped — only `isFile()` entries
 * land in the result so a malicious symlink can't leak file contents.
 */
export async function listStagingFiles(stagingRoot: string): Promise<StagingEntry[]> {
  const root = await realpath(stagingRoot)
  const out: StagingEntry[] = []
  await walk(root, root, out)
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

async function walk(root: string, current: string, out: StagingEntry[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch (err) {
    if (isENOENT(err)) return
    throw err
  }
  for (const entry of entries) {
    const child = path.join(current, entry.name)
    if (entry.isDirectory()) {
      await walk(root, child, out)
      continue
    }
    if (!entry.isFile()) continue
    const s = await stat(child)
    out.push({
      path: path.relative(root, child).split(path.sep).join('/'),
      size: s.size,
      mtime: s.mtime.toISOString()
    })
  }
}

export class StagingPathError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_FILE' | 'OUTSIDE_ROOT',
    public readonly status: number
  ) {
    super(message)
    this.name = 'StagingPathError'
  }
}

/**
 * Resolve `file` (which arrives as a forward-slash relative path) to an
 * absolute path under stagingRoot. Throws StagingPathError when the
 * resolved path escapes the root via `..`, a symlink, or an absolute
 * input. Symlinks are detected because we realpath both the root and
 * the deepest existing ancestor of the target.
 */
export async function resolveStagingFile(stagingRoot: string, file: string): Promise<string> {
  if (file.includes('\0')) {
    throw new StagingPathError('file must not contain NUL bytes', 'INVALID_FILE', 400)
  }
  if (path.isAbsolute(file)) {
    throw new StagingPathError(
      'file must be a relative path under the staging root',
      'INVALID_FILE',
      400
    )
  }
  // Normalize separators so callers can pass forward-slash paths on Windows too.
  const normalized = file.split(/[/\\]/).filter((p) => p.length > 0)
  if (normalized.some((p) => p === '..')) {
    throw new StagingPathError('file must not contain ".." segments', 'INVALID_FILE', 400)
  }

  const root = await realpath(stagingRoot)
  const joined = path.join(root, ...normalized)
  // Walk up until we find an ancestor that exists; realpath that so a
  // symlink hop in the middle of the path is resolved before the check.
  const resolvedAncestor = await resolveExistingAncestor(joined)
  const rel = path.relative(root, resolvedAncestor)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new StagingPathError(
      `file ${file} resolves outside the staging root`,
      'OUTSIDE_ROOT',
      403
    )
  }
  return joined
}

async function resolveExistingAncestor(target: string): Promise<string> {
  let current = target
  while (current !== path.dirname(current)) {
    try {
      return await realpath(current)
    } catch {
      current = path.dirname(current)
    }
  }
  return await realpath(current)
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
