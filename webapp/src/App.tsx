import { useState } from 'react'
import { Container, Nav, NavItem, NavLink } from 'reactstrap'
import { Dashboard } from './views/Dashboard'
import { Backups } from './views/Backups'
import { Cloud } from './views/Cloud'
import { DatabaseExports } from './views/DatabaseExports'
import { Settings } from './views/Settings'

type Route = 'dashboard' | 'backups' | 'database-exports' | 'cloud' | 'settings'

const ROUTES: { id: Route; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'backups', label: 'Backups' },
  { id: 'database-exports', label: 'Database exports' },
  { id: 'cloud', label: 'Cloud sync' },
  { id: 'settings', label: 'Settings' }
]

// In-memory tab state; admin owns hash (#/e/signalk_backup) so we can't write to it without breaking navigation.
export function App() {
  const [route, setRoute] = useState<Route>('dashboard')

  return (
    <Container className="py-4">
      <div className="d-flex align-items-center mb-4">
        <img src="/signalk-backup/icon.svg" alt="" width={40} height={40} className="me-3" />
        <h1 className="mb-0">SignalK Backup</h1>
        <small className="text-muted ms-3 align-self-end mb-2">v{__PLUGIN_VERSION__}</small>
      </div>

      <Nav tabs className="mb-3">
        {ROUTES.map((r) => (
          <NavItem key={r.id}>
            <NavLink
              href="#"
              active={route === r.id}
              onClick={(e) => {
                e.preventDefault()
                setRoute(r.id)
              }}
            >
              {r.label}
            </NavLink>
          </NavItem>
        ))}
      </Nav>

      {route === 'dashboard' && <Dashboard />}
      {route === 'backups' && <Backups />}
      {route === 'database-exports' && <DatabaseExports />}
      {route === 'cloud' && <Cloud />}
      {route === 'settings' && <Settings />}
    </Container>
  )
}
