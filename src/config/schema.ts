import { Type, Static } from '@sinclair/typebox'

// databaseExport.* deliberately omitted — webapp Settings owns that UI; RJSF leaks required-int chrome.
export const ConfigSchema = Type.Object({
  managedContainer: Type.Boolean({
    default: true,
    title: 'Manage backup container via signalk-container',
    description:
      'When enabled (default), the plugin pulls and runs ghcr.io/dirkwa/signalk-backup-server. ' +
      'Disable to point at an external backup-server instance via "External URL".'
  }),
  imageTag: Type.String({
    default: 'auto',
    title: 'Container image tag',
    description:
      '"auto" (default) runs a concrete server version, so update notices read "1.0.0 → 1.0.1". ' +
      'It starts on the version it last resolved, so boots need no network, and moves to a new ' +
      'release on its own when "Update the backup server automatically" is on, or when you ' +
      'take the update. Pin a specific version (e.g. "1.0.1") to stay on it. "latest" also runs the ' +
      'newest image, but as a floating tag it is checked by downloading it — about 400MB per ' +
      'check, which matters on a metered link — and reports "image rebuild available" rather ' +
      'than a version.'
  }),
  resolvedImageTag: Type.String({
    default: '',
    // RJSF renders `readOnly` as a disabled input: the plugin overwrites this
    // field on every start, so an edit here would silently vanish.
    readOnly: true,
    title: 'Resolved image version',
    description:
      'Managed by the plugin: the concrete version "auto" resolved to. Set imageTag to something ' +
      'other than "auto" to pin a version; this field is not used then.'
  }),
  autoUpdateServer: Type.Boolean({
    default: true,
    title: 'Update the backup server automatically',
    description:
      'With image tag "auto", install new backup server releases of the same major version ' +
      'without asking: the plugin checks every 6 hours, downloads the new image (about 430MB) ' +
      'while the running server keeps working, and switches once no restore is running. If the ' +
      'new version does not start, it goes back to the previous one. While signalk-internet ' +
      'reports a metered, captive or offline link, the check waits; "Apply update" in the ' +
      'Backup app always runs.'
  }),
  externalUrl: Type.String({
    default: '',
    title: 'External backup-server URL',
    description:
      'Used only when managedContainer is disabled. e.g. http://192.168.1.50:3010. ' +
      'Leave blank when managing the container.'
  }),
  emitSignalKDeltas: Type.Boolean({
    default: true,
    title: 'Publish backup health to SignalK delta stream',
    description:
      'When enabled (default), the plugin publishes server.backup.* metrics and ' +
      'notifications.server.backup.* alarms on each scheduled backup run. ' +
      'Disable if you do not want these paths in your delta stream.'
  })
})

// Off-schema but persisted at runtime; SignalK's options store round-trips arbitrary keys.
export interface DatabaseExportConfig {
  questdb: boolean
  grafana: boolean
  signalkDatabase: boolean
  intervalMinutes: number
}

export type Config = Static<typeof ConfigSchema> & {
  databaseExport: DatabaseExportConfig
}

// SignalK uses schema `default` only to seed the form, not the runtime config — spread these in start(). See AGENTS.md gotchas.
export const SCHEMA_DEFAULTS: Config = {
  managedContainer: true,
  imageTag: 'auto',
  resolvedImageTag: '',
  autoUpdateServer: true,
  externalUrl: '',
  emitSignalKDeltas: true,
  databaseExport: {
    questdb: false,
    grafana: false,
    signalkDatabase: false,
    intervalMinutes: 60
  }
}
