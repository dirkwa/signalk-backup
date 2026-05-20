import path from 'node:path'
import { hostname } from 'node:os'
import { Plugin } from '@signalk/server-api'
import { Request, Response, IRouter } from 'express'
import { BackupClient } from './backup-client.js'
import { registerProxy } from './proxy.js'
import { discoverSmbHosts, shutdownSmbDiscovery } from './smb-discovery.js'
import {
  BackupServerAPI,
  ContainerConfig,
  ContainerManagerApi,
  ContainerResourceLimits,
  VolumeIssue
} from './types.js'
import { ConfigSchema, Config, SCHEMA_DEFAULTS } from './config/schema.js'
import { resolveImageTag } from './config/image-tag.js'
import { runAllExports } from './database-export/index.js'
import { registerStagingRoutes } from './database-export/staging-routes.js'
import { registerHostRestoreRoutes } from './restore-host-write.js'

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
// Cloud sync to Google Drive / SMB runs rclone with 8 parallel transfers
// alongside kopia; observed RSS during a real sync climbs well past
// 256 MB and the container gets OOM-killed. 1 GB gives comfortable
// headroom for the worst-case rclone+kopia path while still being a
// modest ask on a Pi-class host.
const DEFAULT_RESOURCES: ContainerResourceLimits = {
  cpus: 1,
  memory: '1g',
  memorySwap: '1g',
  pidsLimit: 100
}

function getContainerManager(): ContainerManagerApi | undefined {
  return globalThis.__signalk_containerManager
}

/**
 * Wait for signalk-container's API to be FULLY ready on globalThis —
 * both the manager object exposed AND its runtime detection complete.
 *
 * signalk-container publishes `__signalk_containerManager` synchronously
 * during its own start() but kicks off `detectRuntime` async, so there's
 * a ~1-2s window where getRuntime() returns null. signalk-backup loads
 * BEFORE signalk-container alphabetically and races into that window
 * unless we wait for both signals.
 */
