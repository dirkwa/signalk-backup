/**
 * Embedded panel rendered by the SignalK admin UI's /admin/#/e/signalk_backup
 * route. The SignalK admin loads /signalk-backup/remoteEntry.js (a Module
 * Federation remote) and renders this component inside its own layout —
 * the admin sidebar stays visible, which is the whole reason we ship as
 * an embeddable webapp rather than a standalone one.
 *
 * Unlike signalk-updater (which iframes a separate engine console here),
 * the backup UI lives entirely inside the plugin. All API calls already
 * go through the existing same-origin /plugins/signalk-backup/api/* proxy,
 * so there's no need for an iframe, an engine reverse proxy, or an
 * api-base meta tag — the panel is the React UI directly.
 *
 * The {loginStatus, adminUI} props are the admin shell's standard injection
 * contract; we accept them for type compatibility but use neither. The
 * panel intentionally does NOT call adminUI.hideSideBar() — sidebar
 * visibility is the point.
 */
import { App } from './App'

export default function AppPanel() {
  return <App />
}
