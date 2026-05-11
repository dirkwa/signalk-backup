import path from 'node:path'
import { Plugin } from '@signalk/server-api'
import { Request, Response, IRouter } from 'express'
import { BackupClient } from './backup-client.js'
import { registerProxy } from './proxy.js'
import {
  BackupServerAPI,
  ContainerConfig,
  ContainerManagerApi,
  ContainerResourceLimits
} from './types.js'
import { ConfigSchema, Config, SCHEMA_DEFAULTS } from './config/schema.js'
import { runAllExports } from './database-export/index.js'

const BACKUP_IMAGE = 'ghcr.io/dirkwa/signalk-backup-server'
const CONTAINER_NAME = 'signalk-backup-server'
const PLUGIN_ID = 'signalk-backup'
const SK_MOUNT = '/signalk-data'
const API_PORT = 3010
const OAUTH_PORT = 53682
const SAFE_TAG = /^[a-zA-Z0-9._-]+$/

/**
 * Sensible default resource limits for the backup-server container.
 * Backup work is mostly I/O bound (Kopia is content-addressable so it
 * reads more than it CPUs); rclone uploads are network-bound. 1 CPU
 * and 256MB is enough for typical SignalK installs (a few GB of config).
 *
 * Users can override any field via signalk-container's plugin config
 * under "Per-container resource overrides", keyed by the unprefixed
 * container name `signalk-backup-server`. See:
 *   signalk-container/doc/plugin-developer-guide.md §"Resource Limits"
 */
const DEFAULT_RESOURCES: ContainerResourceLimits = {
  cpus: 1,
  memory: '256m',
  memorySwap: '256m',
  pidsLimit: 100
}

function getContainerManager(): ContainerManagerApi | undefined {
  return globalThis.__signalk_containerManager
}

/**
 * Poll for signalk-container's API to appear on globalThis. signalk-container
 * publishes itself only after its own start() finishes; plugin-load order is
 * alphabetical, so on a cold server start "signalk-backup" runs first and
 * getContainerManager() returns undefined for ~hundreds of ms.
 */
async function waitForContainerManager(
  maxMs: number,
  intervalMs = 500
): Promise<ContainerManagerApi | undefined> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const m = getContainerManager()
    if (m) return m
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return getContainerManager()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Resolve the actual host:port the backup-server container is reachable at.
 *
 * signalk-container exposes `resolveContainerAddress`, but its result comes
 * from a process-local port-allocation cache that can drift from the live
 * podman binding (TOCTOU between the in-process port probe and the actual
 * `podman create`). When that drift happens, the returned address points at
 * a port that nothing is listening on — every subsequent proxy request
 * returns ECONNREFUSED.
 *
 * This helper queries `listContainers()` (which signalk-container reads
 * directly from podman/docker) and parses the live `Ports` field for the
 * binding mapped from the container's API_PORT. That's authoritative.
 *
 * Falls back to `resolveContainerAddress` if the live binding can't be
 * parsed, so this is a strict superset of the documented contract.
 */
async function resolveActualAddress(containers: ContainerManagerApi): Promise<string | null> {
  try {
    const list = await containers.listContainers()
    const found = list.find((c) => c.name === `sk-${CONTAINER_NAME}`)
    if (found && Array.isArray((found as unknown as { ports?: string[] }).ports)) {
      // The shape ContainerInfo we mirror only declares { name, image, state },
      // but the runtime object includes a `ports` array of strings like
      // "127.0.0.1:3010->3010/tcp". Parse the binding for our API_PORT.
      const ports = (found as unknown as { ports: string[] }).ports
      const wanted = `->${API_PORT}/tcp`
      for (const entry of ports) {
        if (!entry.endsWith(wanted)) continue
        const hostPart = entry.slice(0, -wanted.length)
        // hostPart looks like "127.0.0.1:3010" or "0.0.0.0:3010".
        if (hostPart.includes(':')) return hostPart
      }
    }
  } catch {
    // fall through to the documented API
  }
  return containers.resolveContainerAddress(CONTAINER_NAME, API_PORT)
}