async function waitForContainerManager(
  maxMs: number,
  intervalMs = 500
): Promise<ContainerManagerApi | undefined> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const m = getContainerManager()
    if (m && m.getRuntime()) return m
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
  // In-flight tick handle so concurrent callers (scheduler + manual
  // backup) coalesce onto the same export rather than racing.
  let dbExportInFlight: Promise<void> | null = null

  const buildContainerConfig = (tag: string): ContainerConfig => ({
    image: BACKUP_IMAGE,
    tag,
    // signalkConfigRootMount mounts the entire SignalK config root
    // (`~/.signalk/` typically) — settings.json, security.json, the
    // whole plugin-config-data tree. signalkDataMount would only mount
    // this plugin's own subdir, which isn't enough for backup/restore.
    // Requires signalk-container >= 1.5.0.
    signalkConfigRootMount: SK_MOUNT,
    signalkAccessiblePorts: [API_PORT, OAUTH_PORT],
    // Baseline mounts for the `local` cloud-sync provider (USB drives,
    // mounted folders). Both are declared with `ifMissing: 'skip'` so
    // signalk-container 1.6+ drops them silently on hosts that don't
    // have /media or /mnt. The backup-server's local-fs-service walks
    // these inside the container to enumerate USB-style and manual
    // mount destinations. Discovery returns an empty list when both
    // are skipped, which is the right fallback (the user can still
    // configure gdrive or other providers).
    volumes: {
      '/host-media': { source: '/media', ifMissing: 'skip' },
      '/host-mnt': { source: '/mnt', ifMissing: 'skip' }
    },
    env: {
      PORT: String(API_PORT),
      // The backup engine's own state lives in a plugin-config-data subdir
      // so it travels with the SignalK config (snapshotted by backup, included in restore).
      DATA_DIR: `${SK_MOUNT}/plugin-config-data/${PLUGIN_ID}`,
      SIGNALK_DATA_PATH: SK_MOUNT,
      SIGNALK_VERSION: getSignalKVersion(app),
      // Container's own hostname is a hex id; install-identity needs the host's real name for the folderId.
      HOST_HOSTNAME: hostname(),
      // Hardcoded to "info" — power users override via signalk-container's
      // containerOverrides.signalk-backup-server.env.LOG_LEVEL.
      LOG_LEVEL: 'info'
    },
    resources: DEFAULT_RESOURCES,
    restart: 'unless-stopped'
  })

  /**
   * Forward a signalk-container volume policy event to plugin status.
   * Skipped baseline mounts are normal (host has no /media); aborted
   * mounts shouldn't happen for our config but we surface them anyway.
   */
  const onVolumeIssue = (issue: VolumeIssue): void => {
    if (issue.action === 'skipped') {
      app.debug(`baseline mount skipped: ${issue.containerPath} (${issue.reason})`)
    } else if (issue.action === 'recovered') {
      app.debug(`baseline mount recovered: ${issue.containerPath}`)
    } else {
      app.error(`mount aborted: ${issue.containerPath} (${issue.reason})`)
    }
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Backup',
    description:
      'Scheduled deduplicated backups of SignalK config to local storage and Google Drive',

    schema: ConfigSchema,

    // RJSF reads hide-field directives from a sibling uiSchema, not the JSON schema.
    uiSchema: {
      databaseExport: { 'ui:widget': 'hidden' }
    },

    start(config: Partial<Config>) {
      app.debug('Starting signalk-backup')
      // CRITICAL: Signal K does not seed schema defaults into the runtime
      // config — when the plugin is auto-enabled (or enabled without
      // saving the form), `config` is `{}`. Deep-merge defaults so callers
      // can rely on every field being present, including nested fields
      // added in later versions (e.g. databaseExport.grafana for users
      // upgrading from a config saved before G2).
      const merged: Config = {
        ...SCHEMA_DEFAULTS,
        ...config,
        databaseExport: {
          ...SCHEMA_DEFAULTS.databaseExport,
          ...(config.databaseExport ?? {})
        }
      }
      currentSettings = merged
      void asyncStart(merged).catch((err: unknown) => {
        app.setPluginError(`Startup failed: ${errMsg(err)}`)
      })
    },

    async stop() {
      app.debug('Stopping signalk-backup')
      stopDbExportTimer()
      shutdownSmbDiscovery()
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
          containerImage = `${BACKUP_IMAGE}:${resolveImageTag(currentSettings?.imageTag ?? 'auto')}`
        }

        // pathMapping: translate backup-server container paths back to host paths for restore banners.
        const managed = currentSettings?.managedContainer !== false
        const pathMapping = managed
          ? { containerPath: SK_MOUNT, hostPath: resolveSignalkConfigRoot() }
          : undefined

        res.json({
          container: {
            state: containerState,
            image: containerImage,
            managed
          },
          ready: client !== null,
          ...(pathMapping ? { pathMapping } : {})
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
        if ('tag' in body && typeof body.tag !== 'string') {
          res.status(400).json({ error: 'tag must be a string' })
          return
        }
        const requestedTag =
          (typeof body.tag === 'string' ? body.tag : undefined) ??
          currentSettings?.imageTag ??
          'auto'
        if (!SAFE_TAG.test(requestedTag)) {
          res.status(400).json({ error: 'Invalid tag format' })
          return
        }
        const tag = resolveImageTag(requestedTag)

        try {
          app.setPluginStatus(`Pulling ${BACKUP_IMAGE}:${tag}...`)
          await containers.pullImage(`${BACKUP_IMAGE}:${tag}`)

          app.setPluginStatus('Recreating signalk-backup-server container...')
          await containers.remove(CONTAINER_NAME)
          try {
            await containers.ensureRunning(CONTAINER_NAME, buildContainerConfig(tag), {
              onVolumeIssue
            })
          } catch (recreateErr) {
            const msg = `Container removed but recreation failed: ${errMsg(recreateErr)}. Click Update again to retry.`
            app.setPluginError(msg)
            res.status(500).json({ error: msg })
            return
          }

          // Persist requestedTag not resolved tag: saving "auto" preserves auto-tracking across upgrades.
          if (currentSettings) {
            currentSettings.imageTag = requestedTag
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

      // Plugin owns the timer; backup-server only consumes the Parquet
      // files when it next snapshots — so the config lives here, not there.
      router.get('/api/db-export/config', (_req: Request, res: Response) => {
        const cfg = currentSettings?.databaseExport ?? SCHEMA_DEFAULTS.databaseExport
        res.json({ success: true, data: cfg, timestamp: new Date().toISOString() })
      })

      router.post('/api/db-export/config', async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as {
          questdb?: unknown
          grafana?: unknown
          signalkDatabase?: unknown
          intervalMinutes?: unknown
        }

        const questdb = typeof body.questdb === 'boolean' ? body.questdb : undefined
        const grafana = typeof body.grafana === 'boolean' ? body.grafana : undefined
        const signalkDatabase =
          typeof body.signalkDatabase === 'boolean' ? body.signalkDatabase : undefined
        const intervalMinutes =
          typeof body.intervalMinutes === 'number' && Number.isFinite(body.intervalMinutes)
            ? Math.round(body.intervalMinutes)
            : undefined

        if (
          questdb === undefined &&
          grafana === undefined &&
          signalkDatabase === undefined &&
          intervalMinutes === undefined
        ) {
          res.status(400).json({
            success: false,
            error: {
              code: 'INVALID_INPUT',
              message:
                'Provide questdb (boolean), grafana (boolean), signalkDatabase (boolean), and/or intervalMinutes (number).'
            },
            timestamp: new Date().toISOString()
          })
          return
        }

        if (intervalMinutes !== undefined && (intervalMinutes < 5 || intervalMinutes > 1440)) {
          res.status(400).json({
            success: false,
            error: {
              code: 'INVALID_INPUT',
              message: 'intervalMinutes must be between 5 and 1440.'
            },
            timestamp: new Date().toISOString()
          })
          return
        }

        if (!currentSettings) {
          res.status(503).json({
            success: false,
            error: { code: 'NOT_READY', message: 'Plugin settings not loaded yet.' },
            timestamp: new Date().toISOString()
          })
          return
        }

        const next = {
          questdb: questdb ?? currentSettings.databaseExport.questdb,
          grafana: grafana ?? currentSettings.databaseExport.grafana,
          signalkDatabase: signalkDatabase ?? currentSettings.databaseExport.signalkDatabase,
          intervalMinutes: intervalMinutes ?? currentSettings.databaseExport.intervalMinutes
        }
        currentSettings.databaseExport = next

        // Persist via SignalK's plugin-options store so the new value
        // survives restart. Reject on failure so the route surfaces the
        // problem to the user — silently logging would be a footgun
        // (UI says "saved" then a restart wipes the change).
        try {
          await new Promise<void>((resolve, reject) => {
            app.savePluginOptions({ ...currentSettings }, (err: NodeJS.ErrnoException | null) => {
              if (err) reject(err)
              else resolve()
            })
          })
        } catch (err) {
          app.error(`Failed to persist database-export config: ${errMsg(err)}`)
          res.status(500).json({
            success: false,
            error: { code: 'PERSIST_FAILED', message: errMsg(err) },
            timestamp: new Date().toISOString()
          })
          return
        }

        // Restart the timer so the new interval/enabled state takes
        // effect immediately, without waiting for the next plugin start.
        startDbExportTimer()

        res.json({ success: true, data: next, timestamp: new Date().toISOString() })
      })

      // Live staging tree — files the plugin's own db-export tick wrote
      // to <getDataDirPath()>/database-exports/<sourcePluginId>/. The
      // root is hard-pinned here; the route handlers refuse anything
      // that resolves outside it. Snapshotted shards (from older
      // backups) go through the backup-server's /download-subtree.
      registerStagingRoutes(router, {
        getStagingRoot: () => path.join(app.getDataDirPath(), 'database-exports'),
        log: (msg) => {
          app.debug(msg)
        }
      })

      // Host-side restore for "Custom path" targets — bypasses the
      // backup-server container's filesystem so the user can land
      // restored files anywhere the SignalK process can write.
      // Original-location restores still go through the proxy to the
      // server's restore-partial route.
      registerHostRestoreRoutes(router, {
        getUpstreamBase: () => containerAddress,
        log: (msg) => {
          app.debug(msg)
        }
      })

      // Discovery runs here, not in the container, so multicast doesn't
      // have to traverse the backup-server's network namespace.
      router.get('/api/cloud/smb/discover', async (_req: Request, res: Response) => {
        try {
          const hosts = await discoverSmbHosts(2000)
          res.json({
            success: true,
            data: { hosts },
            timestamp: new Date().toISOString()
          })
        } catch (err) {
          res.status(500).json({
            success: false,
            error: { code: 'DISCOVER_FAILED', message: errMsg(err) },
            timestamp: new Date().toISOString()
          })
        }
      })

      // Manual-backup interceptor — runs DB exports synchronously
      // before forwarding to the backup-server's snapshot endpoint, so
      // the resulting kopia snapshot captures fresh DB state. Without
      // this, a manual backup would snapshot whatever stale (or empty)
      // files the last scheduler tick left in the staging dir.
      router.post('/api/backups', async (_req: Request, _res: Response, next) => {
        const dbCfg = currentSettings?.databaseExport
        if (dbCfg?.questdb || dbCfg?.grafana || dbCfg?.signalkDatabase) {
          // runDbExportTick logs and swallows failures internally — a
          // backup with stale DB state is better than no backup, so we
          // always continue to the proxy regardless of export outcome.
          await runDbExportTick()
        }
        next()
      })

      // Proxy /api/* to the backup-server. Registered LAST so the
      // explicit /api/update/{check,apply} and /api/cloud/smb/discover
      // above match first. containerAddress includes the scheme so
      // external-mode HTTPS upstreams aren't downgraded.
      registerProxy(router, {
        getUpstreamBase: () => containerAddress,
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
      // Keep the scheme so the proxy can route HTTPS external upstreams.
      containerAddress = url
      try {
        await client.waitForReady(15_000)
        app.setPluginStatus(`Connected to external backup-server at ${url}`)
        await seedFirstRunSchedule(client)
        if (
          settings.databaseExport.questdb ||
          settings.databaseExport.grafana ||
          settings.databaseExport.signalkDatabase
        ) {
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
    const resolvedTag = resolveImageTag(settings.imageTag)

    try {
      app.setPluginStatus(`Starting ${BACKUP_IMAGE}:${resolvedTag}...`)
      await containers.ensureRunning(CONTAINER_NAME, buildContainerConfig(resolvedTag), {
        onVolumeIssue
      })

      // Register with the central update service so users see "update available"
      // badges in the signalk-container config panel without us writing custom
      // GitHub-poll logic.
      try {
        containers.updates.register({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: BACKUP_IMAGE,
          currentTag: () => resolveImageTag(currentSettings?.imageTag ?? settings.imageTag),
          versionSource: containers.updates.sources.githubReleases('dirkwa/signalk-backup-server')
        })
      } catch (err) {
        app.debug(`updates.register failed (non-fatal): ${errMsg(err)}`)
      }

      const addr = await resolveActualAddress(containers)
      if (!addr) {
        throw new Error('Could not resolve container address')
      }
      // Container is always plain HTTP on the host loopback; storing the
      // full URL keeps the format consistent with external-mode (which
      // may be HTTPS) so the proxy can use the same value as-is.
      containerAddress = `http://${addr}`

      // `client` stays null until /api/health succeeds, so /status's
      // `ready: client !== null` reports the truthful upstream-reachable
      // signal rather than just "we know the address."
      const pending = new BackupClient(containerAddress)
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
    // External backup-server mode doesn't run the export pipeline — the
    // exporters write into our local plugin-config-data tree, which the
    // external server has no access to. Don't arm an interval that
    // would no-op on every tick.
    if (currentSettings?.managedContainer === false) {
      app.debug('Database export: external mode, scheduler idle')
      return
    }
    const dbCfg = currentSettings?.databaseExport
    if (!dbCfg?.questdb && !dbCfg?.grafana && !dbCfg?.signalkDatabase) {
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

  // Pure body — the coalescing/promise-tracking happens in
  // runDbExportTick() so callers always get a single shared promise.
  async function runDbExportOnce(): Promise<void> {
    // Belt-and-braces: the scheduler timer and the POST /api/backups
    // interceptor both gate on managedContainer too, but this is the
    // single chokepoint every caller flows through. In external mode
    // there's nowhere local to stage exports for the external server
    // to pick up, so the whole pipeline is a no-op.
    if (currentSettings?.managedContainer === false) {
      app.debug('Database export: skipped (external mode)')
      return
    }
    const dbCfg = currentSettings?.databaseExport ?? SCHEMA_DEFAULTS.databaseExport
    const results = await runAllExports({
      signalkConfigRoot: resolveSignalkConfigRoot(),
      signalkBaseUrl: resolveSignalkBaseUrl(),
      log: (msg) => {
        app.debug(msg)
      },
      enabled: {
        questdb: dbCfg.questdb,
        grafana: dbCfg.grafana,
        signalkDatabase: dbCfg.signalkDatabase
      }
    })
    const totalTables = results.reduce((acc, r) => acc + r.tables.length, 0)
    const totalBytes = results.reduce((acc, r) => acc + r.totalBytes, 0)
    app.debug(
      `Database export tick: ${results.length} sources, ` +
        `${totalTables} tables, ${totalBytes} bytes`
    )
  }

  // Coalesce concurrent callers — a manual backup hitting this while
  // the scheduler tick is still in-flight should await the same export,
  // not skip out and snapshot mid-write.
  function runDbExportTick(): Promise<void> {
    if (dbExportInFlight) return dbExportInFlight
    dbExportInFlight = runDbExportOnce()
      .catch((err: unknown) => {
        app.error(`Database export tick failed: ${errMsg(err)}`)
      })
      .finally(() => {
        dbExportInFlight = null
      })
    return dbExportInFlight
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
