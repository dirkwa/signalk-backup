# AGENTS.md

Notes for AI coding agents working on this repository. Human-facing usage and configuration UI screenshots live in [README.md](README.md); this file is the orientation an agent needs before making non-trivial changes.

## What this is

A Signal K server plugin that runs a separate backup-engine container ([`ghcr.io/dirkwa/signalk-backup-server`](https://github.com/dirkwa/signalk-backup-server)) and surfaces its UI through Signal K's admin origin. The plugin itself does almost nothing — Kopia snapshots, rclone Drive sync, scheduling, restore-with-rollback all live in the backup-server. This repo is the SignalK-side glue.

Two operating modes:

- **Container mode** (default, `managedContainer: true`): the plugin asks `signalk-container` to ensure the backup-server container is running, then talks to it via HTTP.
- **External mode** (`managedContainer: false`, `externalUrl` set): the plugin connects to a backup-server running elsewhere and skips container management entirely.

## Companion plugins (hard runtime dependencies)

Listed in `package.json` under `signalk.requires`:

- **signalk-container** — provides the global `__signalk_containerManager` API used to pull the image, start/stop the container, resolve its host:port binding, and check for image updates. All container ops in [src/index.ts](src/index.ts) go through it. Container mode refuses to start without it.
- **signalk-questdb** — soft dependency. Only needed when `databaseExport.questdb: true`; the plugin pulls QuestDB tables as Parquet via signalk-questdb's `/api/full-export` route. If the route is missing the plugin's `detect()` returns false and the export tick is a no-op.

## File layout

- [src/index.ts](src/index.ts) — plugin entrypoint. Five responsibilities:
  1. `start(config)` — spread `SCHEMA_DEFAULTS` over the incoming `config`, kick off `asyncStart`. **Do not skip the spread**; Signal K does not seed schema defaults at runtime (see Gotchas).
  2. `asyncStart(config)` — branch on `managedContainer`. Container mode: poll `globalThis.__signalk_containerManager` (signalk-container loads after us alphabetically), `ensureRunning` the backup-server image, resolve its actual host:port via `resolveActualAddress`, construct a `BackupClient`, wait for `/api/health`, seed the first-run schedule. External mode: skip the container, build the `BackupClient` against `externalUrl`.
  3. `registerWithRouter(router)` — `/console/*` reverse-proxies the backup-server UI through SignalK's origin (so the user's browser doesn't need direct access to the loopback-bound container port). `/api/gui-url` returns the proxy path. `/status`, `/api/update/check`, `/api/update/apply` surface container state and image-update flow.
  4. **Database export scheduler** — `startDbExportTimer()` runs `setInterval(runDbExportTick, intervalMinutes * 60_000)` when `databaseExport.questdb: true`. Each tick calls `runAllExports({ signalkConfigRoot, signalkBaseUrl })` from `src/database-export/`; coalesces if the previous tick is still running.
  5. `stop()` — clear the export timer, unregister update tracker, `containers.stop(CONTAINER_NAME)`. `client = null` so health probes get a clean error rather than a stale URL.
- [src/database-export/index.ts](src/database-export/index.ts) — orchestrator. Iterates through registered exporters, calls `detect()` to skip the disabled/uninstalled ones, runs `exportAll()` per-exporter, writes results into `<configRoot>/plugin-config-data/signalk-backup/database-exports/<pluginId>/`. Errors in one exporter never abort the others.
- [src/database-export/questdb.ts](src/database-export/questdb.ts) — QuestDB exporter. Pulls every table as Parquet via signalk-questdb's HTTP route, streams to a `.partial` file, then atomic-renames into place so kopia never sees a torn write. **No** cross-container exec, **no** filesystem hand-off — pure HTTP over loopback.
- [src/backup-client.ts](src/backup-client.ts) — typed HTTP client for the backup-server's REST API. Used at startup for `waitForReady` and `seedFirstRunSchedule`; the rest of the API is exercised from the backup-server's own UI, so we only wrap the methods the plugin actually calls.
- [src/console-proxy.ts](src/console-proxy.ts) — Express middleware that reverse-proxies `/plugins/signalk-backup/console/*` to the backup-server's UI. Reads the resolved address via a getter so it stays correct when the container restarts.
- [src/config/schema.ts](src/config/schema.ts) — typebox schema → Signal K admin UI form. Adding a config field starts here; **also** add it to `SCHEMA_DEFAULTS` (see Gotchas).
- [src/configpanel/PluginConfigurationPanel.tsx](src/configpanel/PluginConfigurationPanel.tsx) — React (19) panel rendered inside Signal K admin. TypeScript; bundled by webpack via Module Federation so React is shared with the host.
- [src/types.ts](src/types.ts) — hand-rolled mirror of signalk-container's API. Loose coupling: this plugin never imports signalk-container at compile time, only at runtime via `globalThis`.
- [test/](test/) — vitest. Pure unit tests: schema validation, exporter behaviour against a mocked `fetch`. There is no integration harness; manual verification is via the live SignalK server (see "Local dev loop").

## Build, lint, test

```bash
npm run format     # prettier + eslint --fix
npm run lint       # eslint check (no auto-fix)
npm run build      # tsc → plugin/, then build.js (redirect HTML), then webpack (config panel)
npm run build:all  # lint + build + test
npm test           # vitest
```

The `plugin/` and `public/` directories are gitignored build output. `prepublishOnly` rebuilds before npm publish.

## Local dev loop

The plugin runs inside whichever Signal K server has `signalk-backup` in its `node_modules`. The fastest iteration:

1. `npm run build:all` — tsc writes `plugin/`, webpack writes `public/`, vitest runs.
2. Restart the SignalK process. Toggling the plugin from the admin UI does **not** re-`require()` the module — Node's `require.cache` keeps the old code (this caught us during v0.2 development).
3. `curl http://127.0.0.1:<sk-port>/plugins/signalk-backup/status` to confirm the new code is live.
4. The backup-server UI is at `http://<sk-host>/plugins/signalk-backup/console/` once the container is up.

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
- **The signalk-container API lives on `globalThis`, not `app`.** Signal K passes each plugin a shallow copy of `app`, so properties added to it are not visible across plugins. Use `getContainerManager()` in `src/index.ts` and always handle the `undefined` case — on a cold start signalk-container loads after us (alphabetical order) and the API is missing for the first few hundred ms. `waitForContainerManager` polls for up to 120s.
- **`resolveContainerAddress` can return a stale port.** signalk-container caches port allocations process-locally, and that cache can drift from the live podman binding (TOCTOU between port probe and `podman create`). [src/index.ts](src/index.ts)'s `resolveActualAddress` queries `listContainers()` and parses the live `Ports` field for an authoritative answer; falls back to the documented API. **Don't simplify back to a single `resolveContainerAddress` call** — we hit this in production.
- **First-run seed failures must not fail startup.** `seedFirstRunSchedule` calls `PUT /api/settings`. If the backup-server is up but the PUT fails (network blip, version mismatch), log and continue — the user can configure manually from the Backup Console. A fatal error here would make the container appear broken when only the seeding step had a problem.
- **Plugin reload doesn't re-require code.** The Signal K admin's plugin disable/enable toggle saves config and calls `stop()`/`start()`, but it does not bust Node's `require.cache`. To pick up source changes you must restart the Signal K _process_. Symptom: edits to `src/index.ts` are invisible to `curl /plugins/.../status`.
- **The backup-server's reverse proxy must rewrite the prefix.** `console-proxy.ts` strips `/plugins/signalk-backup/console` before forwarding. The backup-server's UI is built with `base: '/'`, so any rewrite asymmetry breaks asset loading silently (the browser sees 404s on JS chunks, the page is blank). Keep the prefix handling consistent if you touch this code.
- **OAuth port 53682 is the rclone callback.** `rclone authorize drive` opens a browser-side callback listener on 53682. We declare it in `signalkAccessiblePorts` so signalk-container exposes it back to the user's browser. The user's browser must reach this port during Drive setup; if 53682 is in use, signalk-container picks the next free port and the backup-server's UI surfaces the actual auth URL.
- **Database-export staging lives inside the kopia snapshot tree.** Parquet files land at `<configRoot>/plugin-config-data/signalk-backup/database-exports/<pluginId>/<table>.parquet`. The backup-server's `ALWAYS_EXCLUDED` list is carefully crafted to keep this path snapshottable while still excluding `kopia-repo/`, `kopia-config*`, `settings.json`, etc. If you change either side, **verify the matching change on the other**: the v0.2 design depends on this asymmetry.
- **External mode disables database export.** No container manager → no execInContainer (we used to need that), but more importantly: external-mode is for users running backup-server elsewhere where this plugin has no access to their database containers. We log "skipped" rather than failing.

## Conventions

- **No comments restating what the code does.** Code-level comments should explain the _why_ of something non-obvious (e.g. "resolveContainerAddress can return stale ports"), not narrate the diff.
- **Angular conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `test:`, `refactor:`). Subject in imperative mood. **No `Co-Authored-By` lines.**
- **Branch names use hyphens, not slashes.** Signal K maintainers' convention.
- **TypeScript is strict.** Don't add `as any` to silence errors — fix the type.
- **One logical change per PR.** Refactors, behavior changes, dep bumps belong in separate PRs. The `chore(release): X.Y.Z` commit is its own PR.
- **PR descriptions:** `## Summary` (bullets, why-not-what) and `## Tested` (only what was actually verified — no speculative test plans, no checkbox lists).
- **Don't write multi-line comment blocks or docstrings.** A short single-line comment for a non-obvious WHY is fine; everything else is noise.