export default function (app: BackupServerAPI): Plugin {
  let client: BackupClient | null = null
  let currentSettings: Config | null = null
  let containerAddress: string | null = null
  let dbExportTimer: NodeJS.Timeout | null = null
  let dbExportInFlight = false

  const buildContainerConfig = (tag: string, logLevel: string): ContainerConfig => ({
    image: BACKUP_IMAGE,
    tag,
    // signalkConfigRootMount mounts the entire SignalK config root
    // (`~/.signalk/` typically) — settings.json, security.json, the
    // whole plugin-config-data tree. signalkDataMount would only mount
    // this plugin's own subdir, which isn't enough for backup/restore.
    // Requires signalk-container >= 1.5.0.
    signalkConfigRootMount: SK_MOUNT,
    signalkAccessiblePorts: [API_PORT, OAUTH_PORT],
    env: {
      PORT: String(API_PORT),
      // The backup engine's own state lives in a plugin-config-data subdir
      // so it travels with the SignalK config (snapshotted by backup, included in restore).
      DATA_DIR: `${SK_MOUNT}/plugin-config-data/${PLUGIN_ID}`,
      SIGNALK_DATA_PATH: SK_MOUNT,
      SIGNALK_VERSION: getSignalKVersion(app),
      LOG_LEVEL: logLevel
    },
    resources: DEFAULT_RESOURCES,
    restart: 'unless-stopped'
  })

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Backup',
    description:
      'Scheduled deduplicated backups of SignalK config to local storage and Google Drive',

    schema: ConfigSchema,

    start(config: Partial<Config>) {
      app.debug('Starting signalk-backup')
      // CRITICAL: Signal K does not seed schema defaults into the runtime
      // config — when the plugin is auto-enabled (or enabled without
      // saving the form), `config` is `{}`. Merge defaults so callers can
      // rely on every field being present.
      const merged: Config = { ...SCHEMA_DEFAULTS, ...config }
      currentSettings = merged
      void asyncStart(merged).catch((err: unknown) => {
        app.setPluginError(`Startup failed: ${errMsg(err)}`)
      })
    },

    async stop() {
      app.debug('Stopping signalk-backup')
      stopDbExportTimer()
      client = null
      containerAddress = null

      const containers = getContainerManager()
      if (containers && currentSettings?.managedContainer !== false) {
        try {
          containers.updates.unregister(PLUGIN_ID)
        } catch (err) {
          app.debug(`Error unregistering update tracker: ${errMsg(err)}`)
        }
        try {
          await containers.stop(CONTAINER_NAME)
        } catch (err) {
          app.debug(`Error stopping ${CONTAINER_NAME}: ${errMsg(err)}`)
        }
      }
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router: IRouter) {
      // Lightweight readiness signal for admin/webapp badges.
      router.get('/status', async (_req: Request, res: Response) => {
        const containers = getContainerManager()
        let containerState: string = 'unknown'
        let containerImage = ''

        if (containers) {
          try {
            containerState = await containers.getState(CONTAINER_NAME)
          } catch (err) {
            app.debug(`status: getState failed: ${errMsg(err)}`)
          }
          if (containers.getRuntime()) {
            try {
              const list = await containers.listContainers()
              const found = list.find((c) => c.name === `sk-${CONTAINER_NAME}`)
              if (found) containerImage = found.image
            } catch (err) {
              app.debug(`status: listContainers failed: ${errMsg(err)}`)
            }
          }
        }
        if (!containerImage) {
          containerImage = `${BACKUP_IMAGE}:${currentSettings?.imageTag ?? 'latest'}`
        }

        res.json({
          container: {
            state: containerState,
            image: containerImage,
            managed: currentSettings?.managedContainer !== false
          },
          ready: client !== null
        })
      })

      // Update detection — delegated to signalk-container's centralized
      // update service. Same pattern as mayara.
      router.get('/api/update/check', async (_req: Request, res: Response) => {
        const containers = getContainerManager()
        if (!containers) {
          res.status(503).json({ error: 'signalk-container not available' })
          return
        }
        try {
          const result = await containers.updates.checkOne(PLUGIN_ID)
          res.json(result)
        } catch (err) {
          res.status(500).json({ error: errMsg(err) })
        }
      })

      router.post('/api/update/apply', async (req: Request, res: Response) => {
        const containers = getContainerManager()
        if (!containers) {
          res.status(503).json({ error: 'signalk-container not available' })
          return
        }
        const body = (req.body ?? {}) as { tag?: unknown }
        const tag =
          (typeof body.tag === 'string' ? body.tag : undefined) ??
          currentSettings?.imageTag ??
          'latest'
        if (!SAFE_TAG.test(tag)) {
          res.status(400).json({ error: 'Invalid tag format' })
          return
        }

        try {
          app.setPluginStatus(`Pulling ${BACKUP_IMAGE}:${tag}...`)
          await containers.pullImage(`${BACKUP_IMAGE}:${tag}`)

          app.setPluginStatus('Recreating signalk-backup-server container...')
          await containers.remove(CONTAINER_NAME)
          try {
            await containers.ensureRunning(
              CONTAINER_NAME,
              buildContainerConfig(tag, currentSettings?.logLevel ?? 'info')
            )
          } catch (recreateErr) {
            const msg = `Container removed but recreation failed: ${errMsg(recreateErr)}. Click Update again to retry.`
            app.setPluginError(msg)
            res.status(500).json({ error: msg })
            return
          }

          if (currentSettings) {
            currentSettings.imageTag = tag
            await new Promise<void>((resolve) => {
              app.savePluginOptions({ ...currentSettings }, (err: NodeJS.ErrnoException | null) => {
                if (err) {
                  app.error(
                    `Failed to persist new tag: ${errMsg(err)}. Container is running with ${tag} but a plugin restart will revert.`
                  )
                }
                resolve()
              })
            })
          }

          app.setPluginStatus(`Updated to ${BACKUP_IMAGE}:${tag}`)
          res.json({ success: true, tag })
        } catch (err) {
          app.setPluginError(`Update failed: ${errMsg(err)}`)
          res.status(500).json({ error: errMsg(err) })
        }
      })

      // Proxy /api/* to the backup-server. Registered LAST so the
      // explicit /api/update/{check,apply} above match first.
      registerProxy(router, {
        getUpstreamBase: () => (containerAddress ? `http://${containerAddress}` : null),
        log: (msg) => {
          app.debug(msg)
        }
      })
    }
  }

  async function asyncStart(settings: Config): Promise<void> {
    if (!settings.managedContainer) {
      // External-server mode: skip the container, point at user-provided URL.
      const url = settings.externalUrl.trim()
      if (!url) {
        app.setPluginError(
          'managedContainer is disabled but externalUrl is empty. Set externalUrl in plugin config.'
        )
        return
      }
      client = new BackupClient(url)
      containerAddress = url.replace(/^https?:\/\//, '')
      try {
        await client.waitForReady(15_000)
        app.setPluginStatus(`Connected to external backup-server at ${url}`)
        await seedFirstRunSchedule(client)
        if (settings.databaseExport.questdb) {
          app.setPluginStatus(
            `Connected to external backup-server. Note: database export ` +
              `requires managed-container mode and was skipped.`
          )
        }
      } catch (err) {
        app.setPluginError(`External backup-server unreachable: ${errMsg(err)}`)
      }
      return
    }

    // signalk-container exposes its API via globalThis only after its own
    // start() has finished. Plugin-load order is alphabetical, and
    // "signalk-backup" comes before "signalk-container" — so on a cold
    // server start, getContainerManager() is undefined for the first few
    // hundred ms. Poll for up to 30s before giving up.
    const containers = await waitForContainerManager(120_000)
    if (!containers) {
      app.setPluginError(
        'signalk-container plugin not available after 120s. Install and enable it, then restart this plugin.'
      )
      return
    }
    if (!containers.getRuntime()) {
      app.setPluginError(
        'No container runtime detected (Podman or Docker). Install one and restart signalk-container.'
      )
      return
    }

    if (!SAFE_TAG.test(settings.imageTag)) {
      app.setPluginError(`Invalid imageTag "${settings.imageTag}"`)
      return
    }

    try {
      app.setPluginStatus(`Starting ${BACKUP_IMAGE}:${settings.imageTag}...`)
      await containers.ensureRunning(
        CONTAINER_NAME,
        buildContainerConfig(settings.imageTag, settings.logLevel)
      )

      // Register with the central update service so users see "update available"
      // badges in the signalk-container config panel without us writing custom
      // GitHub-poll logic.
      try {
        containers.updates.register({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: BACKUP_IMAGE,
          currentTag: () => currentSettings?.imageTag ?? settings.imageTag,
          versionSource: containers.updates.sources.githubReleases('dirkwa/signalk-backup-server')
        })
      } catch (err) {
        app.debug(`updates.register failed (non-fatal): ${errMsg(err)}`)
      }

      const addr = await resolveActualAddress(containers)
      if (!addr) {
        throw new Error('Could not resolve container address')
      }
      containerAddress = addr

      // `client` stays null until /api/health succeeds, so /status's
      // `ready: client !== null` reports the truthful upstream-reachable
      // signal rather than just "we know the address."
      const pending = new BackupClient(`http://${addr}`)
      app.setPluginStatus('Waiting for backup-server to become ready...')
      await pending.waitForReady(60_000)
      client = pending

      await seedFirstRunSchedule(client)
      startDbExportTimer()
    } catch (err) {
      app.setPluginError(`Container startup failed: ${errMsg(err)}`)
    }
  }

  /**
   * Start the database-export interval, if any DB exporter is enabled in
   * settings. The first export fires after one full interval — not at
   * startup — to avoid hammering the disk during server boot.
   */
  function startDbExportTimer(): void {
    stopDbExportTimer()
    const dbCfg = currentSettings?.databaseExport
    if (!dbCfg?.questdb) {
      app.debug('Database export: no exporters enabled, scheduler idle')
      return
    }
    const intervalMs = Math.max(5, dbCfg.intervalMinutes) * 60 * 1000
    app.debug(`Database export: scheduling every ${dbCfg.intervalMinutes}m`)
    dbExportTimer = setInterval(() => {
      void runDbExportTick()
    }, intervalMs)
  }

  function stopDbExportTimer(): void {
    if (dbExportTimer) {
      clearInterval(dbExportTimer)
      dbExportTimer = null
    }
  }

  async function runDbExportTick(): Promise<void> {
    // Coalesce: if a previous tick is still running (e.g. a slow large
    // table on a Pi), skip this one entirely rather than queuing.
    if (dbExportInFlight) {
      app.debug('Database export: previous tick still running, skipping')
      return
    }
    dbExportInFlight = true
    try {
      const results = await runAllExports({
        signalkConfigRoot: resolveSignalkConfigRoot(),
        signalkBaseUrl: resolveSignalkBaseUrl(),
        log: (msg) => {
          app.debug(msg)
        }
      })
      const totalTables = results.reduce((acc, r) => acc + r.tables.length, 0)
      const totalBytes = results.reduce((acc, r) => acc + r.totalBytes, 0)
      app.debug(
        `Database export tick: ${results.length} sources, ` +
          `${totalTables} tables, ${totalBytes} bytes`
      )
    } catch (err) {
      app.error(`Database export tick failed: ${errMsg(err)}`)
    } finally {
      dbExportInFlight = false
    }
  }

  /**
   * Resolve the host-visible SignalK config root. Prefer the env var
   * (authoritative when set) and fall back to walking up from
   * getDataDirPath(), which signalk-server guarantees returns
   * `<configRoot>/plugin-config-data/<pluginId>`.
   */
  function resolveSignalkConfigRoot(): string {
    const fromEnv = process.env['SIGNALK_NODE_CONFIG_DIR']
    if (fromEnv && fromEnv.length > 0) return fromEnv
    // dirname twice: <root>/plugin-config-data/signalk-backup → <root>
    return path.dirname(path.dirname(app.getDataDirPath()))
  }

  /**
   * Resolve the SignalK loopback URL — used to talk to source plugins
   * (e.g. signalk-questdb) over HTTP. Same convention used by
   * signalk-questdb itself: PORT env var with 3000 as default.
   */
  function resolveSignalkBaseUrl(): string {
    const port = process.env['PORT'] ?? '3000'
    return `http://127.0.0.1:${port}`
  }

  async function seedFirstRunSchedule(c: BackupClient): Promise<void> {
    try {
      const existing = await c.getSettings()
      const alreadyConfigured = existing.scheduler?.configured === true
      if (alreadyConfigured) {
        app.setPluginStatus(`Backup engine ready at ${containerAddress}`)
        return
      }

      // First run: opt-in safe defaults — daily local-only backup, no cloud.
      // The user must explicitly enable cloud sync from the GUI.
      await c.putSettings({
        scheduler: {
          configured: true,
          daily: { enabled: true, retain: 7 },
          hourly: { enabled: false, retain: 24 },
          weekly: { enabled: false, retain: 4 },
          startup: { enabled: true, retain: 3 }
        },
        cloud: { mode: 'off' }
      })
      app.setPluginStatus(
        `First-run: seeded daily local backup schedule. Open Backup Console to configure.`
      )
    } catch (err) {
      // Don't fail startup if seeding fails — the container is up and the
      // user can configure manually from the UI.
      app.debug(`First-run seed failed (non-fatal): ${errMsg(err)}`)
      app.setPluginStatus(`Backup engine ready at ${containerAddress}`)
    }
  }

  return plugin
}

/**
 * Best-effort SignalK version detection. Plumbed into the container so
 * backups can be tagged with the running SignalK version. Falls back to
 * "unknown" — never throws.
 */
function getSignalKVersion(app: BackupServerAPI): string {
  // ServerAPI doesn't expose a stable .version field across versions; many
  // builds make it available, but treating it as optional is safer.
  const candidate =
    (app as unknown as { signalk?: { version?: string }; version?: string }).signalk?.version ??
    (app as unknown as { version?: string }).version
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'unknown'
}
