import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))

// Inline the plugin's own version so the webapp header can show it
// without a settings/health roundtrip.
const pkgVersion = (
  JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8')) as { version: string }
).version

// SignalK mounts the built output at /signalk-backup/ (per the
// webapps.ts loader, which uses package name + auto-detects public/).
// `base` makes Vite emit asset URLs with that prefix so they resolve
// correctly when served behind it.
export default defineConfig({
  plugins: [react()],
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkgVersion)
  },
  base: '/signalk-backup/',
  root: resolve(here, 'webapp'),
  build: {
    outDir: resolve(here, 'public'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022'
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
