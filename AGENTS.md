# AGENTS.md

Notes for AI coding agents working on this repository. Human-facing usage and configuration UI screenshots live in [README.md](README.md); this file is the orientation an agent needs before making non-trivial changes.

## What this is

A Signal K server plugin that runs a separate backup-engine container ([`ghcr.io/dirkwa/signalk-backup-server`](https://github.com/dirkwa/signalk-backup-server)) and surfaces its functionality through a React webapp inside the SignalK admin origin. Heavy lifting (Kopia snapshots, rclone Drive sync, scheduling, restore-with-rollback) lives in the backup-server; the plugin owns the UI, the database-export tick, the staging-file routes, and the host-side writer for custom-path restores that target paths the container can't see.

Two operating modes:

- **Container mode** (default, `managedContainer: true`): the plugin asks `signalk-container` to ensure the backup-server container is running, then talks to it via HTTP.
- **External mode** (`managedContainer: false`, `externalUrl` set): the plugin connects to a backup-server running elsewhere and skips container management entirely.

## Architecture rules

- **Webapp is an embedded panel, not a standalone shell.** Keyword `signalk-embeddable-webapp`. Built as a Vite Module Federation remote exposing `./AppPanel` so the admin renders us inside its own layout with the sidebar still visible. React must be shared as a singleton with the admin (`import: false` on `react`/`react-dom`) — without it, two React instances coexist and hooks return null at first paint. `react/jsx-runtime` and `react/jsx-dev-runtime` must NOT use the same deferred-host pattern: the admin doesn't pre-register them in its share scope, so they're shared with a bundled fallback. See `vite.config.ts` for the exact share map. Two things keep that map honest, because the admin only provides `react` and `react-dom` and anything else the remote declares as host-provided kills the panel at load ("Shared module '…' must be provided by host", #94/#108): `scripts/check-federation-shares.mjs` fails `npm run build` if the emitted share map drifts, and `npm run test:e2e` mounts the built panel in a real signalk-server admin UI. Nothing in the federated build graph may import a sub-path of a shared package (e.g. `react-dom/client`) — @module-federation/vite registers such sub-paths as shared, inheriting `import: false`; that is why the dev shell is not the build input.
- **The panel must not write to `window.location.hash`.** The admin owns the hash for its own routing. Tab state in `webapp/src/App.tsx` is in-memory only.

## Companion plugins (hard runtime dependencies)

Listed in `package.json` under `signalk.requires`:

- **signalk-container** — provides the global `__signalk_containerManager` API used to pull the image, start/stop the container, resolve its host:port binding, and check for image updates. Container ops reach it through `signalk-container-helper`, never directly. Container mode refuses to start without it.
- **signalk-questdb** — soft dependency. Only needed when `databaseExport.questdb: true`; the plugin pulls QuestDB tables as Parquet via signalk-questdb's `/api/full-export` route. If the route is missing the plugin's `detect()` returns false and the export tick is a no-op.

**No `peerDependencies` block by design.** We declare the companion plugin in `signalk.requires` (the appstore-level signal) and check `globalThis.__signalk_containerManager` at runtime through `signalk-container-helper` — that's the source of truth. (The helper *is* a normal npm dependency; it is a standalone library that never imports signalk-container either.) An npm `peerDependencies` entry like `signalk-container: ">=1.6.0"` rejects every signalk-container pre-release because npm's semver only matches pre-release versions whose `[major,minor,patch]` tuple is explicitly named in the range. We've been there; don't add it back.

## File layout

- [src/index.ts](src/index.ts) — plugin entrypoint. Six responsibilities:
  1. `start(config)` — spread `SCHEMA_DEFAULTS` over the incoming `config`, kick off `asyncStart`. **Do not skip the spread**; Signal K does not seed schema defaults at runtime (see Gotchas).
  2. `asyncStart(config)` — branch on `managedContainer`. Container mode: `container.start(tag)` (a `ManagedContainer` from `signalk-container-helper`) brings the backup-server up and returns its address once `/api/health` answers, retrying forever via `readinessRetry`; then construct a `BackupClient` and seed the first-run schedule. External mode: skip the container entirely, build the `BackupClient` against `externalUrl`, and wrap it in the helper's `retryForever` with the same backoff.
  3. `registerWithRouter(router)` — registers in this order, then a catch-all `/api/*` proxy LAST. **Keep this list in sync with the code** when adding or removing routes; the canonical source is `registerWithRouter` in [src/index.ts](src/index.ts):
     - `/status` — container state + `pathMapping` for the UI's container→host path translation
     - `/api/update/check`, `/api/update/apply` — image-update flow
     - `/api/db-export/config` (GET/POST) — plugin owns the export timer
     - `/api/db-export/staging`, `/api/db-export/staging/download` — list / stream live staging files (see staging-routes.ts)
     - `/api/restore-partial-host*` — host-side custom-path restore (see restore-host-write.ts)
     - `/api/cloud/smb/discover` — multicast discovery runs here, not in the container
     - `/api/backups` (POST interceptor) — runs DB exports synchronously before forwarding to the proxy
     - The `/api/*` proxy catch-all (proxy.ts) — registered last so the explicit routes above match first
  4. **Database export scheduler** — `startDbExportTimer()` runs `setInterval(runDbExportTick, intervalMinutes * 60_000)` when any of the `databaseExport.*` toggles are true. Each tick calls `runAllExports({ signalkConfigRoot, signalkBaseUrl, enabled })` from `src/database-export/`; coalesces if the previous tick is still running.
  5. `pathMapping` — in managed-container mode the plugin bind-mounts the SignalK config root at `SK_MOUNT` (`/signalk-data`) inside the container. The plugin reports this mapping via `/status` so the webapp can translate server-reported paths (e.g. restore banner targets) back to the user-facing host equivalent.
  6. `stop()` — bump `lifecycleGeneration`, abort `startAbort` (before anything awaits, so a queued retry cannot restart what we are stopping), clear the export timer, then `container.stop()`, which unregisters the update tracker and stops — not removes — the container. `client = null` so health probes get a clean error rather than a stale URL.
- [src/proxy.ts](src/proxy.ts) — generic reverse-proxy middleware for the `/api/*` catch-all. Streams both directions via `Readable.fromWeb` + `pipeline` so multi-GB ZIP downloads/uploads don't buffer in memory.
- [src/restore-host-write.ts](src/restore-host-write.ts) — host-side custom-path restore. Streams from the backup-server's `/api/backups/:id/download-subtree` and writes locally under the SignalK process's permissions. Single-file sources land as raw bytes; directory sources extract the server's ZIP via `unzipper.Parse` with per-entry path-traversal validation (`resolveZipEntryPath` rejects any entry containing `..`). State machine: `idle → preparing → streaming → extracting → completed | failed → rolling_back → rolled_back`. Sibling-rename safety stash on overwrite (matches restore-partial-service in signalk-backup-server). Single-flight slot reserved synchronously before the first await to close a TOCTOU between two concurrent POSTs.
- [src/database-export/index.ts](src/database-export/index.ts) — orchestrator. Iterates through registered exporters, calls `detect()` to skip the disabled/uninstalled ones, runs `exportAll()` per-exporter, writes results into `<configRoot>/plugin-config-data/signalk-backup/database-exports/<pluginId>/`. Errors in one exporter never abort the others.
- [src/database-export/questdb.ts](src/database-export/questdb.ts), [grafana.ts](src/database-export/grafana.ts), [signalk-database.ts](src/database-export/signalk-database.ts) — per-source exporters. All pull data via the source plugin's HTTP route, stream to a `.partial` file, atomic-rename. No cross-container exec, no shared filesystem.
- [src/database-export/staging-routes.ts](src/database-export/staging-routes.ts) — `GET /api/db-export/staging` lists files under the staging root; `GET .../download?file=...` streams one. Path is realpath-resolved against the staging root (passed in from index.ts as `<getDataDirPath()>/database-exports`); rejects `..` segments and symlink-escapes. The recursive walker uses `lstat` to skip symlink entries so a malicious link inside the tree can't leak external bytes.
- [src/signalk-deltas.ts](src/signalk-deltas.ts) — SSE subscriber to backup-server's `/api/backups/events/stream` and translator to SignalK deltas + v1 notifications. One module-local mutable `DeltaEmitterState` (gates re-entry; tests use `__test_only__.bootstrap` to skip the SSE loop and drive `handleEvent` directly). Reconnect backoff is 1s → 30s. `storageLow` uses a hysteresis band so a marginal disk doesn't flap — the actual thresholds live in `STORAGE_LOW_*` constants in this file and are user-documented in README's "SignalK paths published" section. Started from `asyncStart()` after `waitForReady` in both managed and external modes; stopped from plugin `stop()`. Adding a new published path means a new `meta` row in `metaSeed()` plus a `values` row in `emitMetrics()`. The event shape that arrives over SSE must stay in sync with `BackupCompletedEvent` in signalk-backup-server's `src/schemas/events.ts`.
- [src/backup-client.ts](src/backup-client.ts) — typed HTTP client for the backup-server's REST API. Used at startup for `waitForReady` and `seedFirstRunSchedule`; everything the webapp uses goes through the `/api/*` proxy, so this wraps only the methods the plugin's own startup logic calls.
- [src/config/schema.ts](src/config/schema.ts) — typebox schema → Signal K admin UI form. Adding a config field starts here; **also** add it to `SCHEMA_DEFAULTS` (see Gotchas).
- [src/config/image-tag.ts](src/config/image-tag.ts) — `imageTag: "auto"` resolves to the newest published signalk-backup-server release, with `BACKUP_SERVER_VERSION` as the offline floor. Plugin and server versions stay decoupled. The lookup itself lives in [src/config/resolve-auto-tag.ts](src/config/resolve-auto-tag.ts).
- [src/types.ts](src/types.ts) — re-exports signalk-container's API types from `signalk-container-helper`, plus the local `BackupServerAPI` alias. The helper's copy is pinned against the real thing by a build-time contract test, which a local mirror is not. Loose coupling is unchanged: this plugin never imports signalk-container itself, only its types, and reaches the API at runtime via `globalThis`.
- [webapp/](webapp/) — React 19 + Vite + reactstrap. Module Federation remote (see [webapp/src/AppPanel.tsx](webapp/src/AppPanel.tsx)) embedded in the SignalK admin shell — see Architecture rules above. Tabs: Dashboard, Backups, Database exports, Cloud sync, Settings. All HTTP via `/plugins/signalk-backup/api/*` (same SignalK origin). `webapp/src/api.ts` is the typed client; `webapp/src/components/` holds the shared widgets (`BackupBrowser`, `PartialRestoreModal`, `PartialRestoreBanner`); each top-level tab is a file under `webapp/src/views/`. `webapp/dev.html` and `webapp/src/main.tsx` are the `npm run dev` shell only (plain Vite, no federation, React from node_modules); they are not part of the built remote. `webapp/public/index.html` is a static redirect to the embedded view, so `/signalk-backup/` never serves the remote outside a host.
- [test/](test/) — vitest. Pure unit tests: schema validation, exporter behaviour against a mocked `fetch`, staging-route path-safety against a temp dir + supertest, host-restore path resolution and ZIP-entry safety. [test/e2e/](test/e2e/) is the end-to-end harness (`npm run test:e2e`, after `npm run build`): it installs `signalk-server` on demand into `.e2e-cache/`, starts it on a free port with this checkout symlinked in as the plugin, and drives the admin UI with headless Chromium (playwright) to assert the federated panel mounts, switches tabs and logs no federation errors. It is not part of `npm test`; CI runs it as its own job.

## Build, lint, test

```bash
npm run format     # prettier + eslint --fix
npm run lint       # eslint check (no auto-fix)
npm run build      # tsc → plugin/, typecheck webapp, vite → public/ (+ share-map guard)
npm run build:all  # lint + build + test
npm test           # vitest (unit)
npm run test:e2e   # real signalk-server + headless Chromium against public/ (needs `npx playwright install chromium` once)
```

The `plugin/` and `public/` directories are gitignored build output. `prepublishOnly` rebuilds before npm publish.

## Local dev loop

The plugin runs inside whichever Signal K server has `signalk-backup` in its `node_modules`. The fastest iteration:

1. `npm run build` — tsc writes `plugin/`, vite writes `public/`.
2. Restart the SignalK process. Toggling the plugin from the admin UI does **not** re-`require()` the module — Node's `require.cache` keeps the old code (this caught us during v0.2 development).
3. Hard-reload the admin UI in the browser (Ctrl-Shift-R) so the new webapp bundle loads, not the cached one. Without this you see stale UI even after a successful plugin reload.
4. `curl http://127.0.0.1:<sk-port>/plugins/signalk-backup/status | jq .` to confirm the new code is live — `pathMapping` should be present in managed-container mode.
5. Webapp at `http://<sk-host>/admin/#/e/signalk_backup` (`/signalk-backup/` redirects there). API surface at `/plugins/signalk-backup/api/*`.

To exercise the database-export path against live data without waiting for the timer, you can call `runAllExports` from a Node REPL pointed at the built `plugin/database-export/index.js`.

## Debugging recipes

Find what container the plugin actually managed:

```bash
podman ps --filter name=sk-signalk-backup-server
podman logs sk-signalk-backup-server | tail -50
```

Confirm the resolved address the proxy is using:

```bash
curl http://127.0.0.1:<sk-port>/plugins/signalk-backup/status | jq .
# .container.state, .ready, .guiUrl
```

Watch the database-export staging dir grow on a timer tick:

```bash
ls -la ~/.signalk/plugin-config-data/signalk-backup/database-exports/signalk-questdb/
```

Hit the QuestDB exporter route directly to confirm signalk-questdb is reachable:

```bash
curl http://127.0.0.1:<sk-port>/plugins/signalk-questdb/api/full-export/tables
```

## Gotchas

- **Schema defaults are NOT injected at runtime.** Signal K only uses the schema's `default` annotations to seed the JSON-schema form in the Admin UI — they're not materialised into the runtime config object passed to `plugin.start()`. When the plugin is auto-enabled (`signalk-plugin-enabled-by-default: true`) or enabled without saving the form, `start()` is called with `{}`. `src/config/schema.ts` exports `SCHEMA_DEFAULTS`; `start()` in `src/index.ts` spreads it under the incoming config. **Always preserve this merge** — without it, `settings.managedContainer` is `undefined`, the container-startup branch is skipped, and the plugin sits with no error.
- **`imageTag: "auto"` resolves dynamically, and must always resolve to concrete semver.** [src/config/resolve-auto-tag.ts](src/config/resolve-auto-tag.ts) picks, in order: the persisted `resolvedImageTag` (no network — this is why repeat boots reuse one image and never recreate the container), the newest published GitHub release of signalk-backup-server, then the `BACKUP_SERVER_VERSION` floor. The lookup is bounded (5s) and never throws, because boats boot without an uplink. **Never let `"latest"` or any floating tag through to the container**: signalk-container's `classifyTag` would stop comparing versions and switch to digest-drift detection, which calls `pullImage()` on *every* update check (expensive on a metered link) and replaces real version numbers in the UI with "latest". `BACKUP_SERVER_VERSION` is still worth bumping when a server release lands — it is the floor that offline and first-boot installs get, and raising it pulls boats forward off older pins.
- **Still don't couple the server version to the plugin's `package.json` version.** Tracking the *server's* latest release (above) is a different thing and is intended. Coupling to the *plugin's* own version forced phantom server releases whenever the plugin shipped pure plugin-side work, and broke users with `manifest unknown` when the assumption was violated. Don't restore that.
- **Readiness retries forever, by design.** `readinessRetry` on the `ManagedContainer` (and `retryForever` on the external-mode branch) backs off from `READY_RETRY_MIN_MS` to `READY_RETRY_MAX_MS` and never gives up. A transient boot race must not wedge the plugin until a human restarts it — on a boat that can be weeks later. Don't "fix" it into a bounded retry that reports failure and stops.
- **Two lifecycle guards, deliberately.** The helper's per-instance serialization and `AbortSignal` cover container operations only. `lifecycleGeneration` still guards what the helper knows nothing about: the SignalK delta emitter, the db-export timer, and the whole external-server branch. `stop()` aborts `startAbort` *before* awaiting `container.stop()`, or a queued retry attempt could restart what we just stopped.
- **The signalk-container API lives on `globalThis`, not `app`.** Signal K passes each plugin a shallow copy of `app`, so properties added to it are not visible across plugins. Use `getContainerManager()` from `signalk-container-helper` and always handle the `undefined` case — on a cold start signalk-container loads after us (alphabetical order) and the API is missing for the first few hundred ms. `ManagedContainer.start()` waits for both the global and its runtime detection, bounded by the `managerTimeoutMs` we pass.
- **`resolveContainerAddress` can return a stale port.** signalk-container caches port allocations process-locally, and that cache can drift from the live podman binding (TOCTOU between port probe and `podman create`). The fallback that parses `listContainers()` port bindings now lives in `signalk-container-helper`'s `ManagedContainer.resolveAddress` — its source comments credit this plugin for the bug. **Don't simplify it back to a single `resolveContainerAddress` call upstream** — we hit this in production.
- **First-run seed failures must not fail startup.** `seedFirstRunSchedule` calls `PUT /api/settings`. If the backup-server is up but the PUT fails (network blip, version mismatch), log and continue — the user can configure manually from the Backup Console. A fatal error here would make the container appear broken when only the seeding step had a problem.
- **Plugin reload doesn't re-require code.** The Signal K admin's plugin disable/enable toggle saves config and calls `stop()`/`start()`, but it does not bust Node's `require.cache`. To pick up source changes you must restart the Signal K _process_. Symptom: edits to `src/index.ts` are invisible to `curl /plugins/.../status`.
- **Route registration order matters in `index.ts`.** The `/api/*` proxy catch-all (proxy.ts) is registered LAST. Any plugin-local route must register before it or Express will forward the request upstream. The full registration order is in `registerWithRouter`'s comments. Symptom of a mis-registered route: 404 HTML from Express on a URL the backup-server doesn't know about (e.g. `Cannot POST /api/restore-partial-host`).
- **Express 5 made `req.query` a getter-only property.** Plain assignment after TypeBox defaulting throws. The plugin doesn't run TypeBox validation today, but if you add `query:` validation to a route, use `Object.defineProperty` to write the defaulted value back — the backup-server's `validate` middleware shows the pattern.
- **OAuth port 53682 is the rclone callback.** `rclone authorize drive` opens a browser-side callback listener on 53682. We declare it in `signalkAccessiblePorts` so signalk-container exposes it back to the user's browser. The user's browser must reach this port during Drive setup; if 53682 is in use, signalk-container picks the next free port and the backup-server's UI surfaces the actual auth URL.
- **Database-export staging lives inside the kopia snapshot tree.** Parquet files land at `<configRoot>/plugin-config-data/signalk-backup/database-exports/<pluginId>/<table>.parquet`. The backup-server's `ALWAYS_EXCLUDED` list is carefully crafted to keep this path snapshottable while still excluding `kopia-repo/`, `kopia-config*`, `settings.json`, etc. If you change either side, **verify the matching change on the other**: the v0.2 design depends on this asymmetry.
- **External mode disables database export.** No container manager → no execInContainer (we used to need that), but more importantly: external-mode is for users running backup-server elsewhere where this plugin has no access to their database containers. We log "skipped" rather than failing.
- **Host-restore writes happen as the SignalK user.** Custom-path partial restores in `restore-host-write.ts` deliberately bypass the container so the user can target paths the container can't see (`/tmp`, `/media/usb/...`). The path-safety layer is intentionally thin — we trust the SignalK process's own filesystem permissions. Do NOT add a "must resolve under signalkDataPath" guard here; that's what the in-container `restore-partial` route is for.
- **Trailing slash on `customPath` is a directory marker.** `tmp/` plus a single-file source lands at `tmp/<basename>`, not as a file literally named `tmp`. The server's `resolvePartialTarget` and the plugin's `resolveHostTarget` both implement the same rule; if you change one, change the other.
- **`HostRestoreStatus.targetPath` is already a host path.** The host-restore writer stores the final on-disk path. The `PartialRestoreBanner` takes a `mapTargetPath` prop (default `true`) — set it `false` when rendering host-restore status so the path isn't re-mapped through `toHostPath` (which would mis-rewrite a chosen path that happens to share the container prefix).
- **`pathMapping` is only present in managed-container mode.** External mode omits it because the plugin can't know the remote host's path layout. The webapp's `toHostPath` returns the input unchanged when no mapping is supplied — don't add a fallback that guesses.

## Conventions

- **No comments restating what the code does.** Code-level comments should explain the _why_ of something non-obvious (e.g. "resolveContainerAddress can return stale ports"), not narrate the diff.
- **Angular conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `test:`, `refactor:`). Subject in imperative mood. **No `Co-Authored-By` lines.**
- **Branch names use hyphens, not slashes.** Signal K maintainers' convention.
- **TypeScript is strict.** Don't add `as any` to silence errors — fix the type.
- **One logical change per PR.** Refactors, behavior changes, dep bumps belong in separate PRs. The `chore(release): X.Y.Z` commit is its own PR.
- **PR descriptions:** `## Summary` (bullets, why-not-what) and `## Tested` (only what was actually verified — no speculative test plans, no checkbox lists).
- **Don't write multi-line comment blocks or docstrings.** A short single-line comment for a non-obvious WHY is fine; everything else is noise.
