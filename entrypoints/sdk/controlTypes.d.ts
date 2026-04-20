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

// Additional control-request subtypes not yet typed upstream. The runtime
// dispatcher in cli/print.ts handles all of these; the Zod schema in
// controlSchemas.ts accepts them too. Field shapes mirror the wire format
// used by the dispatcher; remaining unknowns are kept open via the index sig.
export type SDKControlExtendedRequest =
  | { subtype: 'end_session'; reason?: string; [key: string]: unknown }
  | { subtype: 'get_context_usage'; [key: string]: unknown }
  | {
      subtype: 'cancel_async_message'
      message_uuid: string
      [key: string]: unknown
    }
  | {
      subtype: 'seed_read_state'
      path: string
      mtime: number
      [key: string]: unknown
    }
  | { subtype: 'reload_plugins'; [key: string]: unknown }
  | { subtype: 'mcp_reconnect'; serverName: string; [key: string]: unknown }
  | { subtype: 'mcp_toggle'; [key: string]: unknown }
  | { subtype: 'channel_enable'; serverName: string; [key: string]: unknown }
  | { subtype: 'mcp_authenticate'; [key: string]: unknown }
  | { subtype: 'mcp_oauth_callback_url'; [key: string]: unknown }
  | { subtype: 'mcp_clear_auth'; [key: string]: unknown }
  | { subtype: 'claude_authenticate'; [key: string]: unknown }
  | {
      subtype: 'claude_oauth_callback'
      authorizationCode: string
      state: string
      [key: string]: unknown
    }
  | { subtype: 'claude_oauth_wait_for_completion'; [key: string]: unknown }
  | {
      subtype: 'apply_flag_settings'
      settings: Record<string, unknown>
      [key: string]: unknown
    }
  | { subtype: 'generate_session_title'; [key: string]: unknown }
  | { subtype: 'get_settings'; [key: string]: unknown }
  | {
      subtype: 'remote_control'
      enabled?: boolean
      [key: string]: unknown
    }
  | { subtype: 'side_question'; [key: string]: unknown }
  | { subtype: 'stop_task'; [key: string]: unknown }

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
    | SDKControlExtendedRequest
}

// Additional system-message subtypes emitted at runtime but not yet in
// upstream's SDKSystemMessage. Shapes are minimal because consumers in
// cli/print.ts only narrow on `.subtype` before passing through.
export type SDKSystemExtendedMessage =
  | {
      type: 'system'
      subtype: 'session_state_changed'
      uuid: string
      session_id: string
      [key: string]: unknown
    }
  | {
      type: 'system'
      subtype: 'task_notification'
      uuid: string
      session_id: string
      [key: string]: unknown
    }
  | {
      type: 'system'
      subtype: 'task_started'
      uuid: string
      session_id: string
      [key: string]: unknown
    }
  | {
      type: 'system'
      subtype: 'task_progress'
      uuid: string
      session_id: string
      [key: string]: unknown
    }
  | {
      type: 'system'
      subtype: 'post_turn_summary'
      uuid: string
      session_id: string
      [key: string]: unknown
    }

// Streamlined-output variants emitted by createStreamlinedTransformer and
// prompt-suggestion channel messages. Not in upstream SDK types.
export type SDKStreamlinedTextMessage = {
  type: 'streamlined_text'
  text: string
  uuid: string
  session_id: string
  [key: string]: unknown
}

export type SDKStreamlinedToolUseSummaryMessage = {
  type: 'streamlined_tool_use_summary'
  uuid: string
  session_id: string
  [key: string]: unknown
}

export type SDKPromptSuggestionMessage = {
  type: 'prompt_suggestion'
  uuid: string
  session_id: string
  [key: string]: unknown
}

// Rebuild aggregate stdin/stdout message unions so they use the augmented
// SDKControlRequest (with our extended initialize subtype), not the
// upstream node_modules version.
export type StdoutMessage =
  | SDKMessage
  | SDKSystemExtendedMessage
  | SDKStreamlinedTextMessage
  | SDKStreamlinedToolUseSummaryMessage
  | SDKPromptSuggestionMessage
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
