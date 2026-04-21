/**
 * Phantom stub — spawns an ssh child process with a local auth proxy and
 * hands back a session object the REPL can drive.
 *
 * Surface derived from:
 *   - main.tsx:3211–3253 (createSSHSession / createLocalSSHSession / SSHSessionError)
 *   - hooks/useSSHSession.ts (SSHSession.createManager, proc, proxy, getStderrTail, ...)
 */

import type { ChildProcess } from 'node:child_process'
import type { PermissionMode } from '../types/permissions.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/controlTypes.js'
import type { SSHSessionManager } from './SSHSessionManager.js'

type CreateManagerOptions = {
  onMessage: (sdkMessage: SDKMessage) => void
  onConnected?: () => void
  onReconnecting?: (attempt: number, max: number) => void
  onDisconnected?: () => void
  onError?: (err: Error) => void
  onPermissionRequest?: (
    request: SDKControlPermissionRequest,
    requestId: string,
  ) => void
}

export type SSHSession = {
  /** Remote cwd as reported after the handshake. */
  remoteCwd: string
  /** The underlying ssh child process. */
  proc: ChildProcess
  /** Local auth proxy handle — owns the unix socket -R forward. */
  proxy: {
    stop: () => void
    // FIXME: proxy likely exposes more (socketPath, port, getToken, …);
    // only .stop() is read at callsites so that's all we guarantee.
  }
  /** Last N stderr bytes captured from the ssh process, for diagnostics. */
  getStderrTail: () => string
  /** Constructs the manager that drives the session for the REPL. */
  createManager: (opts: CreateManagerOptions) => SSHSessionManager
}

export class SSHSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSHSessionError'
  }
}

export type CreateSSHSessionOptions = {
  host: string
  cwd?: string
  localVersion: string
  permissionMode?: PermissionMode
  dangerouslySkipPermissions?: boolean
  extraCliArgs?: readonly string[]
}

export type CreateSSHSessionUiHooks = {
  onProgress?: (msg: string) => void
}

export function createSSHSession(
  _options: CreateSSHSessionOptions,
  _ui?: CreateSSHSessionUiHooks,
): Promise<SSHSession> {
  throw new Error('not implemented')
}

export type CreateLocalSSHSessionOptions = {
  cwd?: string
  permissionMode?: PermissionMode
  dangerouslySkipPermissions?: boolean
}

export function createLocalSSHSession(
  _options: CreateLocalSSHSessionOptions,
): SSHSession {
  throw new Error('not implemented')
}
