import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// SignalK mounts the built output at /signalk-backup/ (per the
// webapps.ts loader, which uses package name + auto-detects public/).
// `base` makes Vite emit asset URLs with that prefix so they resolve
// correctly when served behind it.
export default defineConfig({
  plugins: [react()],
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
