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
        // import: false prevents bundling a second React copy that breaks useState; see signalk-updater/vite.config.ts.
        react: { singleton: true, requiredVersion: '^19.0.0', import: false },
        'react-dom': { singleton: true, requiredVersion: '^19.0.0', import: false },
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
