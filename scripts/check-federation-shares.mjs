#!/usr/bin/env node
/**
 * Build gate for the federated webapp's share map.
 *
 * The Signal K admin UI host provides exactly `react` and `react-dom` in its
 * Module Federation share scope. If the emitted remote declares any other
 * shared module with `import: false` (its getter throws "must be provided by
 * host"), the panel fails to load for every user — and nothing else in the
 * build says so: 0.9.4 (#94) and 0.10.1 (#108) both shipped that way with a
 * green build. This script fails `npm run build` instead.
 *
 * It reads the emitted localSharedImportMap chunk rather than trusting
 * vite.config.ts, because the plugin adds shares on its own (sub-paths such as
 * react-dom/client for any importer in the graph) and did so non-
 * deterministically. Two independent readings, so a format change in
 * @module-federation/vite fails closed instead of passing silently.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public')
const assetsDir = join(publicDir, 'assets')

// What the host share scope contains (server-admin-ui dynamicutilities.ts).
const HOST_PROVIDED = new Set(['react', 'react-dom'])
// Everything the remote may declare as shared: host-provided modules plus
// the JSX runtimes it ships a bundled fallback for (vite.config.ts).
const ALLOWED_SHARED = new Set([...HOST_PROVIDED, 'react/jsx-runtime', 'react/jsx-dev-runtime'])

function fail(msg) {
  console.error(`\n✖ check-federation-shares: ${msg}\n`)
  process.exit(1)
}

if (!existsSync(join(publicDir, 'remoteEntry.js')))
  fail('public/remoteEntry.js not found — run vite build first')
if (!existsSync(assetsDir)) fail('public/assets/ not found')

const mapFiles = readdirSync(assetsDir).filter(
  (f) => f.includes('localSharedImportMap') && f.endsWith('.js')
)
if (mapFiles.length !== 1) {
  fail(
    `expected exactly one localSharedImportMap chunk in public/assets, found ${mapFiles.length}: ${mapFiles.join(', ') || '(none)'} — has @module-federation/vite changed its output layout? Update this script.`
  )
}
const source = readFileSync(join(assetsDir, mapFiles[0]), 'utf-8')

// Reading 1: every share entry's `name` field.
const declared = new Set([...source.matchAll(/\bname:\s*[`'"]([^`'"]+)[`'"]/g)].map((m) => m[1]))
// Reading 2: every module whose getter throws the host-provided error.
const hostOnly = new Set(
  [...source.matchAll(/Shared module '([^']+)' must be provided by host/g)].map((m) => m[1])
)

if (declared.size === 0 || hostOnly.size === 0) {
  fail(
    `could not read the share map from ${mapFiles[0]} (names: ${declared.size}, host-only: ${hostOnly.size}) — has @module-federation/vite changed its output format? Update this script.`
  )
}

const unexpectedShared = [...declared].filter((n) => !ALLOWED_SHARED.has(n))
const unexpectedHostOnly = [...hostOnly].filter((n) => !HOST_PROVIDED.has(n))
const missingHostOnly = [...HOST_PROVIDED].filter((n) => !hostOnly.has(n))

if (unexpectedHostOnly.length > 0) {
  fail(
    `the remote expects the host to provide ${unexpectedHostOnly.map((n) => `'${n}'`).join(', ')}, but the Signal K admin UI only provides ${[...HOST_PROVIDED].join(', ')}. The panel would fail with "Shared module '${unexpectedHostOnly[0]}' must be provided by host" (#108). Something in the build graph imports that module — keep it out of the remote (see vite.config.ts).`
  )
}
if (unexpectedShared.length > 0) {
  fail(
    `unexpected shared modules in the remote: ${unexpectedShared.join(', ')}. Add them to vite.config.ts and this allowlist only after confirming the admin UI panel still loads (npm run test:e2e).`
  )
}
if (missingHostOnly.length > 0) {
  fail(
    `${missingHostOnly.join(', ')} no longer shared with import: false — the remote would bundle its own copy and the panel breaks with two React instances.`
  )
}

console.log(
  `✔ check-federation-shares: shared=[${[...declared].sort().join(', ')}] host-provided=[${[...hostOnly].sort().join(', ')}]`
)
