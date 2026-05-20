import { Type, Static } from '@sinclair/typebox'

// Schema for the SignalK Admin UI plugin config form — deployment
// knobs only. databaseExport.* is intentionally NOT in here: the
// webapp's Settings tab owns that UI, and RJSF can't reliably hide a
// required-int field even with ui:widget='hidden' (validation chrome
// leaks). savePluginOptions still round-trips the persisted value
// because SignalK's options store accepts any JSON, not just
// schema-described keys.
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
  })
})

// databaseExport lives off-schema (see ConfigSchema comment). Still
// part of the persisted Config at runtime — Signal K's options store
// round-trips arbitrary keys, the schema just drives the form.
export interface DatabaseExportConfig {
  questdb: boolean
  grafana: boolean
  signalkDatabase: boolean
  intervalMinutes: number
}

export type Config = Static<typeof ConfigSchema> & {
  databaseExport: DatabaseExportConfig
}

// Materialised defaults — Signal K only uses the schema's `default` fields
// to seed the Admin UI form, NOT to inject defaults into the runtime config
// object passed to plugin.start(). Spread SCHEMA_DEFAULTS in start() so
// every field is present even when start() is called with `{}`.
// See AGENTS.md §"Plugin-specific gotchas".
export const SCHEMA_DEFAULTS: Config = {
  managedContainer: true,
  imageTag: 'auto',
  externalUrl: '',
  databaseExport: {
    questdb: false,
    grafana: false,
    signalkDatabase: false,
    intervalMinutes: 60
  }
}
