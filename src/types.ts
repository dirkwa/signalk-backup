import { ServerAPI } from '@signalk/server-api'

export type BackupServerAPI = ServerAPI

// =============================================================================
// signalk-container API mirror
// =============================================================================
//
// Hand-rolled to keep this plugin loosely coupled to signalk-container (only
// a runtime peerDependency, no compile-time import). Source of truth:
//
//   https://github.com/dirkwa/signalk-container
//   - src/types.ts
//   - src/updates/types.ts
//
// Last synced against signalk-container: v0.1.6

export type ContainerState = 'running' | 'stopped' | 'missing' | 'no-runtime'

export interface ContainerRuntimeInfo {
  runtime: 'podman' | 'docker'
  version: string
  isPodmanDockerShim: boolean
}

export interface ContainerResourceLimits {
  cpus?: number | null
  cpuShares?: number | null
  cpusetCpus?: string | null
  memory?: string | null
  memorySwap?: string | null
  memoryReservation?: string | null
  pidsLimit?: number | null
  oomScoreAdj?: number | null
}

export interface ContainerConfig {
  image: string
  tag: string
  ports?: Record<string, string>
  volumes?: Record<string, string>
  env?: Record<string, string>
  restart?: 'no' | 'unless-stopped' | 'always'
  command?: string[]
  networkMode?: string
  resources?: ContainerResourceLimits
  /**
   * Mount the SignalK data dir at this path inside the container, regardless
   * of how SignalK is deployed (bare-metal, named volume, bind mount).
   */
  signalkDataMount?: string
  /**
   * Mount the SignalK *config root* (the entire `~/.signalk/` tree) at this
   * path inside the container. Distinct from `signalkDataMount`, which
   * resolves to the plugin-private subdir. Use this when the container
   * needs settings.json, security.json, or the whole plugin-config-data tree
   * (e.g. backup tools). Requires signalk-container >= 1.5.0.
   */
  signalkConfigRootMount?: string
  /**
   * Ports inside the container that the SignalK process must be able to
   * reach back to. signalk-container picks the right networking strategy
   * automatically and exposes the chosen address via resolveContainerAddress.
   */
  signalkAccessiblePorts?: number[]
}

export interface ContainerInfo {
  name: string
  image: string
  state: ContainerState
}

export interface UpdateResourcesResult {
  method: 'live' | 'recreated'
  warnings?: string[]
}

export type UpdateReason =
  | 'newer-version'
  | 'digest-drift'
  | 'older-than-pinned'
  | 'up-to-date'
  | 'offline'
  | 'unknown'
  | 'error'

export type UpdateTagKind = 'semver' | 'floating' | 'unknown'

export interface UpdateCheckResult {
  pluginId: string
  containerName: string
  runningTag: string
  tagKind: UpdateTagKind
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  reason: UpdateReason
  error?: string
  checkedAt: string
  lastSuccessfulCheckAt: string | null
  fromCache: boolean
}

export interface VersionSource {
  fetch: (...args: unknown[]) => Promise<unknown>
}

export interface UpdateRegistration {
  pluginId: string
  containerName: string
  image: string
  currentTag: () => string
  versionSource: VersionSource
  currentVersion?: () => Promise<string | null>
  checkInterval?: string
}

export interface UpdateServiceApi {
  register: (reg: UpdateRegistration) => void
  unregister: (pluginId: string) => void
  checkOne: (pluginId: string) => Promise<UpdateCheckResult>
  checkAll: () => Promise<UpdateCheckResult[]>
  getLastResult: (pluginId: string) => UpdateCheckResult | null
  sources: {
    githubReleases: (
      repo: string,
      options?: { allowPrerelease?: boolean; tagPrefix?: string }
    ) => VersionSource
    dockerHubTags: (image: string, options?: { filter?: (tag: string) => boolean }) => VersionSource
  }
}

export interface ContainerManagerApi {
  getRuntime: () => ContainerRuntimeInfo | null
  pullImage: (image: string, onProgress?: (msg: string) => void) => Promise<void>
  imageExists: (image: string) => Promise<boolean>
  getImageDigest: (imageOrContainer: string) => Promise<string | null>
  ensureRunning: (name: string, config: ContainerConfig) => Promise<void>
  start: (name: string) => Promise<void>
  stop: (name: string) => Promise<void>
  remove: (name: string) => Promise<void>
  getState: (name: string) => Promise<ContainerState>
  listContainers: () => Promise<ContainerInfo[]>
  updateResources: (name: string, limits: ContainerResourceLimits) => Promise<UpdateResourcesResult>
  getResources: (name: string) => ContainerResourceLimits
  resolveContainerAddress: (name: string, port: number) => Promise<string | null>
  updates: UpdateServiceApi
}

declare global {
  var __signalk_containerManager: ContainerManagerApi | undefined
}
