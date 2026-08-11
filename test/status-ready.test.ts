import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Plugin } from '@signalk/server-api'
import createPlugin from '../src/index.js'
import type { BackupServerAPI } from '../src/types.js'

// #103: `ready` was `client !== null`, cleared only in stop(), so a dead container still reported ready:true.

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

// Health always answers, so only the container state can make `ready` false.
function healthyBackupServer(): Promise<string> {
  return listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.startsWith('/api/settings')) {
      res.end(JSON.stringify({ scheduler: { configured: true } }))
      return
    }
    res.end(JSON.stringify({ status: 'ok' }))
  })
}

function installFakeManager(address: string, state: () => string) {
  const url = new URL(address)
  const manager = {
    getRuntime: () => ({ runtime: 'podman', version: '5.4.2', isRootless: true }),
    whenReady: () => Promise.resolve(),
    ensureRunning: () => Promise.resolve(),
    recreate: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    pullImage: () => Promise.resolve(),
    getState: () => Promise.resolve(state()),
    listContainers: () =>
      Promise.resolve(
        state() === 'missing'
          ? []
          : [
              {
                name: 'sk-signalk-backup-server',
                unprefixedName: 'signalk-backup-server',
                image: 'ghcr.io/dirkwa/signalk-backup-server:0.6.10',
                state: state(),
                ports: [`127.0.0.1:${url.port}->3010/tcp`]
              }
            ]
      ),
    resolveContainerAddress: () => Promise.resolve(`127.0.0.1:${url.port}`),
    updates: {
      register: vi.fn(),
      unregister: vi.fn(),
      checkOne: () => Promise.resolve({}),
      sources: { githubReleases: () => ({ fetch: () => Promise.resolve({}) }) }
    }
  }
  ;(globalThis as Record<string, unknown>)['__signalk_containerManager'] = manager
  return manager
}

function makeApp(dataDir: string) {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    savePluginOptions: vi.fn((_o: unknown, cb: (e: null) => void) => {
      cb(null)
    }),
    getDataDirPath: () => dataDir,
    handleMessage: vi.fn()
  }
}

// Capture the /status handler so it can be invoked without an Express app.
type StatusHandler = (req: unknown, res: unknown) => Promise<void> | void
function routerCapturing(into: { status?: StatusHandler }) {
  const noop = () => undefined
  return {
    get: (p: string, h: StatusHandler) => {
      if (p === '/status') into.status = h
    },
    post: noop,
    put: noop,
    patch: noop,
    delete: noop,
    all: noop,
    use: noop
  }
}

async function readStatus(handler: StatusHandler): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {}
  await handler(
    {},
    {
      json: (b: Record<string, unknown>) => {
        body = b
      },
      status: () => ({ json: () => undefined })
    }
  )
  return body
}

// Awaits the predicate: a sync signature would treat every returned Promise as truthy.
async function until(predicate: () => boolean | Promise<boolean>, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

afterEach(async () => {
  delete (globalThis as Record<string, unknown>)['__signalk_containerManager']
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

describe('/status ready reflects the live container', () => {
  async function startManaged(state: () => string) {
    const base = await healthyBackupServer()
    installFakeManager(base, state)
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sk-backup-ready-'))
    tempDirs.push(dataDir)
    const app = makeApp(dataDir)
    const plugin: Plugin = createPlugin(app as unknown as BackupServerAPI)
    const routes: { status?: StatusHandler } = {}
    plugin.registerWithRouter?.(routerCapturing(routes) as never)
    const status = routes.status
    if (!status) throw new Error('plugin did not register GET /status')
    plugin.start(
      { managedContainer: true, imageTag: 'auto', externalUrl: '', emitSignalKDeltas: false },
      () => undefined
    )
    return { plugin, app, status }
  }

  it('reports ready while the container is running', async () => {
    const { plugin, status } = await startManaged(() => 'running')
    expect(
      await until(async () => {
        const s = await readStatus(status)
        return s['ready'] === true
      })
    ).toBe(true)
    await plugin.stop()
  })

  it('drops ready to false once the container is gone', async () => {
    let state = 'running'
    const { plugin, status } = await startManaged(() => state)

    // Wait for a genuine ready:true, so the next assertion cannot pass vacuously.
    let ready = false
    await until(async () => {
      const s = await readStatus(status)
      ready = s['ready'] === true
      return ready
    })
    expect(ready).toBe(true)

    // The container disappears; `client` is untouched, exactly as in #103.
    state = 'missing'
    const after = await readStatus(status)

    expect((after['container'] as Record<string, unknown>)['state']).toBe('missing')
    // Before the fix this was true, contradicting the state in the same payload.
    expect(after['ready']).toBe(false)
    await plugin.stop()
  })

  it('reports ready false while the container is merely stopped', async () => {
    let state = 'running'
    const { plugin, status } = await startManaged(() => state)
    expect(await until(async () => (await readStatus(status))['ready'] === true)).toBe(true)

    state = 'stopped'
    const after = await readStatus(status)
    expect(after['ready']).toBe(false)
    await plugin.stop()
  })
})
