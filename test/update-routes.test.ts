import { describe, it, expect, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import createPlugin from '../src/index.js'
import { BACKUP_SERVER_VERSION, isConcreteSemver } from '../src/config/image-tag.js'
import type { BackupServerAPI } from '../src/types.js'

// The webapp's container card is the only consumer of these routes and has no
// unit tests, so three regressions shipped through it. Cover the contract here.

// A host restore runs in the plugin; this stands in for one without driving its routes.
const hostRestore = vi.hoisted(() => ({ running: false }))
vi.mock('../src/restore-host-write.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/restore-host-write.js')>()),
  isHostRestoreRunning: () => hostRestore.running
}))

const tempDirs: string[] = []
const servers: http.Server[] = []

/** supertest types `body` as `any`; narrow it once instead of per-assertion. */
function body(res: { body: unknown }): { tag?: string; error?: string } {
  return res.body as { tag?: string; error?: string }
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

function makeApp(dataDir: string) {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    savePluginOptions: vi.fn((_o: unknown, cb: (e: Error | null) => void) => {
      cb(null)
    }),
    getDataDirPath: () => dataDir,
    getSelfPath: () => undefined,
    handleMessage: vi.fn()
  }
}

interface ManagerOverrides {
  checkOne?: () => Promise<unknown>
  ensureRunning?: (name: string, config: unknown) => Promise<void>
  recreate?: (name: string, config: unknown) => Promise<void>
  listContainers?: () => Promise<unknown[]>
  resolveContainerAddress?: () => Promise<string>
  pullImage?: (image: string) => Promise<void>
}

function installManager(overrides: ManagerOverrides = {}) {
  const manager = {
    getRuntime: () => ({ runtime: 'podman', version: '5.4.2' }),
    whenReady: () => Promise.resolve(),
    ensureRunning: overrides.ensureRunning ?? (() => Promise.resolve()),
    recreate: overrides.recreate ?? (() => Promise.resolve()),
    stop: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    pullImage: overrides.pullImage ?? (() => Promise.resolve()),
    getState: () => Promise.resolve('running'),
    listContainers:
      overrides.listContainers ??
      (() =>
        Promise.resolve([
          {
            name: 'sk-signalk-backup-server',
            unprefixedName: 'signalk-backup-server',
            image: 'ghcr.io/dirkwa/signalk-backup-server:1.0.0',
            state: 'running',
            ports: []
          }
        ])),
    // Port 1 never listens: a dev box running a real backup-server on 3010
    // would otherwise satisfy a readiness probe this suite must never depend on.
    resolveContainerAddress:
      overrides.resolveContainerAddress ?? (() => Promise.resolve('127.0.0.1:1')),
    updates: {
      register: vi.fn(),
      unregister: vi.fn(),
      checkOne: overrides.checkOne ?? (() => Promise.resolve({ updateAvailable: false })),
      sources: { githubReleases: () => ({ fetch: () => Promise.resolve({}) }) }
    }
  }
  ;(globalThis as Record<string, unknown>)['__signalk_containerManager'] = manager
  return manager
}

/** A stand-in backup server that is healthy with no restore running; returns host:port. */
function listenBackupServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    const data = url.startsWith('/api/health')
      ? { status: 'healthy' }
      : url.startsWith('/api/backups/restore')
        ? { state: 'idle' }
        : url.startsWith('/api/cloud/restore/status')
          ? { cloudPhase: 'idle' }
          : null
    res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, data }))
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve(`127.0.0.1:${port}`)
    })
  })
}

async function until(predicate: () => boolean, budgetMs = 4000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

/** Mounts the plugin's real router so requests exercise the wire contract. */
async function mountPlugin() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sk-backup-update-'))
  tempDirs.push(dataDir)
  const app = makeApp(dataDir)
  const plugin = createPlugin(app as unknown as BackupServerAPI)
  const router = express.Router()
  plugin.registerWithRouter?.(router)
  const server = express().use(express.json()).use(router)
  return { server, app, plugin }
}

