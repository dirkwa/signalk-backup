import path from 'node:path'
import { hostname } from 'node:os'
import { Plugin } from '@signalk/server-api'
import { Request, Response, IRouter } from 'express'
import {
  ManagedContainer,
  getContainerManager,
  retryForever,
  startSafely
} from 'signalk-container-helper'
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
import { startSignalKEmitter, stopSignalKEmitter } from './signalk-deltas.js'
import { resolveSignalkBaseUrl as resolveBaseUrl } from './signalk-base-url.js'
import { errMsg } from './errors.js'

const BACKUP_IMAGE = 'ghcr.io/dirkwa/signalk-backup-server'
const CONTAINER_NAME = 'signalk-backup-server'
const PLUGIN_ID = 'signalk-backup'
const SK_MOUNT = '/signalk-data'
const API_PORT = 3010
const OAUTH_PORT = 53682

// Readiness-retry backoff (15s doubling to a 2min ceiling, forever): a transient boot race must not wedge the plugin until a human restarts it — on a boat that can be weeks later.
const READY_RETRY_MIN_MS = 15_000
const READY_RETRY_MAX_MS = 120_000

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

export default function (app: BackupServerAPI): Plugin {
  let client: BackupClient | null = null
  let currentSettings: Config | null = null
  let containerAddress: string | null = null
  let dbExportTimer: NodeJS.Timeout | null = null
  // In-flight tick handle so concurrent callers (scheduler + manual
  // backup) coalesce onto the same export rather than racing.
  let dbExportInFlight: Promise<void> | null = null
  // Bumped on every start()/stop() so async work from an older lifecycle can
  // detect it's stale and bail. The helper's own serialization and AbortSignal
  // cover the container operations; this still guards everything it knows
  // nothing about — the SignalK emitter, the db-export timer, and the whole
  // external-server branch, which never touches a container at all.
  let lifecycleGeneration = 0
  // Cancels in-flight container work on stop(); recreated per start().
  let startAbort: AbortController | null = null

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

  // Built once, before the plugin object: registerWithRouter() can run before
  // start(), and the update routes are mounted off this instance.
  const container = new ManagedContainer({
    app,
    pluginId: PLUGIN_ID,
    // Unprefixed. The helper matches the live container by `unprefixedName`,
    // so this keeps working under a non-default SIGNALK_CONTAINER_NAMESPACE —
    // the hard-coded `sk-` prefix this replaces did not.
    name: CONTAINER_NAME,
    image: BACKUP_IMAGE,
    buildConfig: buildContainerConfig,
    defaultTag: 'auto',
    // 'auto' → the pinned, tested backup-server version. Applied to start(),
    // applyUpdate() and route input alike, and the helper validates both the
    // requested and the resolved tag (replacing the old SAFE_TAG check).
    resolveTag: resolveImageTag,
    managerTimeoutMs: 120_000,
    readiness: {
      port: API_PORT,
      path: '/api/health',
      maxMs: 60_000
    },
    readinessRetry: {
      minDelayMs: READY_RETRY_MIN_MS,
      maxDelayMs: READY_RETRY_MAX_MS,
      onAttemptFailed: (err, nextDelayMs) => {
        app.setPluginError(
          `Container startup failed: ${errMsg(err)} — retrying in ${Math.round(nextDelayMs / 1000)}s`
        )
      }
    },
    updates: {
      versionSource: { githubReleases: 'dirkwa/signalk-backup-server' },
      currentTag: () => resolveImageTag(currentSettings?.imageTag ?? 'auto')
    },
    ensureOptions: { onVolumeIssue }
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
      const gen = ++lifecycleGeneration
      // Retire any previous startup first. Without this a start() during an
      // in-flight start orphans the old retry loop: readinessRetry never
      // returns while it is retrying, so the generation check below cannot
      // reach it, and it keeps reporting failures for a dead lifecycle.
      startAbort?.abort()
      const abort = new AbortController()
      startAbort = abort
      // SignalK re-runs start() on a config save with no stop(), so keeping these reported the previous upstream's readiness while connecting to a new one.
      client = null
      containerAddress = null
      // startSafely: SignalK does not await start(), and it demotes the
      // helper's `cancelled` error to debug so stopping mid-startup doesn't
      // leave "Startup failed: Operation cancelled" in the plugin error box.
      startSafely(app, () => asyncStart(merged, gen, abort.signal))
    },

    async stop() {
      app.debug('Stopping signalk-backup')
      // Invalidate any pending startup/readiness-retry work.
      lifecycleGeneration++
      // Abort BEFORE awaiting the stop: the readiness retry loop is otherwise
      // free to queue another attempt behind it.
      startAbort?.abort()
      startAbort = null
      stopSignalKEmitter()
      stopDbExportTimer()
      shutdownSmbDiscovery()
      client = null
      containerAddress = null

      if (currentSettings?.managedContainer !== false) {
        // Unregisters updates and stops (not removes) the container; never throws.
        await container.stop()
      }
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router: IRouter) {
      // Lightweight readiness signal for admin/webapp badges.
      router.get('/status', async (_req: Request, res: Response) => {
        // getInfo() never throws: 'unknown' state and an empty image when the
        // manager or runtime is absent.
        const { state, image } = await container.getInfo()
        const containerImage =
          image || `${BACKUP_IMAGE}:${resolveImageTag(currentSettings?.imageTag ?? 'auto')}`

        // WHY: pathMapping.hostPath is operator-facing; resolveSignalkConfigRoot is SK-internal when SK is in a container.
        const managed = currentSettings?.managedContainer !== false
        const pathMapping = managed
          ? {
              containerPath: SK_MOUNT,
              hostPath: await resolveSignalkConfigRootOnHost(getContainerManager())
            }
          : undefined

        res.json({
          container: {
            state,
            image: containerImage,
            managed
          },
          // `client` is published only once the upstream has answered, in both modes. Managed mode also ANDs in the live state, since `client` is cleared only in stop() and so kept reporting ready for a container that had gone away (#103).
          ready: client !== null && (!managed || state === 'running'),
          ...(pathMapping ? { pathMapping } : {})
        })
      })

      // Update detection — delegated to signalk-container's centralized
      // update service. Mounts GET /api/update/check and POST
      // /api/update/apply — the same paths the webapp already calls.
      container.registerUpdateRoutes(router, {
        onApplied: async (requestedTag, resolvedTag) => {
          // Persist requestedTag not resolved tag: saving "auto" preserves auto-tracking across upgrades.
          if (!currentSettings) {
            // Both dropped-persistence paths log: silently skipping would let
            // a restart revert the update with nothing in the log to explain it.
            app.error(
              `Updated to ${resolvedTag} but could not persist "${requestedTag}": plugin settings not loaded. A plugin restart will revert.`
            )
            return
          }
          currentSettings.imageTag = requestedTag
          await new Promise<void>((resolve) => {
            app.savePluginOptions({ ...currentSettings }, (err: NodeJS.ErrnoException | null) => {
              if (err) {
                app.error(
                  `Failed to persist new tag: ${errMsg(err)}. Container is running with ${resolvedTag} but a plugin restart will revert.`
                )
              }
              resolve()
            })
          })
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

  async function asyncStart(settings: Config, gen: number, signal: AbortSignal): Promise<void> {
    if (!settings.managedContainer) {
      // External-server mode: skip the container, point at user-provided URL.
      const url = settings.externalUrl.trim()
      if (!url) {
        app.setPluginError(
          'managedContainer is disabled but externalUrl is empty. Set externalUrl in plugin config.'
        )
        return
      }
      const external = new BackupClient(url)
      // Only the address is published here, scheme included so the proxy can route HTTPS upstreams; `client` waits for finishExternal, or /status would report ready before the upstream had answered.
      containerAddress = url
      // No container here, so the helper's ManagedContainer has nothing to do —
      // but the retry policy is the same, so reuse its primitive directly.
      await retryForever(
        async () => {
          if (gen !== lifecycleGeneration) return
          // retryForever only checks between attempts, so the signal must reach the probe itself.
          await external.waitForReady(15_000, 1000, signal)
          await finishExternal(gen, settings, external, url)
        },
        {
          minDelayMs: READY_RETRY_MIN_MS,
          maxDelayMs: READY_RETRY_MAX_MS,
          signal,
          onAttemptFailed: (err, nextDelayMs) => {
            app.setPluginError(
              `External backup-server at ${url} unreachable: ${errMsg(err)} — retrying in ${Math.round(nextDelayMs / 1000)}s`
            )
          }
        }
      )
      return
    }

    // Managed-container mode. readinessRetry means this resolves only once the
    // container answers /api/health, or rejects on cancellation — it does not
    // give up and leave the plugin wedged.
    const { address } = await container.start(settings.imageTag, { signal })
    if (gen !== lifecycleGeneration) return
    if (!address) throw new Error('Could not resolve container address')

    // Full URL keeps the format consistent with external mode (which may be
    // HTTPS) so the proxy can use the value as-is.
    containerAddress = address
    // Managed mode assigns `client` only after /api/health answers, so /status reports having reached the upstream rather than just knowing its address.
    const pending = new BackupClient(address)
    await finishStartup(gen, settings, pending, address)
  }

  // Generation-guarded so a stop()/restart during a slow health probe can't resurrect stale timers or emitters.
  async function finishStartup(
    gen: number,
    settings: Config,
    pending: BackupClient,
    address: string
  ): Promise<void> {
    if (gen !== lifecycleGeneration) return
    client = pending
    await seedFirstRunSchedule(pending)
    if (gen !== lifecycleGeneration) return
    startSignalKEmitter(app, address, {
      emitSignalKDeltas: settings.emitSignalKDeltas
    })
    startDbExportTimer()
  }

  async function finishExternal(
    gen: number,
    settings: Config,
    c: BackupClient,
    url: string
  ): Promise<void> {
    if (gen !== lifecycleGeneration) return
    // Deferred to here so ready cannot be true before the upstream answered.
    client = c
    app.setPluginStatus(`Connected to external backup-server at ${url}`)
    await seedFirstRunSchedule(c)
    if (gen !== lifecycleGeneration) return
    startSignalKEmitter(app, url, { emitSignalKDeltas: settings.emitSignalKDeltas })
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
      warn: (msg) => {
        app.error(msg)
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

  // WHY: returns SK's own filesystem view; use only for plugin-internal mkdir/stat — not for operator-facing host paths.
  function resolveSignalkConfigRoot(): string {
    const fromEnv = process.env['SIGNALK_NODE_CONFIG_DIR']
    if (fromEnv && fromEnv.length > 0) return fromEnv
    // dirname twice: <root>/plugin-config-data/signalk-backup → <root>
    return path.dirname(path.dirname(app.getDataDirPath()))
  }

  // WHY: in-container SK needs signalk-container to translate the config root to a host-visible path; fall back to the local view on any failure so bare-metal and older signalk-container keep working.
  async function resolveSignalkConfigRootOnHost(
    containers: ContainerManagerApi | undefined
  ): Promise<string> {
    const local = resolveSignalkConfigRoot()
    if (!containers || typeof containers.resolveHostPath !== 'function') return local
    try {
      const resolved = await containers.resolveHostPath(local)
      // WHY: join source + subPath to handle parent-directory mounts (subPath is "" for exact-match mounts).
      return resolved ? path.join(resolved.source, resolved.subPath) : local
    } catch (err) {
      app.debug(
        `resolveSignalkConfigRootOnHost: resolveHostPath threw: ${errMsg(err)}; falling back to ${local}`
      )
      return local
    }
  }

  function resolveSignalkBaseUrl(): string {
    return resolveBaseUrl(app)
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
