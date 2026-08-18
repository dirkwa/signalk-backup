import { ServerAPI } from '@signalk/server-api'

export type BackupServerAPI = ServerAPI

// signalk-container's API types come from signalk-container-helper, whose copy
// is pinned against the real thing by a build-time contract test — a local
// mirror silently drifts.
export type {
  ContainerConfig,
  ContainerInfo,
  ContainerManagerApi,
  ContainerResourceLimits,
  ContainerRuntimeInfo,
  ContainerState,
  EnsureRunningOptions,
  UpdateCheckResult,
  VolumeIssue,
  VolumeSpec
} from 'signalk-container-helper'