describe('GET /api/update/check', () => {
  it('passes the update service result through unwrapped', async () => {
    // The webapp reads these fields directly; an envelope here would break it.
    const payload = {
      runningTag: '1.0.0',
      tagKind: 'semver',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
      reason: 'newer-version'
    }
    installManager({ checkOne: () => Promise.resolve(payload) })
    const { server } = await mountPlugin()

    const res = await request(server).get('/api/update/check')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject(payload)
    expect(res.body).not.toHaveProperty('success')
  })

  it('answers 503 with a message when signalk-container is absent', async () => {
    // The state a first-run install is in — the card shows this text.
    const { server } = await mountPlugin()

    const res = await request(server).get('/api/update/check')

    expect(res.status).toBe(503)
    expect(body(res).error).toMatch(/signalk-container/i)
  })
})

describe('POST /api/update/apply', () => {
  it('applies without a tag so the plugin resolves the configured default', async () => {
    // The card posts no tag on purpose: "latest" and "auto" must both land on
    // the configured tag rather than a version the UI guessed. With no prior
    // start() the route falls through to defaultTag, which must track
    // the configured default, which is "auto" and must reach the runtime
    // already resolved to a concrete version.
    //
    // Deliberately no plugin.start() here: start() runs the real readiness
    // probe, which retries forever by design. It only appeared to work
    // locally because the fake address (127.0.0.1:3010) happens to be a real
    // backup-server on a dev box; on CI nothing answers and the test hangs.
    installManager()
    const { server } = await mountPlugin()

    const res = await request(server).post('/api/update/apply').send({})

    expect(res.status).toBe(200)
    // "auto" is resolved before the runtime sees it — a floating tag here
    // would defeat the version comparison the default exists to get.
    const tag = body(res).tag
    expect(tag).toBe(BACKUP_SERVER_VERSION)
    expect(tag !== undefined && isConcreteSemver(tag)).toBe(true)
  })

  it('installs the release the check reported under "auto", and keeps "auto"', async () => {
    // The card's "Update to X" must land on X. Re-applying the tag the
    // container last started installed nothing and pinned the running version.
    const address = await listenBackupServer()
    const events: string[] = []
    const capture = (_n: string, c: unknown) => {
      events.push(`run ${(c as { tag: string }).tag}`)
      return Promise.resolve()
    }
    installManager({
      checkOne: () =>
        Promise.resolve({
          updateAvailable: true,
          latestVersion: '99.1.0',
          reason: 'newer-version'
        }),
      ensureRunning: capture,
      recreate: capture,
      pullImage: (image) => {
        events.push(`pull ${image}`)
        return Promise.resolve()
      },
      resolveContainerAddress: () => Promise.resolve(address)
    })
    const { server, app, plugin } = await mountPlugin()
    plugin.start(
      {
        managedContainer: true,
        imageTag: 'auto',
        resolvedImageTag: BACKUP_SERVER_VERSION,
        externalUrl: '',
        emitSignalKDeltas: false
      },
      () => undefined
    )
    const ready = await until(() =>
      app.setPluginStatus.mock.calls.some((c) => String(c[0]).includes('Backup engine ready'))
    )
    expect(ready).toBe(true)

    const res = await request(server).post('/api/update/apply').send({})
    await plugin.stop()

    expect(res.status).toBe(200)
    expect(body(res).tag).toBe('99.1.0')
    // Downloaded before the swap: recreate removes the old container first.
    expect(events.slice(-2)).toEqual([
      'pull ghcr.io/dirkwa/signalk-backup-server:99.1.0',
      'run 99.1.0'
    ])
    const saved = app.savePluginOptions.mock.calls.at(-1)?.[0] as
      { imageTag?: string; resolvedImageTag?: string } | undefined
    expect(saved?.imageTag).toBe('auto')
    expect(saved?.resolvedImageTag).toBe('99.1.0')
  })

  it('fails the apply when the new version cannot be saved', async () => {
    // The container already runs the new version, but a restart would go back,
    // so the card must not report success.
    const address = await listenBackupServer()
    installManager({
      checkOne: () =>
        Promise.resolve({
          updateAvailable: true,
          latestVersion: '99.1.0',
          reason: 'newer-version'
        }),
      resolveContainerAddress: () => Promise.resolve(address)
    })
    const { server, app, plugin } = await mountPlugin()
    plugin.start(
      {
        managedContainer: true,
        imageTag: 'auto',
        resolvedImageTag: BACKUP_SERVER_VERSION,
        externalUrl: '',
        emitSignalKDeltas: false
      },
      () => undefined
    )
    const ready = await until(() =>
      app.setPluginStatus.mock.calls.some((c) => String(c[0]).includes('Backup engine ready'))
    )
    expect(ready).toBe(true)
    app.savePluginOptions.mockImplementation((_o: unknown, cb: (e: Error | null) => void) => {
      cb(
        Object.assign(
          new Error(
            "ENOSPC: no space left on device, open '/srv/signalk/plugin-config-data/signalk-backup.json'"
          ),
          {
            code: 'ENOSPC'
          }
        )
      )
    })

    const res = await request(server).post('/api/update/apply').send({})
    await plugin.stop()

    expect(res.status).toBe(500)
    expect(body(res).error).toBe(
      'Running 99.1.0, but saving it failed (disk full), so a plugin restart will go back. See the server log.'
    )
    expect(app.error.mock.calls.some((c) => String(c[0]).includes('/srv/signalk/'))).toBe(true)
  })

  it('rejects a malformed tag before touching the runtime', async () => {
    const recreate = vi.fn(() => Promise.resolve())
    installManager({ recreate })
    const { server } = await mountPlugin()

    const res = await request(server).post('/api/update/apply').send({ tag: 'bad tag!' })

    expect(res.status).toBe(400)
    expect(recreate).not.toHaveBeenCalled()
  })

  it('answers 503 with a message when signalk-container is absent', async () => {
    const { server } = await mountPlugin()

    const res = await request(server).post('/api/update/apply').send({})

    expect(res.status).toBe(503)
    expect(body(res).error).toMatch(/signalk-container/i)
  })
})

