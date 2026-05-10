import React, { useState, useEffect, useCallback, type CSSProperties } from 'react'

interface PluginConfig {
  managedContainer: boolean
  imageTag: string
  externalUrl: string
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
}

interface PluginStatus {
  container: {
    state: ContainerState
    image: string
    managed: boolean
  }
  ready: boolean
  guiUrl: string | null
}

type ContainerState = 'running' | 'stopped' | 'missing' | 'no-runtime' | 'unknown'

interface PluginConfigurationPanelProps {
  value?: Partial<PluginConfig>
  onChange?: (next: PluginConfig) => void
}

const S: Record<string, CSSProperties> = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#333',
    padding: '16px 0'
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 10,
    marginTop: 24
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '14px 18px',
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 10,
    marginBottom: 12
  },
  cardInfo: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: 600, color: '#333' },
  cardMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  stateDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    flexShrink: 0
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'none'
  },
  btnPrimary: { background: '#3b82f6', color: '#fff' },
  btnSecondary: { background: '#e5e7eb', color: '#333' },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 10
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: '#555',
    width: 180,
    flexShrink: 0
  },
  input: {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    fontSize: 13,
    background: '#fff',
    color: '#333',
    width: 220
  },
  select: {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    fontSize: 13,
    background: '#fff',
    color: '#333',
    minWidth: 200
  },
  status: { marginTop: 8, fontSize: 12, minHeight: 18, color: '#666' },
  errorText: { color: '#c00', fontSize: 12, marginTop: 8 },
  saveRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginTop: 20,
    paddingTop: 16,
    borderTop: '1px solid #e0e0e0'
  },
  saveStatus: { fontSize: 12, color: '#666' }
}

const STATE_COLORS: Record<ContainerState, string> = {
  running: '#10b981',
  stopped: '#9ca3af',
  missing: '#f59e0b',
  'no-runtime': '#ef4444',
  unknown: '#9ca3af'
}

// Mirror of src/config/schema.ts SCHEMA_DEFAULTS — used when the parent
// has not yet supplied a `value`.
const DEFAULTS: PluginConfig = {
  managedContainer: true,
  imageTag: 'latest',
  externalUrl: '',
  logLevel: 'info'
}

function configEqual(a: PluginConfig, b: PluginConfig): boolean {
  return (
    a.managedContainer === b.managedContainer &&
    a.imageTag === b.imageTag &&
    a.externalUrl === b.externalUrl &&
    a.logLevel === b.logLevel
  )
}

/**
 * SignalK Admin UI passes a `value` prop with the current plugin config and
 * an `onChange(newValue)` handler. The Admin UI does NOT trigger a plugin
 * restart on `onChange` alone — the plugin must POST to its own
 * `/plugins/<id>/config` endpoint to persist + restart. Mayara relies on
 * SignalK's default JSON-schema form which handles that automatically; we
 * use a custom panel and do the POST ourselves via the Save button.
 */
