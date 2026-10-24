import path from 'node:path'
import { hostname } from 'node:os'
import { Plugin } from '@signalk/server-api'
import { Request, Response, IRouter } from 'express'
import {
  ManagedContainer,
  getContainerManager,
  isValidImageTag,
  retryForever,
  startSafely,
  waitForContainerManager
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
import {
  BACKUP_SERVER_REPO,
  BACKUP_SERVER_VERSION,
  isConcreteSemver,
  resolveImageTag
} from './config/image-tag.js'
import { resolveAutoTag } from './config/resolve-auto-tag.js'
import { installServerVersion, pickServerUpdate } from './server-update.js'
import { runAllExports } from './database-export/index.js'
import { registerStagingRoutes } from './database-export/staging-routes.js'
import { isHostRestoreRunning, registerHostRestoreRoutes } from './restore-host-write.js'
import { startSignalKEmitter, stopSignalKEmitter } from './signalk-deltas.js'
import { UplinkReporter } from './uplink-state.js'
import { resolveSignalkBaseUrl as resolveBaseUrl } from './signalk-base-url.js'
import { errMsg } from './errors.js'

const BACKUP_IMAGE = 'ghcr.io/dirkwa/signalk-backup-server'
const CONTAINER_NAME = 'signalk-backup-server'
const PLUGIN_ID = 'signalk-backup'
const SK_MOUNT = '/signalk-data'
const API_PORT = 3010
const OAUTH_PORT = 53682

// Podman's Docker-compat socket drops an image's own HEALTHCHECK, so a
// container created through it has no probe and sits in `starting` forever.
// signalk-container re-emits this as explicit --health-* run flags. Keep in
// sync with the HEALTHCHECK in signalk-backup-server's Dockerfile, which is
// the source of truth; the image ships neither curl nor wget, so node is the
// only client available. http.get rather than fetch, matching that Dockerfile.
const HEALTH_PROBE = `const r=require('http').get('http://127.0.0.1:${API_PORT}/api/health',res=>{res.resume();process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(5000,()=>{r.destroy();process.exit(1)})`

// Readiness-retry backoff (15s doubling to a 2min ceiling, forever): a transient boot race must not wedge the plugin until a human restarts it — on a boat that can be weeks later.
const READY_RETRY_MIN_MS = 15_000
const READY_RETRY_MAX_MS = 120_000

// Automatic server updates. The first check waits out boot and the startup
// backup; a server busy restoring is asked again well before the next check.
const SERVER_UPDATE_FIRST_CHECK_MS = 5 * 60_000
const SERVER_UPDATE_INTERVAL_MS = 6 * 60 * 60_000
const SERVER_UPDATE_BUSY_RETRY_MS = 15 * 60_000
// How long a recreated server gets to answer /api/health before it is rolled back.
const SERVER_UPDATE_READY_MS = 3 * 60_000

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
  // The helper's resolveTag hook is sync, so asyncStart resolves "auto" and parks it here.
  let resolvedAutoTag: string | null = null
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
  let serverUpdateTimer: NodeJS.Timeout | null = null
  const uplinkReporter = new UplinkReporter({ app, target: () => client })
  // Releases that would not start; the automatic updater skips them until Signal K restarts.
  const failedServerVersions = new Set<string>()
  // One install at a time: "Apply update" and the automatic updater both swap the container.
  let serverInstalling = false

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
    // CMD-SHELL, not CMD: the CMD form is re-split on whitespace before it
    // reaches the runtime, which shreds the script into `node -e const ...`.
    // The image ships /bin/sh, and the Dockerfile's own HEALTHCHECK uses the
    // shell form too.
    healthcheck: {
      test: ['CMD-SHELL', `node -e ${JSON.stringify(HEALTH_PROBE)}`],
      interval: '30s',
      timeout: '5s',
      // Covers container boot: the probe exits non-zero immediately
      // (ECONNREFUSED) until the server is listening.
      startPeriod: '15s',
      retries: 3
    },
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
    defaultTag: SCHEMA_DEFAULTS.imageTag,
    // Maps "auto" to the version asyncStart resolved; every other tag passes through.
    // A closure, not resolveImageTag itself: the helper passes the requested tag alone,
    // which always resolved "auto" to the floor.
    resolveTag: (tag) => resolveImageTag(tag, resolvedAutoTag),
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
      versionSource: { githubReleases: BACKUP_SERVER_REPO },
      currentTag: () =>
        resolveImageTag(currentSettings?.imageTag ?? SCHEMA_DEFAULTS.imageTag, resolvedAutoTag)
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
      stopServerUpdateTimer()
      uplinkReporter.stop()
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
      stopServerUpdateTimer()
      uplinkReporter.stop()
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
          image ||
          `${BACKUP_IMAGE}:${resolveImageTag(currentSettings?.imageTag ?? SCHEMA_DEFAULTS.imageTag, resolvedAutoTag)}`

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

      // GET /api/update/check and POST /api/update/apply, the paths the
      // webapp's container card calls. Detection is signalk-container's update
      // service. Not the helper's registerUpdateRoutes: its apply re-applies the
      // tag the container last started, which under "auto" is the running
      // version, so it installed nothing and then pinned that version.
      router.get('/api/update/check', async (_req: Request, res: Response) => {
        try {
          const result = await container.checkForUpdate()
          if (!result) {
            res.status(503).json({ error: 'signalk-container not available' })
            return
          }
          res.json(result)
        } catch (err) {
          res.status(500).json({ error: errMsg(err) })
        }
      })

      router.post('/api/update/apply', async (req: Request, res: Response) => {
        if (!getContainerManager()) {
          res.status(503).json({ error: 'signalk-container not available' })
          return
        }
        const body = req.body as { tag?: unknown } | undefined
        const requested =
          typeof body?.tag === 'string' && body.tag.length > 0
            ? body.tag
            : (currentSettings?.imageTag ?? SCHEMA_DEFAULTS.imageTag)
        if (!isValidImageTag(requested)) {
          res.status(400).json({ error: `Invalid tag: ${JSON.stringify(requested)}` })
          return
        }
        if (serverInstalling) {
          res.status(409).json({ error: 'A backup server update is already running.' })
          return
        }
        try {
          const tag = await applyServerUpdate(requested)
          res.json({ success: true, tag })
        } catch (err) {
          const msg = errMsg(err)
          app.setPluginError(`Update failed: ${msg}`)
          res.status(500).json({ error: msg })
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

  // "auto" moves to the release the update check reported; any other tag is re-applied as configured.
  async function applyServerUpdate(requested: string): Promise<string> {
    const tag = await exclusively(async () => {
      if (requested === 'auto') {
        const check = await container.checkForUpdate()
        const latest = check?.updateAvailable ? check.latestVersion : null
        if (latest && isConcreteSemver(latest)) {
          await pullServerImage(latest)
          await installServerRelease(latest, lifecycleGeneration)
          return latest
        }
      }
      const applied = await container.applyUpdate(requested)
      await persistAppliedTag(requested, applied.tag)
      const addr = await container.resolveAddress(API_PORT)
      if (addr) adoptServerAddress(`http://${addr}`)
      uplinkReporter.start()
      return applied.tag
    })
    // The apply saved imageTag without a restart: a pinned tag stops the updater, "auto" re-arms it.
    if (client) scheduleServerUpdate(lifecycleGeneration, SERVER_UPDATE_INTERVAL_MS)
    return tag
  }

  // "Apply update" and the automatic updater both swap the container, so only one runs at a time.
  async function exclusively<T>(work: () => Promise<T>): Promise<T> {
    if (serverInstalling) throw new Error('A backup server update is already running.')
    serverInstalling = true
    try {
      return await work()
    } finally {
      serverInstalling = false
    }
  }

  // signalk-container's recreate removes the old container before it pulls,
  // so downloading first keeps backups running for the length of the download.
  async function pullServerImage(tag: string): Promise<void> {
    const manager = getContainerManager()
    if (!manager) throw new Error('signalk-container not available')
    await manager.pullImage(`${BACKUP_IMAGE}:${tag}`)
  }

  // Moves "auto" to `target`, whose image must already be pulled; rolls back if it does not start.
  async function installServerRelease(target: string, gen: number): Promise<void> {
    const previous = resolvedAutoTag ?? BACKUP_SERVER_VERSION
    try {
      await installServerVersion(target, previous, {
        swap: async (tag) => {
          if (gen !== lifecycleGeneration) throw new Error('plugin restarted during the update')
          resolvedAutoTag = tag
          await container.applyUpdate('auto')
        },
        waitReady: async () => {
          const addr = await container.resolveAddress(API_PORT)
          if (!addr) throw new Error('recreated container has no address')
          await new BackupClient(`http://${addr}`).waitForReady(SERVER_UPDATE_READY_MS)
          adoptServerAddress(`http://${addr}`)
        }
      })
    } catch (err) {
      failedServerVersions.add(target)
      throw err
    }
    await persistAppliedTag('auto', target)
    // The recreated server starts without the link state, even when it kept its address.
    uplinkReporter.start()
    app.setPluginStatus(`Backup server updated to ${target}`)
  }

  // A recreated container may come back on another host port.
  function adoptServerAddress(address: string): void {
    if (!client || !currentSettings || address === containerAddress) return
    containerAddress = address
    client = new BackupClient(address)
    stopSignalKEmitter()
    startSignalKEmitter(app, address, { emitSignalKDeltas: currentSettings.emitSignalKDeltas })
    void uplinkReporter.report()
  }

  function autoUpdateEnabled(): boolean {
    return currentSettings?.imageTag === 'auto' && currentSettings.autoUpdateServer
  }

  function scheduleServerUpdate(gen: number, delayMs: number): void {
    stopServerUpdateTimer()
    if (!autoUpdateEnabled()) return
    serverUpdateTimer = setTimeout(() => {
      serverUpdateTimer = null
      void checkServerUpdate(gen).then((nextMs) => {
        if (gen === lifecycleGeneration) scheduleServerUpdate(gen, nextMs)
      })
    }, delayMs)
  }

  function stopServerUpdateTimer(): void {
    if (serverUpdateTimer) {
      clearTimeout(serverUpdateTimer)
      serverUpdateTimer = null
    }
  }

  // Resolves to the delay before the next check; never rejects. Being offline
  // or failing a download is routine on a boat and only logged; an install
  // that had to roll back is reported as a plugin error.
  async function checkServerUpdate(gen: number): Promise<number> {
    // Checked again after every await: "Apply update" with a pinned tag saves
    // it without a restart, so the generation alone does not catch it.
    const wanted = () => gen === lifecycleGeneration && autoUpdateEnabled()
    const busy = () => serverInstalling || isHostRestoreRunning()
    let target: string | null
    try {
      if (!wanted()) return SERVER_UPDATE_INTERVAL_MS
      const check = await container.checkForUpdate()
      const current = resolvedAutoTag
      // An offline result is the cached one, and its download would fail.
      if (!current || !check || check.reason === 'offline') return SERVER_UPDATE_INTERVAL_MS
      target = pickServerUpdate(current, check.latestVersion, failedServerVersions)
      if (!target || !wanted()) return SERVER_UPDATE_INTERVAL_MS
      await pullServerImage(target)
    } catch (err) {
      app.debug(`Backup server update check failed: ${errMsg(err)}`)
      return SERVER_UPDATE_INTERVAL_MS
    }
    if (!wanted()) return SERVER_UPDATE_INTERVAL_MS
    if (busy() || !(await client?.isIdle()) || busy()) {
      app.debug(`Backup server ${target} is downloaded; installing once no restore is running`)
      return SERVER_UPDATE_BUSY_RETRY_MS
    }
    if (!wanted()) return SERVER_UPDATE_INTERVAL_MS
    // "Apply update" may have installed this release, or a newer one, during the pull.
    const current = resolvedAutoTag
    if (!current || pickServerUpdate(current, target, failedServerVersions) !== target) {
      app.debug(`Backup server ${target} is no longer an update for ${current ?? 'this install'}`)
      return SERVER_UPDATE_INTERVAL_MS
    }
    try {
      await exclusively(() => installServerRelease(target, gen))
    } catch (err) {
      if (gen === lifecycleGeneration) {
        app.setPluginError(`Automatic backup server update failed: ${errMsg(err)}`)
      }
    }
    return SERVER_UPDATE_INTERVAL_MS
  }

  async function persistAppliedTag(requestedTag: string, resolvedTag: string): Promise<void> {
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
    // Pin the result too, or the persisted short-circuit would undo this update next start.
    currentSettings.resolvedImageTag = resolvedTag
    resolvedAutoTag = resolvedTag
    // Rejects so the route cannot report an update that the next restart undoes.
    await new Promise<void>((resolve, reject) => {
      app.savePluginOptions({ ...currentSettings }, (err: NodeJS.ErrnoException | null) => {
        if (err) {
          app.error(
            `Failed to persist new tag: ${errMsg(err)}. Container is running with ${resolvedTag} but a plugin restart will revert.`
          )
          // The full error stays in the log above: its message can name internal
          // paths. The errno code alone says what to fix without them.
          const reason = saveFailureReason(err)
          reject(
            new Error(
              `Running ${resolvedTag}, but saving it failed${reason ? ` (${reason})` : ''}, so a plugin restart will go back. See the server log.`
            )
          )
          return
        }
        resolve()
      })
    })
  }

  // Lets the next start short-circuit without a lookup; a failed save costs a lookup, never startup.
  async function persistResolvedTag(tag: string, gen: number): Promise<void> {
    // savePluginOptions writes the whole options object, so a save from a
    // superseded lifecycle would republish that generation's imageTag over
    // whatever the user has since saved.
    if (gen !== lifecycleGeneration) return
    if (!currentSettings || currentSettings.resolvedImageTag === tag) return
    currentSettings.resolvedImageTag = tag
    // Spread at call time, not before: a snapshot captured earlier would drop a
    // concurrent settings edit (e.g. the db-export route) made while we awaited.
    await new Promise<void>((resolve) => {
      app.savePluginOptions({ ...currentSettings }, (err: NodeJS.ErrnoException | null) => {
        if (err) {
          app.debug(`Could not persist resolved image tag ${tag}: ${errMsg(err)}`)
        }
        resolve()
      })
    })
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
          finishExternal(gen, settings, external, url)
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

    // Resolved here, not in resolveTag: that hook is sync and this needs the network.
    if (settings.imageTag === 'auto') {
      // Plugins start alphabetically, so signalk-container is often not on globalThis yet.
      const { manager } = await waitForContainerManager({ timeoutMs: 30_000, signal })
      if (gen !== lifecycleGeneration) return
      const resolved = await resolveAutoTag({
        manager: manager ?? getContainerManager(),
        persisted: settings.resolvedImageTag,
        floor: BACKUP_SERVER_VERSION,
        debug: (msg) => {
          app.debug(msg)
        }
      })
      // Publish after the generation check: a superseded start must not clobber the live tag.
      if (gen !== lifecycleGeneration) return
      resolvedAutoTag = resolved
      await persistResolvedTag(resolved, gen)
    } else {
      resolvedAutoTag = null
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
    finishStartup(gen, settings, pending, address)
  }

  // Generation-guarded so a stop()/restart during a slow health probe can't resurrect stale timers or emitters.
  function finishStartup(
    gen: number,
    settings: Config,
    pending: BackupClient,
    address: string
  ): void {
    if (gen !== lifecycleGeneration) return
    client = pending
    app.setPluginStatus(`Backup engine ready at ${address}`)
    startSignalKEmitter(app, address, {
      emitSignalKDeltas: settings.emitSignalKDeltas
    })
    startDbExportTimer()
    scheduleServerUpdate(gen, SERVER_UPDATE_FIRST_CHECK_MS)
    uplinkReporter.start()
  }

  function finishExternal(gen: number, settings: Config, c: BackupClient, url: string): void {
    if (gen !== lifecycleGeneration) return
    // Deferred to here so ready cannot be true before the upstream answered.
    client = c
    app.setPluginStatus(`Connected to external backup-server at ${url}`)
    startSignalKEmitter(app, url, { emitSignalKDeltas: settings.emitSignalKDeltas })
    uplinkReporter.start()
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

  return plugin
}

const SAVE_FAILURE_REASONS: Readonly<Record<string, string>> = {
  ENOSPC: 'disk full',
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EROFS: 'read-only file system'
}

function saveFailureReason(err: NodeJS.ErrnoException): string | undefined {
  return err.code ? (SAVE_FAILURE_REASONS[err.code] ?? err.code) : undefined
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
