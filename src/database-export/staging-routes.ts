// stagingRoot is hard-pinned by the caller; the file query param is
// realpath-resolved against it so a manipulated request can't escape.

import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { IRouter, Request, Response } from 'express'

export interface StagingEntry {
  path: string
  size: number
  mtime: string
}

export interface StagingRoutesOptions {
  getStagingRoot: () => string
  log?: (msg: string) => void
}

// Must register before /api/* proxy catch-all to avoid forwarding to backup-server.
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

// Recursively lists regular files under stagingRoot; throws ENOENT if
// root is missing (route handler maps that to an empty response).
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
    // lstat (not stat) so a symlink swapped in between readdir and here
    // doesn't get followed; re-verify isFile after the lstat in case the
    // entry was replaced.
    const s = await lstat(child)
    if (!s.isFile()) continue
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

// Realpath both ends so a symlink-hop in the middle is resolved before
// we compare paths — otherwise a symlink could escape stagingRoot.
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