export default function PluginConfigurationPanel(
  props: PluginConfigurationPanelProps
): React.ReactElement {
  const { value = {}, onChange } = props

  const [draft, setDraft] = useState<PluginConfig>(() => ({ ...DEFAULTS, ...value }))
  const [status, setStatus] = useState<PluginStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveOk, setSaveOk] = useState(false)

  // Re-sync draft from `value` only when its *content* changes — the
  // SignalK Admin UI tends to pass `{}` as a fresh object identity on
  // every render, which would otherwise clobber user edits. Compare the
  // four fields we care about; ignore parent identity churn.
  const valueKey = [
    String(value.managedContainer ?? DEFAULTS.managedContainer),
    value.imageTag ?? DEFAULTS.imageTag,
    value.externalUrl ?? DEFAULTS.externalUrl,
    value.logLevel ?? DEFAULTS.logLevel
  ].join('|')
  useEffect(() => {
    setDraft({ ...DEFAULTS, ...value })
  }, [valueKey])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/plugins/signalk-backup/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as PluginStatus
      setStatus(data)
      setStatusError(null)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    const t = setInterval(() => {
      void refreshStatus()
    }, 5000)
    return () => {
      clearInterval(t)
    }
  }, [refreshStatus])

  const update = (patch: Partial<PluginConfig>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    setSaveOk(false)
    setSaveError(null)
  }

  const dirty = !configEqual(draft, { ...DEFAULTS, ...value })

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    setSaveOk(false)
    try {
      const res = await fetch('/plugins/signalk-backup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          configuration: draft
        })
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      // Notify parent so it updates its own state. Server has already
      // restarted the plugin; status polling reflects the new state in ~5s.
      if (typeof onChange === 'function') onChange(draft)
      setSaveOk(true)
      // Trigger immediate status refreshes so the user sees container
      // recreation feedback rather than waiting for the next poll tick.
      setTimeout(() => void refreshStatus(), 500)
      setTimeout(() => void refreshStatus(), 2000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRevert = (): void => {
    setDraft({ ...DEFAULTS, ...value })
    setSaveOk(false)
    setSaveError(null)
  }

  const containerState: ContainerState = status?.container.state ?? 'unknown'
  const stateColor = STATE_COLORS[containerState]

  return (
    <div style={S.root}>
      <div style={S.sectionTitle}>Backup Engine</div>

      <div style={S.card}>
        <div style={{ ...S.stateDot, background: stateColor }} />
        <div style={S.cardInfo}>
          <div style={S.cardTitle}>signalk-backup-server</div>
          <div style={S.cardMeta}>
            {status?.container.image ?? '—'} · {containerState}
            {status?.ready ? ' · ready' : ''}
          </div>
        </div>
        <a
          href="/plugins/signalk-backup/console/"
          target="_blank"
          rel="noreferrer"
          style={{
            ...S.btn,
            ...S.btnPrimary,
            ...(status?.ready ? {} : S.btnDisabled)
          }}
          aria-disabled={!status?.ready}
          onClick={(e) => {
            if (!status?.ready) e.preventDefault()
          }}
        >
          Open Backup Console →
        </a>
      </div>

      {statusError && <div style={S.errorText}>Status fetch error: {statusError}</div>}

      <div style={S.sectionTitle}>Container settings</div>

      <div style={S.fieldRow}>
        <label style={S.label}>Manage container</label>
        <select
          style={S.select}
          value={String(draft.managedContainer)}
          onChange={(e) => {
            update({ managedContainer: e.target.value === 'true' })
          }}
        >
          <option value="true">Yes (use signalk-container)</option>
          <option value="false">No (point at external URL)</option>
        </select>
      </div>

      <div style={S.fieldRow}>
        <label style={S.label}>Image tag</label>
        <input
          style={S.input}
          type="text"
          value={draft.imageTag}
          onChange={(e) => {
            update({ imageTag: e.target.value })
          }}
          placeholder="latest"
          disabled={!draft.managedContainer}
        />
      </div>

      <div style={S.fieldRow}>
        <label style={S.label}>External URL</label>
        <input
          style={S.input}
          type="text"
          value={draft.externalUrl}
          onChange={(e) => {
            update({ externalUrl: e.target.value })
          }}
          placeholder="http://192.168.1.50:3010"
          disabled={draft.managedContainer}
        />
      </div>

      <div style={S.fieldRow}>
        <label style={S.label}>Log level</label>
        <select
          style={S.select}
          value={draft.logLevel}
          onChange={(e) => {
            update({ logLevel: e.target.value as PluginConfig['logLevel'] })
          }}
        >
          <option value="trace">trace</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="fatal">fatal</option>
        </select>
      </div>

      <div style={S.status}>
        Schedule, retention, cloud sync, and exclusions are configured in the Backup Console.
      </div>

      <div style={S.saveRow}>
        <button
          type="button"
          style={{
            ...S.btn,
            ...S.btnPrimary,
            ...(saving ? S.btnDisabled : {})
          }}
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : dirty ? 'Save & restart' : 'Apply & restart'}
        </button>
        <button
          type="button"
          style={{
            ...S.btn,
            ...S.btnSecondary,
            ...(!dirty || saving ? S.btnDisabled : {})
          }}
          onClick={handleRevert}
          disabled={!dirty || saving}
        >
          Revert
        </button>
        <span style={S.saveStatus}>
          {saveError && <span style={{ color: '#c00' }}>Error: {saveError}</span>}
          {saveOk && !saveError && (
            <span style={{ color: '#10b981' }}>Saved — restarting plugin…</span>
          )}
          {!saveError && !saveOk && dirty && <span>Unsaved changes</span>}
        </span>
      </div>
    </div>
  )
}
