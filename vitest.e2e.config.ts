import { defineConfig } from 'vitest/config'

// End-to-end suite: real signalk-server + headless Chromium against the
// built public/ output. Kept out of `npm test` (which must stay fast and
// browser-free on every CI matrix leg); run with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000
  }
})
