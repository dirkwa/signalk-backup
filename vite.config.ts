import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))

// Inline the plugin's own version so the webapp header can show it
// without a settings/health roundtrip.
const pkgVersion = (
  JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8')) as { version: string }
).version

// The Signal K admin UI host provides exactly these in its share scope
// (server-admin-ui/src/views/Webapps/dynamicutilities.ts). Sharing anything
// else with `import: false` — including sub-paths such as react-dom/client,
// which @module-federation/vite registers automatically for any module in the
// remote's graph that imports one — makes the remote throw "Shared module
// '…' must be provided by host" at load. scripts/check-federation-shares.mjs
// fails the build if the emitted share map ever grows past this list.
const HOST_PROVIDED = ['react', 'react-dom'] as const

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    // Federation only for the production build. `vite dev` serves the plain
    // dev shell (webapp/dev.html) with React resolved from node_modules — the
    // federated remote cannot run outside a host that provides React.
    ...(command === 'build'
      ? [
          federation({
            name: 'signalk-backup',
            filename: 'remoteEntry.js',
            exposes: {
              './AppPanel': resolve(here, 'webapp/src/AppPanel.tsx')
            },
            shared: {
              // import: false prevents bundling a second React copy that breaks useState; see signalk-updater/vite.config.ts.
              ...Object.fromEntries(
                HOST_PROVIDED.map((name) => [
                  name,
                  { singleton: true, requiredVersion: '^19.0.0', import: false }
                ])
              ),
              // import: 'react/jsx-runtime' bundles a ~1 kB fallback because admin doesn't pre-register jsx sub-paths.
              'react/jsx-runtime': {
                singleton: true,
                requiredVersion: '^19.0.0',
                import: 'react/jsx-runtime'
              },
              'react/jsx-dev-runtime': {
                singleton: true,
                requiredVersion: '^19.0.0',
                import: 'react/jsx-dev-runtime'
              }
            },
            dts: false
          })
        ]
      : [])
  ],
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkgVersion)
  },
  base: '/signalk-backup/',
  root: resolve(here, 'webapp'),
  build: {
    outDir: resolve(here, 'public'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      // The remote's real entry (remoteEntry.js) is emitted by the federation
      // plugin; rolldown still needs an input of its own. Deliberately NOT
      // webapp/dev.html: that shell imports react-dom/client for its own
      // createRoot, and any importer of a shared package's sub-path inside
      // the build graph gets that sub-path registered in the remote's share
      // map with the parent's `import: false` — whether it lands there was a
      // build-order race (0.10.1 shipped with it, 1.0.0 without, from the
      // same lockfile), which is #108. Keeping the dev shell out of the
      // graph removes the only such importer.
      input: resolve(here, 'webapp/src/remote.ts')
    }
  },
  // Local dev server: `npm run dev` serves webapp/dev.html directly. API
  // calls are proxied to a SignalK server you point at via SIGNALK_DEV_URL.
  server: {
    port: 5173,
    open: 'dev.html',
    proxy: {
      '/plugins': process.env.SIGNALK_DEV_URL ?? 'http://127.0.0.1:3000',
      '/admin': process.env.SIGNALK_DEV_URL ?? 'http://127.0.0.1:3000'
    }
  }
}))
