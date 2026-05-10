# Agent guidance

This file is read by AI coding agents (Claude Code, Cursor, Codex, etc.) when working in this repo.

## Project at a glance

`signalk-backup` is a SignalK plugin that wraps a backup engine running in a separate container (`signalk-backup-server`, image `ghcr.io/dirkwa/signalk-backup-server`). Two modes:

- **Container mode** (default): the plugin asks [signalk-container](https://github.com/dirkwa/signalk-container) to ensure the backup-server container is running, then talks to it via HTTP.
- **External mode**: connects to a backup-server running elsewhere (host/port set in `externalUrl`).

The plugin is a thin shell. All backup logic — Kopia content-addressable snapshots, rclone Google Drive sync, scheduling, restore-with-rollback — lives inside the backup-server container.

## Commands

- `npm run format` — prettier + eslint --fix
- `npm run lint` — eslint check
- `npm run build` — tsc → `plugin/`, then `build.js` (redirect HTML), then webpack (config panel via Module Federation)
- `npm run test` — vitest
- `npm run build:all` — lint + build + test (run before every commit)

## Architecture

```
SignalK Server
  └── signalk-backup (this plugin)
       │   ├── exposes /plugins/signalk-backup/  (redirect HTML to container UI)
       │   ├── exposes /plugins/signalk-backup/api/gui-url  (proxies container's /api/gui-url)
       │   └── exposes /plugins/signalk-backup/status, /api/update/{check,apply}
       │
       └── signalk-container plugin manages →
            └── ghcr.io/dirkwa/signalk-backup-server (container)
                 ├── port 3010: Express + Vite UI
                 └── port 53682: rclone OAuth callback (only used during Drive setup)
```

The plugin discovers the container's actual `host:port` via `signalk-container.resolveContainerAddress()` and constructs an HTTP client (`BackupClient`) to talk to it. On first run, it seeds a default daily local backup schedule via `PUT /api/settings`.

## First-run behavior

- Plugin auto-enables (`signalk-plugin-enabled-by-default: true`)
- Plugin asks signalk-container to pull + start the backup-server container
- Once container is healthy (poll `/api/health` until 200), the plugin reads `/api/settings`
- If `scheduler.configured !== true`, plugin seeds a safe default: daily local-only backup at 03:00, retain 7. Cloud sync stays off until the user opts in via the Backup Console.
- Idempotent: re-runs detect existing config and don't overwrite.

## Plugin-specific gotchas

### Schema defaults are NOT injected at runtime

Signal K only uses the schema's `default` annotations to seed the JSON-schema form in the Admin UI. They are **not** materialised into the runtime config object passed to `plugin.start()`.

When the plugin is auto-enabled (`signalk-plugin-enabled-by-default: true`) or enabled without saving the form, `start()` is called with `{}`. Without merging defaults, `settings.managedContainer` is `undefined`, the container-startup branch is skipped, and the plugin sits with no error.

`src/config/schema.ts` exports `SCHEMA_DEFAULTS`; `start()` in `src/index.ts` spreads it under the incoming config. **Always preserve this merge** when modifying `start()`.

### Cross-plugin signalk-container API

The signalk-container plugin exposes its API on `globalThis.__signalk_containerManager`, not on the `app` object. Signal K passes each plugin a shallow copy of `app`, so properties added to it are not visible across plugins. `getContainerManager()` in `src/index.ts` is the typed accessor; always handle the `undefined` case.

### First-run schedule seeding is best-effort

If the container starts but `PUT /api/settings` fails (network blip, permission), the plugin logs and continues. The user can configure manually from the Backup Console. **Don't make plugin startup fail when seeding fails** — that would prevent the container from being usable at all.

### Container resource overrides

`src/index.ts` passes `DEFAULT_RESOURCES` to signalk-container's `ensureRunning`. Users can field-level-override any limit via signalk-container's plugin config (`containerOverrides["signalk-backup-server"]`). When changing defaults, also update the README table.

### OAuth port 53682

`rclone authorize drive` opens a callback listener on port 53682. We declare it in `signalkAccessiblePorts` so signalk-container exposes it back to the user's browser. The user's browser must reach this port during Drive setup. If port 53682 is already in use, signalk-container will pick the next free port — the backup-server's UI surfaces the actual auth URL.

## Dependencies

- Signal K Server ≥ 2.24.0
- signalk-container ≥ 0.1.6 (declared in `peerDependenciesMeta` as optional and in `signalk.requires`)
- Node ≥ 22

## Pull request workflow

One logical change per PR. Refactors, behavior changes, and dep bumps belong in separate PRs. The `chore(release): X.Y.Z` commit is its own PR. Branch names use hyphens, no slashes.

Commit messages: angular conventional commits (`feat`, `fix`, `chore`, `docs`, `ci`, `test`, `refactor`). Subject in imperative mood. No `Co-Authored-By` lines.

PR descriptions: `## Summary` (bullets, why-not-what) and `## Tested` (only what was actually verified). No speculative test plans, no checkbox lists.

## Build artifacts

`plugin/*.js` and `public/` are gitignored. `prepublishOnly` rebuilds before npm publish so the published tarball is always correct.
