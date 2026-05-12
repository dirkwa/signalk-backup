import { Type, Static } from '@sinclair/typebox'

/**
 * Schema for the SignalK Admin UI plugin config form. Only the
 * per-deployment knobs the SignalK admin needs to set up — backup
 * schedule, retention, cloud sync, exclusions, password, database
 * export are all in the webapp's Settings view at /signalk-backup/.
 *
 * For LOG_LEVEL: defaults to "info"; power users can override via
 * signalk-container's per-container env override
 * (containerOverrides.signalk-backup-server.env.LOG_LEVEL).
 */
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
    description: 'Pin to a specific version (e.g. "0.1.0") or use a floating tag (e.g. "latest").'
  }),
  externalUrl: Type.String({
    default: '',
    title: 'External backup-server URL',
    description:
      'Used only when managedContainer is disabled. e.g. http://192.168.1.50:3010. ' +
      'Leave blank when managing the container.'
  }),
  // Must exist in the schema so savePluginOptions round-trips it; the
  // form hides it via uiSchema in src/index.ts (webapp owns the UI).
  databaseExport: Type.Object(
    {
      questdb: Type.Boolean({ default: false }),
      intervalMinutes: Type.Number({ default: 60, minimum: 5, maximum: 1440 })
    },
    { default: { questdb: false, intervalMinutes: 60 } }
  )
})

export type Config = Static<typeof ConfigSchema>

/**
 * Materialised defaults — Signal K only uses the schema's `default` fields
 * to seed the Admin UI form, NOT to inject defaults into the runtime config
 * object passed to `plugin.start()`. When the plugin is auto-enabled
 * (signalk-plugin-enabled-by-default) or enabled without saving the form,
 * start() receives `{}`. Spread SCHEMA_DEFAULTS in start() so every field
 * is present at runtime.
 *
 * See AGENTS.md §"Plugin-specific gotchas".
 */
export const SCHEMA_DEFAULTS: Config = {
  managedContainer: true,
  imageTag: 'latest',
  externalUrl: '',
  databaseExport: {
    questdb: false,
    intervalMinutes: 60
  }
}
