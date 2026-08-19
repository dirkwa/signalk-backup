import { describe, it, expect, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import createPlugin from '../src/index.js'
import { SCHEMA_DEFAULTS } from '../src/config/schema.js'
import type { BackupServerAPI } from '../src/types.js'

// The webapp's container card is the only consumer of these routes and has no
// unit tests, so three regressions shipped through it. Cover the contract here.

const tempDirs: string[] = []

/** supertest types `body` as `any`; narrow it once instead of per-assertion. */
function body(res: { body: unknown }): { tag?: string; error?: string } {
  return res.body as { tag?: string; error?: string }
}

afterEach(async () => {
  delete (globalThis as Record<string, unknown>)['__signalk_containerManager']
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

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

interface ManagerOverrides {
  checkOne?: () => Promise<unknown>
  recreate?: () => Promise<void>
  listContainers?: () => Promise<unknown[]>
}

function installManager(overrides: ManagerOverrides = {}) {
  const manager = {
    getRuntime: () => ({ runtime: 'podman', version: '5.4.2' }),
    whenReady: () => Promise.resolve(),
    ensureRunning: () => Promise.resolve(),
    recreate: overrides.recreate ?? (() => Promise.resolve()),
    stop: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    pullImage: () => Promise.resolve(),
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
    resolveContainerAddress: () => Promise.resolve('127.0.0.1:1'),
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
    // SCHEMA_DEFAULTS.imageTag rather than a stale hard-coded value.
    //
    // Deliberately no plugin.start() here: start() runs the real readiness
    // probe, which retries forever by design. It only appeared to work
    // locally because the fake address (127.0.0.1:3010) happens to be a real
    // backup-server on a dev box; on CI nothing answers and the test hangs.
    installManager()
    const { server } = await mountPlugin()

    const res = await request(server).post('/api/update/apply').send({})

    expect(res.status).toBe(200)
    expect(body(res).tag).toBe(SCHEMA_DEFAULTS.imageTag)
    expect(body(res).tag).toBe('latest')
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
