import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { BackupClient } from '../src/backup-client.js'
import { errMsg } from '../src/errors.js'

const servers: http.Server[] = []

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
})

// Exercise the private timeout seam without widening BackupClient's public API.
type RequestFn = (path: string, init?: { timeoutMs?: number }) => Promise<unknown>
function requestOf(client: BackupClient): RequestFn {
  return (client as unknown as { request: RequestFn }).request.bind(client)
}

describe('BackupClient', () => {
  it('translates its own timeout abort into a readable message', async () => {
    const base = await listen(() => {
      // Never respond — force the client-side timeout.
    })
    const client = new BackupClient(base)
    await expect(requestOf(client)('/api/health', { timeoutMs: 80 })).rejects.toThrow(
      /backup-server \/api\/health timed out after 80ms/
    )
  })

  it('waitForReady names the base URL and preserves the connect error as cause', async () => {
    // Grab an ephemeral port, then close the server so the port refuses.
    const base = await listen(() => {})
    const doomed = servers.pop()
    await new Promise<void>((resolve) => {
      doomed?.close(() => {
        resolve()
      })
    })
    const client = new BackupClient(base)
    const err = await client.waitForReady(250, 50).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain(`backup-server at ${base}`)
    expect((err as Error).message).toContain('did not become ready within 250ms')
    // errMsg unwraps the fetch cause chain down to the syscall reason.
    expect(errMsg(err)).toMatch(/ECONNREFUSED|EADDRNOTAVAIL/)
  })

  it('waitForReady resolves against a healthy server', async () => {
    const base = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ success: true, data: { status: 'healthy' } }))
    })
    const client = new BackupClient(base)
    await expect(client.waitForReady(2_000, 50)).resolves.toBeUndefined()
  })
})

// The three restore flows a server restart would cut short, as the server reports them.
function restoreServer(states: { full: string; partial: string; cloud: string } | 'fail') {
  return listen((req, res) => {
    if (states === 'fail') {
      res.writeHead(500)
      res.end()
      return
    }
    const data = req.url?.startsWith('/api/backups/restore-partial/status')
      ? { state: states.partial }
      : req.url?.startsWith('/api/backups/restore/status')
        ? { state: states.full }
        : req.url?.startsWith('/api/cloud/restore/status')
          ? { cloudPhase: states.cloud, restore: null }
          : null
    res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, data }))
  })
}

describe('BackupClient.isIdle', () => {
  it('is idle when no restore runs, including one that has ended', async () => {
    const idle = await restoreServer({ full: 'idle', partial: 'idle', cloud: 'idle' })
    expect(await new BackupClient(idle).isIdle()).toBe(true)
    const ended = await restoreServer({
      full: 'completed',
      partial: 'rolled_back',
      cloud: 'failed'
    })
    expect(await new BackupClient(ended).isIdle()).toBe(true)
  })

  it('is busy while any restore runs', async () => {
    const full = await restoreServer({ full: 'extracting', partial: 'idle', cloud: 'idle' })
    expect(await new BackupClient(full).isIdle()).toBe(false)
    const partial = await restoreServer({
      full: 'idle',
      partial: 'safety_snapshotting',
      cloud: 'idle'
    })
    expect(await new BackupClient(partial).isIdle()).toBe(false)
    // "ready": the user is picking what to restore from the cloud.
    const cloud = await restoreServer({ full: 'idle', partial: 'idle', cloud: 'ready' })
    expect(await new BackupClient(cloud).isIdle()).toBe(false)
  })

  it('counts an unreadable status as busy', async () => {
    const broken = await restoreServer('fail')
    expect(await new BackupClient(broken).isIdle()).toBe(false)
  })
})
