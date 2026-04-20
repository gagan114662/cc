// Re-export most of the upstream SDK control-types surface, but override
// `SDKControlInitializeRequest` (and the `SDKControlRequest` union that
// carries it) with extra optional fields. The phantom node_modules types
// are narrower than the real runtime shape; the Zod schema in
// `entrypoints/sdk/controlSchemas.ts` is the source of truth.
export type {
  SDKHookCallbackMatcher,
  SDKControlInitializeResponse,
  SDKControlInterruptRequest,
  SDKControlPermissionRequest,
  SDKControlSetPermissionModeRequest,
  SDKControlSetModelRequest,
  SDKControlSetMaxThinkingTokensRequest,
  SDKControlMcpStatusRequest,
  SDKControlRewindFilesRequest,
  SDKControlRewindFilesResponse,
  SDKHookCallbackRequest,
  SDKControlMcpMessageRequest,
  SDKControlMcpSetServersRequest,
  SDKControlMcpSetServersResponse,
  SDKControlResponse,
  ControlResponse,
  ControlErrorResponse,
  SDKControlCancelRequest,
  SDKKeepAliveMessage,
} from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/controlTypes.js'

// Also re-export the core-type surface that upstream's `export *` pulled in.
export * from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.js'

import type {
  HookEvent,
  AgentDefinition,
} from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.js'
import type {
  SDKHookCallbackMatcher,
  SDKControlInterruptRequest,
  SDKControlPermissionRequest,
  SDKControlSetPermissionModeRequest,
  SDKControlSetModelRequest,
  SDKControlSetMaxThinkingTokensRequest,
  SDKControlMcpStatusRequest,
  SDKControlRewindFilesRequest,
  SDKHookCallbackRequest,
  SDKControlMcpMessageRequest,
  SDKControlMcpSetServersRequest,
  SDKControlResponse,
  SDKControlCancelRequest,
  SDKKeepAliveMessage,
} from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/controlTypes.js'
import type {
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.js'

// Extended initialize request — phantom types in node_modules are narrower
// than the real runtime shape. The Zod schema in controlSchemas.ts already
// accepts these fields; mirror them here so TS callsites can read them.
export type SDKControlInitializeRequest = {
  subtype: 'initialize'
  hooks?: Partial<Record<HookEvent, SDKHookCallbackMatcher[]>>
  sdkMcpServers?: string[]
  jsonSchema?: Record<string, unknown>
  systemPrompt?: string
  appendSystemPrompt?: string
  agents?: Record<string, AgentDefinition>
  promptSuggestions?: boolean
  agentProgressSummaries?: boolean
}

// Rebuild the control-request union so discriminated-union narrowing on
// `subtype === 'initialize'` resolves to the augmented type above.
export type SDKControlRequest = {
  type: 'control_request'
  request_id: string
  request:
    | SDKControlInterruptRequest
    | SDKControlPermissionRequest
    | SDKControlInitializeRequest
    | SDKControlSetPermissionModeRequest
    | SDKControlSetModelRequest
    | SDKControlSetMaxThinkingTokensRequest
    | SDKControlMcpStatusRequest
    | SDKHookCallbackRequest
    | SDKControlMcpMessageRequest
    | SDKControlRewindFilesRequest
    | SDKControlMcpSetServersRequest
}

// Rebuild aggregate stdin/stdout message unions so they use the augmented
// SDKControlRequest (with our extended initialize subtype), not the
// upstream node_modules version.
export type StdoutMessage =
  | SDKMessage
  | SDKControlResponse
  | SDKControlRequest
  | SDKControlCancelRequest
  | SDKKeepAliveMessage

export type StdinMessage =
  | SDKUserMessage
  | SDKControlRequest
  | SDKControlResponse
  | SDKKeepAliveMessage

// Response payload for the `reload_plugins` control request. Shape mirrors
// the object sent in cli/print.ts.
export type SDKControlReloadPluginsResponse = {
  commands: Array<{
    name: string
    description: string
    argumentHint: string
  }>
  agents: Array<{
    name: string
    description?: string
    model?: string
  }>
  plugins: Array<{
    name: string
    path: string
    source?: string
  }>
  mcpServers: unknown[]
  error_count: number
}
