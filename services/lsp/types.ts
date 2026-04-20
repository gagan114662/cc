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
