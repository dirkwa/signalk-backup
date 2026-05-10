# signalk-backup

Scheduled deduplicated backups of your SignalK config (and optionally history) to local storage and Google Drive.

The plugin is a thin shell: it asks [signalk-container](https://github.com/dirkwa/signalk-container) to run the backup engine in a container ([signalk-backup-server](https://github.com/dirkwa/signalk-backup-server)) and presents a redirect to the engine's UI as a SignalK webapp. All backup work — Kopia snapshots, rclone Google Drive sync, scheduling, restore-with-rollback — happens inside the container.

## Features

- **Content-addressable deduplication** — Kopia stores file blobs once across all snapshots; identical config files between hourly/daily/weekly retention tiers cost nothing
- **Cloud sync to Google Drive** — optional, opt-in. Uses rclone with `drive.file` scope (the app only sees files it created)
- **Scheduled backups** — hourly / daily / weekly / on-startup tiers, each with independent retention
- **Restore with safety backup** — every restore creates a snapshot of the current state first, so a botched restore can be rolled back automatically
- **First-run safe default** — installs with a daily local-only schedule already seeded; no surprise data egress
- **Update detection** — checks ghcr.io for new container images via signalk-container's centralized update service

## Requirements

- SignalK Server ≥ 2.24.0
- Node 22 or newer (24 recommended)
- [signalk-container](https://github.com/dirkwa/signalk-container) ≥ 0.1.6 (provides the container runtime)
- Podman or Docker on the host

## Install

```bash
# Via the SignalK Admin UI: Server → Appstore → "signalk-backup"
# (auto-enables on install — first-run schedules a daily local backup)
```

The plugin pulls `ghcr.io/dirkwa/signalk-backup-server:latest` on first run. The container is small (~80 MB compressed). Subsequent updates are detected and surfaced in the signalk-container config panel.

## How it works

```
Your browser
  └── /plugins/signalk-backup/                 ← redirect HTML
       └── plugin proxies /api/gui-url
            └── backup-server container UI
                 (snapshots, restore wizard, cloud sync, settings)
```

When you visit `/plugins/signalk-backup/` in the SignalK Admin UI, the plugin's redirect HTML asks `/plugins/signalk-backup/api/gui-url` for the current backup-server location and bounces your browser there. This means the UI version is always in sync with the running container.

## Configuration

Most configuration lives in the **Backup Console** (open it from the redirect, or from the SignalK Admin UI plugin config: "Open Backup Console"). The Console handles:

- Backup schedule (hourly / daily / weekly / startup) and retention tiers
- Backup excludes (paths to skip — default: `node_modules/`, `charts*/`)
- Repository password (Kopia encryption key)
- Cloud sync mode (off / manual / daily / weekly)
- Google Drive connection (one-click OAuth via `rclone authorize drive`)
- Snapshot browser, restore wizard

The SignalK Admin UI plugin panel (small) handles only deployment-level settings:

- `managedContainer` — whether to manage the container yourself or point at an external backup-server
- `imageTag` — pin a specific version or use a floating tag like `latest`
- `externalUrl` — only used when `managedContainer: false`
- `logLevel` — forwarded to the container

## License

Apache-2.0

## See also

- [signalk-backup-server](https://github.com/dirkwa/signalk-backup-server) — the container image
- [signalk-container](https://github.com/dirkwa/signalk-container) — runtime substrate
- [Kopia](https://kopia.io/) — backup engine
- [rclone](https://rclone.org/) — cloud transport
