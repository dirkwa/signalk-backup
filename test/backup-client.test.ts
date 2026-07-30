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
