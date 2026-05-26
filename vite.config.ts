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

// SignalK serves the built output at /signalk-backup/. `base` makes Vite
// emit asset URLs with that prefix so they resolve when the SignalK admin
// shell loads our remoteEntry.js from that path.
//
// Architecture: this webapp is a Module Federation remote consumed by the
// SignalK admin UI's Embedded route (/admin/#/e/signalk_backup, the safe-id
// is the package name with -/@// replaced by _). The exposed ./AppPanel
// component is rendered inside the admin's main view while the sidebar
// stays visible — that's the whole reason we use Module Federation rather
// than shipping a standalone signalk-webapp.
//
// React is shared as a singleton with the admin shell so hooks work across
// the boundary. main.tsx + index.html are still emitted alongside the
// remote entry so `npm run dev` (standalone) keeps working.
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'signalk-backup',
      filename: 'remoteEntry.js',
      exposes: {
        './AppPanel': resolve(here, 'webapp/src/AppPanel.tsx')
      },
      shared: {
        // import: false on react/react-dom is load-bearing. Without it the
        // @module-federation/vite remote bundles its own copy of React into
        // _virtual_mf_..._loadShare__ chunks and unconditionally writes
        // that copy into the runtime cache before the host's share scope
        // is consulted. The result: two React instances coexist, useState
        // returns null at first paint. See signalk-updater/vite.config.ts
        // for the long-form explanation.
        react: { singleton: true, requiredVersion: '^19.0.0', import: false },
        'react-dom': { singleton: true, requiredVersion: '^19.0.0', import: false },
        // react/jsx-runtime keeps `import` set to the module name (the
        // ConsumesItem form) so we DO bundle our own copy as the fallback.
        // The SignalK admin doesn't pre-register these sub-paths in its
        // share scope — only 'react' and 'react-dom' — so a deferred
        // host-provider lookup would otherwise throw "Shared module
        // 'react/jsx-runtime' must be provided by host". Bundling adds
        // ~1 kB; the modules are tiny self-contained factories.
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
    modulePreload: false
  },
  // Local dev server: vite serves the webapp directly. API calls are
  // proxied to a SignalK server you point at via SIGNALK_DEV_URL.
  server: {
    port: 5173,
    proxy: {
      '/plugins': process.env.SIGNALK_DEV_URL ?? 'http://127.0.0.1:3000',
      '/admin': process.env.SIGNALK_DEV_URL ?? 'http://127.0.0.1:3000'
    }
  }
})
