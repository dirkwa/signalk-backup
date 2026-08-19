import { describe, it, expect, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import createPlugin from '../src/index.js'
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
    resolveContainerAddress: () => Promise.resolve('127.0.0.1:3010'),
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
  it('applies without a tag so the plugin re-resolves its own imageTag', async () => {
    // The card posts no tag on purpose: "latest" and "auto" must both land on
    // the configured tag rather than a version the UI guessed.
    const recreate = vi.fn(() => Promise.resolve())
    installManager({ recreate })
    const { server, plugin } = await mountPlugin()
    plugin.start(
      { managedContainer: true, imageTag: 'latest', externalUrl: '', emitSignalKDeltas: false },
      () => undefined
    )

    const res = await request(server).post('/api/update/apply').send({})

    expect(res.status).toBe(200)
    expect(body(res).tag).toBe('latest')
    await plugin.stop()
  })

  it('falls back to the configured default when the plugin never started', async () => {
    // No start() means no lastStartedTag, so the route falls to defaultTag —
    // which must track the schema default, not a stale hard-coded "auto".
    installManager()
    const { server } = await mountPlugin()

    const res = await request(server).post('/api/update/apply').send({})

    expect(res.status).toBe(200)
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