describe('"auto" image tag', () => {
  it('starts the version it resolved, not the floor', async () => {
    // The helper calls resolveTag with the requested tag alone, so a mapping
    // that does not close over the resolved version always lands on the floor.
    let seen!: (tag: string) => void
    const started = new Promise<string>((resolve) => {
      seen = resolve
    })
    const capture = (_n: string, c: unknown) => {
      seen((c as { tag: string }).tag)
      return Promise.resolve()
    }
    installManager({ ensureRunning: capture, recreate: capture })

    const { plugin } = await mountPlugin()
    // A persisted tag at or above the floor is reused without a lookup.
    plugin.start(
      {
        managedContainer: true,
        imageTag: 'auto',
        resolvedImageTag: '99.0.0',
        externalUrl: '',
        emitSignalKDeltas: false
      },
      () => undefined
    )
    const tag = await started
    await plugin.stop()

    expect(BACKUP_SERVER_VERSION).not.toBe('99.0.0')
    expect(tag).toBe('99.0.0')
  })
})

describe('container healthcheck', () => {
  it('declares an explicit probe, because the compat socket drops the image one', async () => {
    // Podman's Docker-compat socket strips an image's own HEALTHCHECK, so a
    // container created through it never leaves `starting`. signalk-container
    // only re-emits --health-* flags when the config carries them.
    let captured:
      | {
          healthcheck?: {
            test?: string[]
            interval?: string
            timeout?: string
            startPeriod?: string
            retries?: number
          }
        }
      | undefined
    installManager()
    const manager = (globalThis as Record<string, unknown>)['__signalk_containerManager'] as {
      ensureRunning: (n: string, c: unknown) => Promise<void>
    }
    // The helper reconciles via recreate() when the live image differs from
    // the desired one and via ensureRunning() otherwise; capture both.
    // Resolve a promise rather than sleeping: a fixed delay is a flake waiting
    // for a slower CI runner.
    let seen!: () => void
    const captureDone = new Promise<void>((resolve) => {
      seen = resolve
    })
    const capture = (_n: string, c: unknown) => {
      captured = c as typeof captured
      seen()
      return Promise.resolve()
    }
    manager.ensureRunning = capture
    ;(manager as unknown as { recreate: typeof capture }).recreate = capture

    const { plugin } = await mountPlugin()
    plugin.start(
      { managedContainer: true, imageTag: 'latest', externalUrl: '', emitSignalKDeltas: false },
      () => undefined
    )
    // start() is fire-and-forget, so wait for the container step itself.
    await captureDone
    await plugin.stop()

    // CMD-SHELL keeps the script as ONE argv element; the CMD form is re-split
    // on whitespace and arrives as `node -e const ...`, which is a syntax error.
    expect(captured?.healthcheck?.test?.[0]).toBe('CMD-SHELL')
    expect(captured?.healthcheck?.test?.length).toBe(2)
    // The image ships neither curl nor wget; node is the only client present.
    expect(captured?.healthcheck?.test?.[1]).toMatch(/^node -e /)
    expect(captured?.healthcheck?.test?.join(' ')).toContain('/api/health')
    expect(captured?.healthcheck?.startPeriod).toBe('15s')
    expect(captured?.healthcheck?.interval).toBe('30s')
    expect(captured?.healthcheck?.timeout).toBe('5s')
    expect(captured?.healthcheck?.retries).toBe(3)
  })
})

