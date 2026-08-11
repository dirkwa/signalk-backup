import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Plugin } from '@signalk/server-api'
import createPlugin from '../src/index.js'
import type { BackupServerAPI } from '../src/types.js'

// External mode is the seam that exercises the real start()/stop() without a container runtime.

const servers: http.Server[] = []
const tempDirs: string[] = []

function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

function makeApp(dataDir: string) {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    savePluginOptions: vi.fn((_opts: unknown, cb: (err: null) => void) => {
      cb(null)
    }),
    getDataDirPath: () => dataDir,
    handleMessage: vi.fn(),
    setProviderStatus: vi.fn(),
    setProviderError: vi.fn()
  }
}

async function startPlugin(
  externalUrl: string
): Promise<{ plugin: Plugin; app: ReturnType<typeof makeApp> }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sk-backup-test-'))
  tempDirs.push(dataDir)
  const app = makeApp(dataDir)
  const plugin = createPlugin(app as unknown as BackupServerAPI)
  plugin.start({ managedContainer: false, externalUrl, emitSignalKDeltas: false }, () => undefined)
  return { plugin, app }
}

async function until(predicate: () => boolean, budgetMs = 4000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections()
          s.close(() => {
            resolve()
          })
        })
    )
  )
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('first-run seeding is non-fatal', () => {
  // Enforced inside seedFirstRunSchedule's try/catch, so the call sites would not fail if it were removed.
  it('reports the engine as ready even when GET /api/settings fails', async () => {
    let healthHits = 0
    const base = await listen((req, res) => {
      if (req.url?.startsWith('/api/health')) {
        healthHits++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      if (req.url?.startsWith('/api/settings')) {
        // The seeding step's first call — fail it.
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'boom' }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { plugin, app } = await startPlugin(base)

    // Startup must reach its terminal "ready" status despite the seed failing.
    const reached = await until(() =>
      app.setPluginStatus.mock.calls.some((c) => String(c[0]).includes('Backup engine ready'))
    )
    await plugin.stop()

    expect(healthHits).toBeGreaterThan(0)
    expect(reached).toBe(true)
    // A non-fatal step must not surface as a plugin error.
    const errors = app.setPluginError.mock.calls.map((c) => String(c[0]))
    expect(errors.filter((e) => e.includes('unreachable'))).toHaveLength(0)
  })

  it('seeds the schedule and reports ready when the server is healthy', async () => {
    let putBody: unknown
    const base = await listen((req, res) => {
      if (req.url?.startsWith('/api/health')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      if (req.url?.startsWith('/api/settings') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        // Not configured yet -> the plugin should seed.
        res.end(JSON.stringify({ scheduler: { configured: false } }))
        return
      }
      if (req.url?.startsWith('/api/settings') && req.method === 'PUT') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          putBody = JSON.parse(Buffer.concat(chunks).toString()) as unknown
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { plugin, app } = await startPlugin(base)
    const seeded = await until(() =>
      app.setPluginStatus.mock.calls.some((c) => String(c[0]).includes('First-run'))
    )
    await plugin.stop()

    expect(seeded).toBe(true)
    // Safe defaults: a daily local backup, cloud sync left off for the user to enable.
    expect(putBody).toMatchObject({
      scheduler: { configured: true, daily: { enabled: true } },
      cloud: { mode: 'off' }
    })
  })
})

describe('startup retry', () => {
  // waitForReady(15s) polls internally before rejecting, so assert on the probing rather than onAttemptFailed.
  it('keeps probing an unreachable server instead of giving up', async () => {
    let probes = 0
    // Accepts the connection but never answers, so probes hit the client-side timeout.
    const base = await listen(() => {
      probes++
    })
    const { plugin, app } = await startPlugin(base)

    // More than one probe proves it is looping, not failing once and stopping.
    const looping = await until(() => probes >= 2, 8000)
    await plugin.stop()

    expect(looping).toBe(true)
    // Still pending, not abandoned: no terminal "ready" status was ever set.
    const statuses = app.setPluginStatus.mock.calls.map((c) => String(c[0]))
    expect(statuses.filter((s) => s.includes('Connected to external'))).toHaveLength(0)
  })

  // Budget: probing phase plus the post-stop quiet window.
  it('stop() halts the probing', { timeout: 20_000 }, async () => {
    let probes = 0
    const base = await listen(() => {
      probes++
    })
    const { plugin, app } = await startPlugin(base)
    expect(await until(() => probes >= 2, 8000)).toBe(true)

    await plugin.stop()
    const afterStop = probes
    // Exceeds a probe's 2s timeout plus the 1s retry interval, so a late probe cannot make this flaky.
    await new Promise((r) => setTimeout(r, 3500))

    expect(probes).toBe(afterStop)
    expect(app.setPluginStatus).toHaveBeenCalledWith('Stopped')
  })

  // Budget: two probe phases plus the post-stop quiet window.
  it('a restart does not leave the previous attempt running', { timeout: 20_000 }, async () => {
    let probes = 0
    const base = await listen(() => {
      probes++
    })
    const { plugin, app } = await startPlugin(base)
    expect(await until(() => probes >= 2, 8000)).toBe(true)

    // Restart without an intervening stop(): start() must retire the previous attempt.
    plugin.start(
      { managedContainer: false, externalUrl: base, emitSignalKDeltas: false },
      () => undefined
    )
    expect(await until(() => probes >= 4, 8000)).toBe(true)
    await plugin.stop()

    const afterStop = probes
    // Same margin as above: 2s probe timeout + 1s retry interval.
    await new Promise((r) => setTimeout(r, 3500))
    // One stop() must silence everything; a leaked first loop would keep going.
    expect(probes).toBe(afterStop)
    expect(app.setPluginStatus).toHaveBeenCalledWith('Stopped')
  })
})

describe('stop() during an in-flight health request', () => {
  it('aborts the open request rather than waiting out its 2s timeout', async () => {
    let opened = 0
    let clientGone = 0
    // Never responds, so the request stays open until something aborts it.
    const base = await listen((req) => {
      opened++
      req.on('aborted', () => {
        clientGone++
      })
      req.socket.on('close', () => {
        clientGone++
      })
    })

    const { plugin } = await startPlugin(base)
    expect(await until(() => opened >= 1, 8000)).toBe(true)

    const t0 = Date.now()
    await plugin.stop()
    expect(await until(() => clientGone >= 1, 3000)).toBe(true)
    // Well under the 2s request timeout, so the abort reached the fetch rather than it timing out.
    expect(Date.now() - t0).toBeLessThan(1500)
  })
})

describe('external mode misconfiguration', () => {
  it('reports a clear error when externalUrl is empty', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sk-backup-test-'))
    tempDirs.push(dataDir)
    const app = makeApp(dataDir)
    const plugin = createPlugin(app as unknown as BackupServerAPI)

    plugin.start({ managedContainer: false, externalUrl: '  ' }, () => undefined)
    const reported = await until(() =>
      app.setPluginError.mock.calls.some((c) => String(c[0]).includes('externalUrl is empty'))
    )
    await plugin.stop()

    expect(reported).toBe(true)
  })
})
