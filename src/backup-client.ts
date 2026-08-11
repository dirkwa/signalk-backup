/**
 * HTTP client for talking to the backup-server container's API.
 *
 * Uses Node's built-in fetch (Node 22+). The plugin discovers the actual
 * base URL via signalk-container's resolveContainerAddress() after
 * ensureRunning(), then constructs this client.
 *
 * Methods used by the plugin's first-run logic:
 *   - waitForReady() — poll /api/health until 200 or timeout
 *   - getSettings()  — GET  /api/settings (read scheduler/cloud config)
 *   - putSettings()  — PUT  /api/settings (seed default schedule on first run)
 *   - getGuiUrl()    — GET  /api/gui-url (used by the redirect HTML's proxy)
 *
 * The full API surface (backups list/create/restore, cloud sync, etc.) is
 * exercised by the container's own UI. The plugin doesn't need to wrap it.
 */

export interface BackupServerSettings {
  scheduler?: {
    configured?: boolean
    daily?: { enabled: boolean; retain: number }
    hourly?: { enabled: boolean; retain: number }
    weekly?: { enabled: boolean; retain: number }
    startup?: { enabled: boolean; retain: number }
  }
  cloud?: {
    mode?: 'off' | 'manual' | 'daily' | 'weekly'
  }
  excludes?: string[]
  [key: string]: unknown
}

export interface BackupServerHealth {
  status: string
  uptime?: number
  version?: string
}

// Resolves early when `signal` fires, so a cancelled poll skips its remaining wait.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

export class BackupClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<T> {
    const controller = new AbortController()
    const timeoutMs = init.timeoutMs ?? 10_000
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    // Abort the live fetch too: a caller that gave up should not wait out the request timeout.
    const onCallerAbort = () => {
      controller.abort()
    }
    init.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (init.signal?.aborted) controller.abort()
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...((init.headers as Record<string, string> | undefined) ?? {})
      }
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`backup-server ${path} ${res.status}: ${body.slice(0, 200)}`)
      }
      const raw: unknown = await res.json()
      if (raw !== null && typeof raw === 'object' && 'success' in raw) {
        const wrapped = raw as { success?: boolean; data?: T; error?: unknown }
        if (!wrapped.success) {
          throw new Error(`backup-server ${path} not-ok: ${JSON.stringify(wrapped.error)}`)
        }
        return wrapped.data as T
      }
      return raw as T
    } catch (err) {
      // Native abort errors name neither the endpoint nor the timeout that fired.
      if (controller.signal.aborted) {
        throw new Error(`backup-server ${path} timed out after ${timeoutMs}ms`, { cause: err })
      }
      throw err
    } finally {
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  // Without `signal` this keeps probing for its full budget after the caller gave up: the retry loop around it only checks between attempts.
  async waitForReady(maxMs = 30_000, intervalMs = 1000, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + maxMs
    let lastErr: unknown
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('waitForReady aborted', { cause: lastErr })
      try {
        await this.request<BackupServerHealth>('/api/health', { timeoutMs: 2000, signal })
        return
      } catch (err) {
        lastErr = err
        if (signal?.aborted) throw new Error('waitForReady aborted', { cause: err })
        await sleep(intervalMs, signal)
      }
    }
    throw new Error(`backup-server at ${this.baseUrl} did not become ready within ${maxMs}ms`, {
      cause: lastErr
    })
  }

  async getSettings(): Promise<BackupServerSettings> {
    return this.request<BackupServerSettings>('/api/settings')
  }

  async putSettings(patch: Partial<BackupServerSettings>): Promise<BackupServerSettings> {
    return this.request<BackupServerSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch)
    })
  }

  async getGuiUrl(): Promise<{ url: string }> {
    return this.request<{ url: string }>('/api/gui-url')
  }

  get base(): string {
    return this.baseUrl
  }
}
