export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export type ScopedLspServerConfig = {
  name?: string
  command: string
  args?: string[]
  env?: Record<string, string>
  rootUri?: string
  extensions: string[]
  initializationOptions?: unknown
}

// Inline LSP server config as authored in plugin manifests (pre-scoping).
// Shape mirrors LspServerConfigSchema in utils/plugins/schemas.ts.
export type LspServerConfig = {
  command: string
  args?: string[]
  extensionToLanguage: Record<string, string>
  transport?: 'stdio' | 'socket'
  env?: Record<string, string>
  initializationOptions?: unknown
  settings?: unknown
  workspaceFolder?: string
  startupTimeout?: number
  shutdownTimeout?: number
  restartOnCrash?: boolean
  maxRestarts?: number
}
