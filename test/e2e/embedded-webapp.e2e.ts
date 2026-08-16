/**
 * End-to-end: the built webapp mounts inside a real Signal K admin UI.
 *
 * Runs `public/` (so `npm run build` first) inside a throwaway signalk-server
 * and drives the admin UI with headless Chromium. This is the only test that
 * exercises the Module Federation contract between the admin UI host and this
 * remote — the exact thing that broke in 0.9.4 (#94) and 0.10.1 (#108) with
 * every unit test green.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, startSignalkServer, type RunningServer } from './signalk-server.js'

const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf-8')) as {
  version: string
}

// Anything from the federation runtime is a failure, however it is worded.
const FEDERATION_ERROR = /module federation|must be provided by host|remoteEntry/i

interface Captured {
  errors: string[]
  federation: string[]
}

function capture(page: Page): Captured {
  const out: Captured = { errors: [], federation: [] }
  const record = (text: string) => {
    if (FEDERATION_ERROR.test(text)) out.federation.push(text)
  }
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      out.errors.push(msg.text())
      record(msg.text())
    }
  })
  page.on('pageerror', (err) => {
    out.errors.push(err.message)
    record(err.message)
  })
  return out
}

describe('embedded webapp in the Signal K admin UI', () => {
  const ctx: { server?: RunningServer; browser?: Browser } = {}
  const ready = () => {
    if (!ctx.server || !ctx.browser) throw new Error('e2e setup did not complete')
    return { server: ctx.server, browser: ctx.browser }
  }

  beforeAll(async () => {
    if (!existsSync(join(PLUGIN_ROOT, 'public', 'remoteEntry.js'))) {
      throw new Error('public/remoteEntry.js missing — run `npm run build` before the e2e tests')
    }
    ctx.server = await startSignalkServer()
    ctx.browser = await chromium.launch()
  }, 180_000)

  afterAll(async () => {
    await ctx.browser?.close()
    await ctx.server?.stop()
  })

  it('serves remoteEntry.js as an ES module the admin UI can import', async () => {
    const { server } = ready()
    const admin = await fetch(`${server.baseUrl}/admin/`)
    expect(admin.status).toBe(200)
    const html = await admin.text()
    // The server emits type="module" because package.json has "type": "module";
    // that is what makes the admin UI take the ESM (get/init exports) path.
    expect(html).toContain('<script type="module" src="/signalk-backup/remoteEntry.js"></script>')

    const entry = await fetch(`${server.baseUrl}/signalk-backup/remoteEntry.js`)
    expect(entry.status).toBe(200)
    expect(entry.headers.get('content-type')).toMatch(/javascript/)
  })

  it('mounts ./AppPanel with the host React and no federation errors', async () => {
    const { server, browser } = ready()
    const page = await browser.newPage()
    const captured = capture(page)
    try {
      await page.goto(`${server.baseUrl}/admin/#/e/signalk_backup`, { waitUntil: 'load' })

      // The App header is the first thing the panel renders; if the remote
      // failed to load, the admin UI renders "Error loading component" (with
      // the federation error text underneath) instead.
      const heading = page.getByRole('heading', { level: 1, name: 'SignalK Backup' })
      const errorBox = page.getByText('Error loading component')
      await Promise.race([
        heading.waitFor({ state: 'visible', timeout: 30_000 }),
        errorBox.waitFor({ state: 'visible', timeout: 30_000 })
      ]).catch(() => undefined)

      if (await errorBox.isVisible()) {
        const detail = await errorBox.locator('..').innerText()
        throw new Error(`admin UI could not load the webapp:\n${detail}`)
      }
      expect(await heading.isVisible(), server.log().slice(-2000)).toBe(true)

      // The panel is a live React tree, not a static shell: the header
      // shows the version inlined at build time and the tab bar switches
      // views on click (state via the HOST's React — a second React copy
      // would break exactly here).
      expect(await page.getByText(`v${pkg.version}`).isVisible()).toBe(true)
      // Scoped to the admin's <main>: the sidebar has its own "Settings" links.
      const tab = (name: string) => page.getByRole('main').getByRole('link', { name, exact: true })
      await tab('Settings').click()
      await tab('Settings').and(page.locator('.active')).waitFor({ timeout: 10_000 })
      await tab('Dashboard').click()
      await tab('Dashboard').and(page.locator('.active')).waitFor({ timeout: 10_000 })

      expect(captured.federation, captured.errors.join('\n')).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('redirects the bare /signalk-backup/ URL into the admin UI', async () => {
    const { server, browser } = ready()
    // The remote cannot run outside a host that provides React, so the
    // static index.html sends anyone landing there to the embedded view
    // (that page was a blank "Shared module 'react' must be provided by
    // host" before).
    const page = await browser.newPage()
    const captured = capture(page)
    try {
      await page.goto(`${server.baseUrl}/signalk-backup/`, { waitUntil: 'load' })
      await page.waitForURL(/\/admin\/#\/e\/signalk_backup$/, { timeout: 15_000 })
      const heading = page.getByRole('heading', { level: 1, name: 'SignalK Backup' })
      await heading.waitFor({ state: 'visible', timeout: 30_000 })
      expect(captured.federation, captured.errors.join('\n')).toEqual([])
    } finally {
      await page.close()
    }
  })
})
