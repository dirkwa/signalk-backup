// mDNS-based SMB host discovery on the host network — runs in the
// SignalK process (plugin-side). Putting it here instead of in the
// backup-server container means the user's SignalK network mode is the
// only thing that determines whether multicast works.
//
// Wraps Bonjour's `_smb._tcp.local` browser. Returns whatever responds
// within `timeoutMs`; an empty list isn't an error (multicast may be
// blocked, no SMB devices on the LAN, etc) — the UI surfaces a manual
// host field as the always-available fallback.

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
