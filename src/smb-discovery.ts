// Lives plugin-side (not in the container) so the SignalK process's
// network is what determines whether multicast reaches the LAN.

import { Bonjour } from 'bonjour-service'

export interface SmbHost {
  /** mDNS service name, typically the device's friendly name. */
  name: string
  /** First reachable address (IPv4 if present, else IPv6). */
  address: string
}

let bonjour: Bonjour | null = null

function getBonjour(): Bonjour {
  // Reuse a single instance across calls — re-creating the multicast
  // socket on every discover() leaks file descriptors over time.
  if (!bonjour) bonjour = new Bonjour()
  return bonjour
}

export async function discoverSmbHosts(timeoutMs = 2000): Promise<SmbHost[]> {
  return new Promise<SmbHost[]>((resolve) => {
    const found = new Map<string, SmbHost>()
    const browser = getBonjour().find({ type: 'smb' }, (service) => {
      // Prefer IPv4 from the addresses list; fall back to the first
      // address bonjour resolved; final fallback is the hostname (which
      // the resolved Service guarantees is non-empty).
      const addresses = service.addresses ?? []
      const ipv4 = addresses.find((a) => a.includes('.') && !a.includes(':'))
      const address = ipv4 ?? addresses[0] ?? service.host
      if (!address) return
      // Dedupe on address — one device often advertises multiple
      // service instances per share root.
      if (!found.has(address)) {
        found.set(address, { name: service.name || address, address })
      }
    })

    setTimeout(() => {
      browser.stop()
      resolve(Array.from(found.values()))
    }, timeoutMs)
  })
}

export function shutdownSmbDiscovery(): void {
  if (bonjour) {
    bonjour.destroy()
    bonjour = null
  }
}
