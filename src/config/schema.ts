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
    default: 'latest',
    title: 'Container image tag',
    description:
      '"latest" (default) always runs the newest published signalk-backup-server image. ' +
      'Because it is a floating tag, the container manager detects updates by comparing image ' +
      'digests, which downloads the image on each check and reports "image rebuild available" ' +
      'rather than a version number. Pin a specific version (e.g. "1.0.0") for version-to-version ' +
      'update notices and no background downloads, or "auto" to track the newest release as a ' +
      'concrete version.'
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
  imageTag: 'latest',
  resolvedImageTag: '',
  externalUrl: '',
  emitSignalKDeltas: true,
  databaseExport: {
    questdb: false,
    grafana: false,
    signalkDatabase: false,
    intervalMinutes: 60
  }
}
