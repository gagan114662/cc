import type { ConfigScope } from '../../entrypoints/sdk/coreTypes.js'

type ClientState =
  | { type: 'disabled' }
  | { type: 'connected'; config: unknown }
  | { type: 'pending'; config: unknown }
  | { type: 'failed'; config: unknown; error?: string }
  | { type: 'needs-auth'; config: unknown }

export type StdioServerInfo = {
  name: string
  scope: ConfigScope
  transport: 'stdio'
  client: ClientState
  config: { command: string; args?: string[]; env?: Record<string, string> }
  isAuthenticated?: boolean
}

type RemoteConfig =
  | { type: 'sse'; url: string; oauth?: Record<string, unknown> }
  | { type: 'http'; url: string; oauth?: Record<string, unknown> }
  | {
      type: 'claude-ai'
      url: string
      oauth?: Record<string, unknown>
      id?: string
    }

export type SSEServerInfo = {
  name: string
  scope: ConfigScope
  transport: 'sse'
  client: ClientState
  config: Extract<RemoteConfig, { type: 'sse' }>
  isAuthenticated: boolean
}

export type HTTPServerInfo = {
  name: string
  scope: ConfigScope
  transport: 'http'
  client: ClientState
  config: Extract<RemoteConfig, { type: 'http' }>
  isAuthenticated: boolean
}

export type ClaudeAIServerInfo = {
  name: string
  scope: ConfigScope
  transport: 'claude-ai'
  client: ClientState
  config: Extract<RemoteConfig, { type: 'claude-ai' }>
  isAuthenticated: boolean
}

export type AgentMcpServerInfo = {
  name: string
  transport: 'http' | 'sse'
  url?: string
  command?: string
  sourceAgents: string[]
  needsAuth: boolean
  isAuthenticated: boolean
}

export type ServerInfo =
  | StdioServerInfo
  | SSEServerInfo
  | HTTPServerInfo
  | ClaudeAIServerInfo

export type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'tool-list'; server: ServerInfo }
  | { type: 'tool-detail'; server: ServerInfo; toolIndex: number }
  | { type: 'agent-server'; agentServer: AgentMcpServerInfo }
