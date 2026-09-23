#!/usr/bin/env node
/**
 * Build gate for the federated webapp: the remote must not carry its own React.
 *
 * The Signal K admin UI provides React through Module Federation. A remote that
 * bundles a second copy runs a second dispatcher, so every hook reads null and
 * the panel fails to load for every user — 0.9.4 (#94) and 0.10.1 (#108) both
 * shipped that way with a green build.
 *
 * The test is React's element marker together with a hook, in one chunk. Both
 * live inside React, so they reach the remote only when React does — a property
 * of what got bundled rather than of how @module-federation/vite chose to write
 * the share map, which is what the previous version of this script read and why
 * a minifier refactor in 1.22.1 failed it on a correct build.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public')

// React's element marker, present in react's own production build. Chosen over
// the `Minified React error` formatter, which ships in react-dom but not react —
// a remote bundling react alone would have passed that test while still running
// a second dispatcher.
const REACT_INTERNALS = 'react.transitional.element'

// vite.config.ts deliberately bundles a ~1 kB react/jsx-runtime fallback,
// because the admin UI does not pre-register JSX sub-paths. That fallback
// carries the element marker but none of React itself, so the hook dispatcher
// is what separates it from a real copy — and unlike the chunk's name, which
// @module-federation has already renamed once, that is a property of the code.
const REACT_RUNTIME = 'useState'

function fail(msg) {
  console.error(`\n✖ check-federation-shares: ${msg}\n`)
  process.exit(1)
}

if (!existsSync(join(publicDir, 'remoteEntry.js')))
  fail('public/remoteEntry.js not found — run vite build first')

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return jsFiles(p)
    // Source maps carry React's strings without shipping its code.
    return e.name.endsWith('.js') ? [p] : []
  })
}

const files = jsFiles(publicDir)
if (files.length === 0) fail('no .js emitted under public/ — run vite build first')

// A build that stops emitting the share map has stopped federating, and the
// scan below would pass on the plain chunks it still writes.
if (!files.some((f) => f.includes('localSharedImportMap'))) {
  fail(
    'no localSharedImportMap chunk under public/ — the build emitted no share map, so the ' +
      'panel would not load in the admin UI. Has the federation plugin stopped running?'
  )
}

const offenders = files.filter((f) => {
  const src = readFileSync(f, 'utf-8')
  return src.includes(REACT_INTERNALS) && src.includes(REACT_RUNTIME)
})

if (offenders.length > 0) {
  fail(
    `the remote bundles its own React: ${offenders.map((f) => f.slice(root.length + 1)).join(', ')}. ` +
      `The admin UI provides React through the share scope, so a second copy means a second ` +
      `dispatcher and every hook reads null (#94, #108). Check the \`shared\` block in ` +
      `vite.config.ts — a sub-path importer (react-dom/client, a JSX runtime) pulls React in ` +
      `when it is not declared there.`
  )
}

console.log(`✔ check-federation-shares: no bundled React in ${files.length} emitted chunks`)
