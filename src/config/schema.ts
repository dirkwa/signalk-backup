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
      '"auto" (default) tracks the signalk-backup-server version this plugin release was tested against. ' +
      'Pin to a specific version (e.g. "0.4.0") or use a floating tag (e.g. "latest") to override.'
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
  externalUrl: '',
  emitSignalKDeltas: true,
  databaseExport: {
    questdb: false,
    grafana: false,
    signalkDatabase: false,
    intervalMinutes: 60
  }
}
