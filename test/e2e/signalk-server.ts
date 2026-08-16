/**
 * Throwaway Signal K server for the end-to-end tests.
 *
 * The embedded webapp can only be exercised by the real thing: the Signal K
 * admin UI injects `<script type="module" src="/signalk-backup/remoteEntry.js">`
 * into its index.html, `import()`s it, calls `init(shareScope)` with the
 * host's React/ReactDOM, and mounts `./AppPanel` inside its own React tree
 * (see server-admin-ui `views/Webapps/dynamicutilities.ts`). A unit test can
 * mimic none of that faithfully — every regression this harness exists for
 * shipped with a green unit-test run.
 *
 * The server is installed on demand into `.e2e-cache/signalk-server/` (git-
 * ignored, reused across runs). Override with:
 *   SIGNALK_E2E_SERVER_VERSION  npm version/dist-tag to install (default: latest)
 *   SIGNALK_E2E_SERVER_BIN      path to an existing `bin/signalk-server`
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = resolve(here, '..', '..')
const CACHE_DIR = join(PLUGIN_ROOT, '.e2e-cache', 'signalk-server')

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', rej)
    child.on('exit', (code) => {
      if (code === 0) res()
      else rej(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}

/** Resolve (installing if needed) the signalk-server executable to test against. */
export async function ensureSignalkServer(): Promise<string> {
  const override = process.env.SIGNALK_E2E_SERVER_BIN
  if (override) {
    if (!existsSync(override)) throw new Error(`SIGNALK_E2E_SERVER_BIN not found: ${override}`)
    return override
  }
  const bin = join(CACHE_DIR, 'node_modules', 'signalk-server', 'bin', 'signalk-server')
  if (existsSync(bin)) return bin

  const version = process.env.SIGNALK_E2E_SERVER_VERSION ?? 'latest'
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(
    join(CACHE_DIR, 'package.json'),
    JSON.stringify({ name: 'signalk-backup-e2e-server', private: true }, null, 2)
  )
  await run(
    'npm',
    [
      'install',
      `signalk-server@${version}`,
      // signalk-server resolves its admin UI as
      // <own dir>/node_modules/@signalk/server-admin-ui — the layout a
      // global install produces. Nest its dependencies under it instead of
      // hoisting them next to it, or /admin/ answers 500.
      '--install-strategy=shallow',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--loglevel',
      'error'
    ],
    CACHE_DIR
  )
  if (!existsSync(bin)) throw new Error(`signalk-server install did not produce ${bin}`)
  return bin
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        rej(new Error('could not allocate a port'))
        return
      }
      const { port } = address
      srv.close(() => {
        res(port)
      })
    })
  })
}

export interface RunningServer {
  baseUrl: string
  configDir: string
  /** Everything the server wrote to stdout/stderr, for failure diagnostics. */
  log: () => string
  stop: () => Promise<void>
}

/**
 * Start a signalk-server on a free port with a fresh config directory in
 * which THIS checkout is installed as the `signalk-backup` plugin (symlink
 * into node_modules — the same layout the app store produces). No security
 * is configured, so the admin UI opens without a login.
 */
export async function startSignalkServer(): Promise<RunningServer> {
  const bin = await ensureSignalkServer()
  const port = await freePort()
  const configDir = await mkdtemp(join(tmpdir(), 'signalk-backup-e2e-'))
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({ pipedProviders: [] }, null, 2))
  // Enable the plugin the way a saved admin-UI form would. The webapps
  // listing hides plugin webapps whose options file says (or implies)
  // disabled, and `signalk-plugin-enabled-by-default` only affects start(),
  // not that listing.
  await mkdir(join(configDir, 'plugin-config-data'), { recursive: true })
  await writeFile(
    join(configDir, 'plugin-config-data', 'signalk-backup.json'),
    JSON.stringify({ enabled: true, configuration: {} }, null, 2)
  )
  await mkdir(join(configDir, 'node_modules'), { recursive: true })
  await symlink(
    PLUGIN_ROOT,
    join(configDir, 'node_modules', 'signalk-backup'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  const chunks: string[] = []
  const child: ChildProcess = spawn(process.execPath, [bin, '-c', configDir], {
    cwd: configDir,
    env: {
      ...process.env,
      PORT: String(port),
      // The default NMEA0183 TCP port (10110) is fixed and would collide with
      // any other server on the box; the test never uses it.
      NMEA0183PORT: String(port + 1),
      // Keep the throwaway server from touching the developer's ~/.signalk.
      SIGNALK_NODE_CONFIG_DIR: configDir,
      // Don't let the server's own update checks reach out during a test.
      SIGNALK_DISABLE_SERVER_UPDATES: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()))
  child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()))
  // Read through a function: TS narrows a variable (or property) assigned
  // inside the callback to its initial null and flags every later
  // comparison as always-true.
  let exitCode: number | null = null
  child.on('exit', (code) => {
    exitCode = code
  })
  const exitedWith = (): number | null => exitCode

  const baseUrl = `http://127.0.0.1:${port}`
  const stop = async () => {
    if (exitedWith() === null) {
      child.kill('SIGTERM')
      const deadline = Date.now() + 10_000
      while (exitedWith() === null && Date.now() < deadline) await delay(100)
      if (exitedWith() === null) child.kill('SIGKILL')
    }
    await rm(configDir, { recursive: true, force: true })
  }

  // Ready when the webapps listing names this plugin: that endpoint is served
  // by the same interface that mounts /signalk-backup/ and injects the
  // remoteEntry script tag, so it is the readiness signal that matters here.
  const deadline = Date.now() + 90_000
  for (;;) {
    const code = exitedWith()
    if (code !== null) {
      throw new Error(`signalk-server exited early (${code}):\n${chunks.join('')}`)
    }
    try {
      const res = await fetch(`${baseUrl}/skServer/webapps`)
      if (res.ok) {
        const list = (await res.json()) as { name: string }[]
        if (list.some((w) => w.name === 'signalk-backup')) break
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      await stop()
      throw new Error(`signalk-server did not become ready:\n${chunks.join('')}`)
    }
    await delay(250)
  }

  return { baseUrl, configDir, log: () => chunks.join(''), stop }
}
