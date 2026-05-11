import { useEffect, useState } from 'react'
import { Container, Nav, NavItem, NavLink } from 'reactstrap'
import { Dashboard } from './views/Dashboard'
import { Backups } from './views/Backups'

type Route = 'dashboard' | 'backups'

const ROUTES: { id: Route; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'backups', label: 'Backups' }
]

// Hash-routing keeps us off react-router and avoids the history API
// quirks behind SignalK's /signalk-backup/ mount prefix.
function parseHash(hash: string): Route {
  const trimmed = hash.replace(/^#\/?/, '')
  return ROUTES.some((r) => r.id === trimmed) ? (trimmed as Route) : 'dashboard'
}

function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseHash(window.location.hash))
    }
    window.addEventListener('hashchange', onChange)
    return () => {
      window.removeEventListener('hashchange', onChange)
    }
  }, [])
  const navigate = (r: Route): void => {
    window.location.hash = `#/${r}`
  }
  return [route, navigate]
}

export function App() {
  const [route, navigate] = useHashRoute()

  return (
    <Container className="py-4">
      <h1 className="mb-4">SignalK Backup</h1>

      <Nav tabs className="mb-3">
        {ROUTES.map((r) => (
          <NavItem key={r.id}>
            <NavLink
              href={`#/${r.id}`}
              active={route === r.id}
              onClick={(e) => {
                e.preventDefault()
                navigate(r.id)
              }}
            >
              {r.label}
            </NavLink>
          </NavItem>
        ))}
      </Nav>

      {route === 'dashboard' && <Dashboard />}
      {route === 'backups' && <Backups />}
    </Container>
  )
}
