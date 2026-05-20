# signalk-backup

Scheduled deduplicated backups of your SignalK config (and optionally history) to local storage, USB / NAS, or Google Drive — with a tree-browser that lets you restore individual files from any snapshot, anywhere your user can write.

The plugin runs a React webapp inside the SignalK Admin UI and orchestrates a separate backup-engine container ([signalk-backup-server](https://github.com/dirkwa/signalk-backup-server)). All Kopia snapshot work happens in the container; the plugin handles the UI, the database-export tick, and host-side file writes for restores that target paths the container can't see.

## Features

- **Content-addressable deduplication** — Kopia stores file blobs once across all snapshots; identical config files between hourly/daily/weekly retention tiers cost nothing
- **Scheduled backups** — hourly / daily / weekly / on-startup tiers, each with independent retention
- **Cloud + local destinations** — Google Drive (rclone, `drive.file` scope, opt-in OAuth), USB / NAS via local-fs, or SMB share. Snapshots stay in the local Kopia repo even when cloud sync is configured
- **Selective restore** — browse any backup's file tree, download a single file or whole subdirectory, or restore in-place. The trailing slash on a custom path means "land inside as a directory", so `tmp/` plus a file source writes `tmp/<filename>` instead of overwriting `tmp` as a file
- **Restore-anywhere** — custom-path restores stream through the plugin and write under the SignalK user's permissions, so you can land restored bytes in `/tmp`, `/media/usb/...`, or your home directory — anywhere your user can write
- **Restore with safety backup** — every full restore creates a snapshot of the current state first; partial restores stash the existing target as a sibling before overwriting. Both flows can be rolled back automatically on failure
- **Database export pipeline** — opt-in exporters for [signalk-questdb](https://github.com/dirkwa/signalk-questdb), [signalk-grafana](https://github.com/dirkwa/signalk-grafana), and [signalk-database](https://github.com/dirkwa/signalk-database) periodically write consistent snapshots (parquet, SQLite checkpoint, provisioning YAML) to a staging dir that Kopia includes in every snapshot. Live DB files are excluded from filesystem backup to avoid torn-write hazards. The dedicated "Database exports" tab also extracts the export subtree from any historical backup without pulling the whole snapshot — a direct answer to "QuestDB shards bloat the full zip"
- **First-run safe default** — installs with a daily local-only schedule already seeded; no surprise data egress
- **Update detection** — checks ghcr.io for new container images via signalk-container's centralized update service

## Requirements

- SignalK Server ≥ 2.24.0
- Node 22 or newer (24 recommended)
- [signalk-container](https://github.com/dirkwa/signalk-container) ≥ 1.6.0 (provides the container runtime)
- Podman or Docker on the host

## Install

```bash
# Via the SignalK Admin UI: Server → Appstore → "signalk-backup"
# (auto-enables on install — first-run schedules a daily local backup)
```

The plugin pulls `ghcr.io/dirkwa/signalk-backup-server` at a server version it pins itself (see [src/config/image-tag.ts](src/config/image-tag.ts)). Plugin releases and server releases are decoupled — you can pin or float either independently via the plugin's `imageTag` setting.

## How it works

```text
Browser
  └── /signalk-backup/                                  ← plugin webapp (React)
       └── /plugins/signalk-backup/api/*                ← plugin's reverse proxy
            ├── /api/db-export/staging                  ← plugin-local (file lister)
            ├── /api/restore-partial-host               ← plugin-local (writes to host fs)
            └── /api/backups/*, /api/cloud/*, …         ← proxied to backup-server container
                 └── http://127.0.0.1:<port>/api/*
                      (Kopia snapshots, restore-with-rollback,
                       partial-restore state machine, cloud sync)
```

The plugin is most of the user experience:

- The **webapp** at `/signalk-backup/` is a React SPA bundled by Vite. It runs in the SignalK admin origin and reads/writes via `fetch('/plugins/signalk-backup/api/*')`. No CORS dance, no separate auth — it inherits SignalK's.
- The **plugin process** owns three things directly: the database-export scheduler tick, an HTTP route that lists / streams files from the staging tree (so the webapp can show "live" exports), and an HTTP route that performs host-side file writes for custom-path restores.
- Everything else — Kopia snapshots, restore-with-rollback, cloud sync, scheduling — runs in the [signalk-backup-server](https://github.com/dirkwa/signalk-backup-server) container. The plugin reverse-proxies `/api/*` through to it, and adds a small set of explicit overrides above the catch-all proxy.

The webapp has four tabs:

- **Dashboard** — status, recent backups, scheduler next-run times
- **Backups** — create, list, download, restore (full or selective), upload a ZIP, delete
- **Database exports** — live staging table (one row per exporter file currently on disk) plus a "pick a backup → browse the database-exports subtree" extractor for grabbing historical shards without pulling the whole snapshot
- **Cloud sync** — provider chooser (Google Drive / local / SMB), credentials, sync mode, on-demand sync

## Configuration

Most settings live in the **webapp** under Settings. The plugin's SignalK Admin UI config panel is intentionally small and handles only deployment-level options (the schema in [src/config/schema.ts](src/config/schema.ts) is the source of truth — update this list if you bump it):

- `managedContainer` — let the plugin manage the backup-server container (default), or point at an external instance
- `imageTag` — pin a specific version or use `auto` (default — resolves to the BACKUP_SERVER_VERSION constant)
- `externalUrl` — only used when `managedContainer: false`
- `databaseExport.{questdb, grafana, signalkDatabase}` — enable per-exporter (default off; users opt in once their DB plugin is producing data)
- `databaseExport.intervalMinutes` — how often the export tick runs (5–1440)

## License

Apache-2.0

## See also

- [signalk-backup-server](https://github.com/dirkwa/signalk-backup-server) — the container image
- [signalk-container](https://github.com/dirkwa/signalk-container) — runtime substrate
- [Kopia](https://kopia.io/) — backup engine
- [rclone](https://rclone.org/) — cloud transport