describe('automatic server update', () => {
  // Same major as the floor: a new major is left to a plugin release.
  const NEXT = `${BACKUP_SERVER_VERSION.split('.')[0]}.99.0`

  afterEach(() => {
    vi.useRealTimers()
    hostRestore.running = false
  })

  async function startAuto(
    autoUpdateServer: boolean,
    reason: 'newer-version' | 'offline' = 'newer-version',
    pull: () => Promise<void> = () => Promise.resolve()
  ) {
    const address = await listenBackupServer()
    const events: string[] = []
    const capture = (_n: string, c: unknown) => {
      events.push(`run ${(c as { tag: string }).tag}`)
      return Promise.resolve()
    }
    installManager({
      checkOne: () =>
        Promise.resolve({
          updateAvailable: true,
          latestVersion: NEXT,
          reason
        }),
      ensureRunning: capture,
      recreate: capture,
      pullImage: (image) => {
        events.push(`pull ${image}`)
        return pull()
      },
      resolveContainerAddress: () => Promise.resolve(address)
    })
    const { server, app, plugin } = await mountPlugin()
    plugin.start(
      {
        managedContainer: true,
        imageTag: 'auto',
        resolvedImageTag: BACKUP_SERVER_VERSION,
        autoUpdateServer,
        externalUrl: '',
        emitSignalKDeltas: false
      },
      () => undefined
    )
    await until(() =>
      app.setPluginStatus.mock.calls.some((c) => String(c[0]).includes('Backup engine ready'))
    )
    return { server, app, plugin, events }
  }

  it('installs a newer release on its own, without a click', async () => {
    // shouldAdvanceTime keeps real I/O and the readiness polls moving.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { app, plugin, events } = await startAuto(true)
    expect(events).not.toContain(`run ${NEXT}`)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await until(() =>
      app.setPluginStatus.mock.calls.some((c) => c[0] === `Backup server updated to ${NEXT}`)
    )
    await plugin.stop()

    expect(events.slice(-2)).toEqual([
      `pull ghcr.io/dirkwa/signalk-backup-server:${NEXT}`,
      `run ${NEXT}`
    ])
    const saved = app.savePluginOptions.mock.calls.at(-1)?.[0] as
      { imageTag?: string; resolvedImageTag?: string } | undefined
    expect(saved?.imageTag).toBe('auto')
    expect(saved?.resolvedImageTag).toBe(NEXT)
  })

  it('stays quiet while offline instead of failing a download every check', async () => {
    // Offline, the update service returns its cached result, which still names the release.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { app, plugin, events } = await startAuto(true, 'offline')

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    await plugin.stop()

    expect(events.filter((e) => e.startsWith('pull'))).toEqual([])
    expect(app.setPluginError).not.toHaveBeenCalled()
  })

  it('stops once "Apply update" pins a version', async () => {
    // The apply saves imageTag without a restart, so the generation does not change.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { server, app, plugin, events } = await startAuto(true)

    const res = await request(server).post('/api/update/apply').send({ tag: BACKUP_SERVER_VERSION })
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    await plugin.stop()

    expect(res.status).toBe(200)
    expect(events.filter((e) => e.startsWith('pull'))).toEqual([])
    const saved = app.savePluginOptions.mock.calls.at(-1)?.[0] as { imageTag?: string } | undefined
    expect(saved?.imageTag).toBe(BACKUP_SERVER_VERSION)
  })

  it('waits for a host restore before swapping', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    hostRestore.running = true
    const { app, plugin, events } = await startAuto(true)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const deferred = await until(() =>
      app.debug.mock.calls.some((c) => String(c[0]).includes('once no restore is running'))
    )
    expect(deferred).toBe(true)
    expect(events).not.toContain(`run ${NEXT}`)

    hostRestore.running = false
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await until(() =>
      app.setPluginStatus.mock.calls.some((c) => c[0] === `Backup server updated to ${NEXT}`)
    )
    await plugin.stop()

    expect(events.at(-1)).toBe(`run ${NEXT}`)
  })

  it('does not swap again when "Apply update" installed the release mid-download', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let firstPullStarted!: () => void
    const started = new Promise<void>((resolve) => {
      firstPullStarted = resolve
    })
    let finishFirstPull!: () => void
    let pulls = 0
    const { server, app, plugin, events } = await startAuto(true, 'newer-version', () => {
      pulls++
      if (pulls > 1) return Promise.resolve()
      firstPullStarted()
      return new Promise<void>((resolve) => {
        finishFirstPull = resolve
      })
    })

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await started
    const res = await request(server).post('/api/update/apply').send({})
    finishFirstPull()
    const skipped = await until(() =>
      app.debug.mock.calls.some((c) => String(c[0]).includes('is no longer an update'))
    )
    await plugin.stop()

    expect(res.status).toBe(200)
    expect(skipped).toBe(true)
    expect(events.filter((e) => e === `run ${NEXT}`)).toHaveLength(1)
  })

  it('refuses a second apply while one is running', async () => {
    let pullStarted!: () => void
    const started = new Promise<void>((resolve) => {
      pullStarted = resolve
    })
    let finishPull!: () => void
    const { server, plugin } = await startAuto(false, 'newer-version', () => {
      pullStarted()
      return new Promise<void>((resolve) => {
        finishPull = resolve
      })
    })

    const first = request(server)
      .post('/api/update/apply')
      .send({})
      .then((r) => r)
    await started
    const second = await request(server).post('/api/update/apply').send({})
    finishPull()
    const firstRes = await first
    await plugin.stop()

    expect(second.status).toBe(409)
    expect(firstRes.status).toBe(200)
  })

  it('downloads nothing when automatic updates are off', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { plugin, events } = await startAuto(false)

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    await plugin.stop()

    expect(events.filter((e) => e.startsWith('pull'))).toEqual([])
    expect(events).not.toContain(`run ${NEXT}`)
  })
})
