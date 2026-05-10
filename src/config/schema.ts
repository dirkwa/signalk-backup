import { Type, Static } from '@sinclair/typebox'

/**
 * Schema for the SignalK Admin UI plugin config form.
 *
 * Most user-facing settings (schedule, retention, cloud sync, exclusions)
 * live inside the backup-server container's own UI — open it via the
 * "Open Backup Console" link from /plugins/signalk-backup/. The fields
 * below are only the per-deployment knobs the SignalK admin needs.
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
  logLevel: Type.Union(
    [
      Type.Literal('trace'),
      Type.Literal('debug'),
      Type.Literal('info'),
      Type.Literal('warn'),
      Type.Literal('error'),
      Type.Literal('fatal')
    ],
    {
      default: 'info',
      title: 'Log level',
      description: 'Forwarded to the backup-server container as LOG_LEVEL.'
    }
  ),
  databaseExport: Type.Object(
    {
      questdb: Type.Boolean({
        default: false,
        title: 'Export QuestDB to backup',
        description:
          'When enabled, the plugin periodically writes QuestDB tables to Parquet files ' +
          'inside the backup data dir. The next snapshot then captures them as part of ' +
          'the regular backup. Filesystem-level QuestDB files are still excluded — only ' +
          'the safe COPY-out exports travel.'
      }),
      intervalMinutes: Type.Number({
        default: 60,
        minimum: 5,
        maximum: 1440,
        title: 'Export interval (minutes)',
        description:
          'How often the plugin runs database exports. The freshness of DB data inside ' +
          'a backup is bounded by max(this interval, the backup-server snapshot interval). ' +
          'Default 60.'
      })
    },
    {
      default: { questdb: false, intervalMinutes: 60 },
      title: 'Database export'
    }
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
  logLevel: 'info',
  databaseExport: {
    questdb: false,
    intervalMinutes: 60
  }
}
