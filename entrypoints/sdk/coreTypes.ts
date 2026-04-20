// SDK Core Types - Common serializable types used by both SDK consumers and SDK builders.
//
// Types are generated from Zod schemas in coreSchemas.ts.
// To modify types:
// 1. Edit Zod schemas in coreSchemas.ts
// 2. Run: bun scripts/generate-sdk-types.ts
//
// Schemas are available in coreSchemas.ts for runtime validation but are not
// part of the public API.

// Re-export sandbox types for SDK consumers
export type {
  SandboxFilesystemConfig,
  SandboxIgnoreViolations,
  SandboxNetworkConfig,
  SandboxSettings,
} from '../sandboxTypes.js'
// Re-export all generated types
export * from './coreTypes.generated.js'

// Widen ModelUsage to include maxOutputTokens — tracked by stats.ts /
// statsCache.ts but not in the upstream SDK's ModelUsage. Explicit named
// export shadows the `export *` one above.
export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens?: number
}

// Re-export utility types that can't be expressed as Zod schemas
export type { NonNullableUsage } from './sdkUtilityTypes.js'

// Success variant of SDKResultMessage — used by the bridge for session archival
// and anywhere that needs to narrow result messages to the non-error shape.
import type { SDKResultMessage, BaseHookInput } from './coreTypes.generated.js'
export type SDKResultSuccess = Extract<SDKResultMessage, { subtype: 'success' }>

// Session metadata returned by listSessions / getSessionInfo. Shape mirrors
// SDKSessionInfoSchema in coreSchemas.ts.
export type SDKSessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}

// Rate-limit info surfaced to claude.ai subscribers. Shape mirrors
// SDKRateLimitInfoSchema in coreSchemas.ts.
export type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: number
  rateLimitType?:
    | 'five_hour'
    | 'seven_day'
    | 'seven_day_opus'
    | 'seven_day_sonnet'
    | 'overage'
  utilization?: number
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected'
  overageResetsAt?: number
  overageDisabledReason?:
    | 'overage_not_provisioned'
    | 'org_level_disabled'
    | 'org_level_disabled_until'
    | 'out_of_credits'
    | 'seat_tier_level_disabled'
    | 'member_level_disabled'
    | 'seat_tier_zero_credit_limit'
    | 'group_zero_credit_limit'
    | 'member_zero_credit_limit'
    | 'org_service_level_disabled'
    | 'org_service_zero_credit_limit'
    | 'no_limits_configured'
    | 'unknown'
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

// Hook input variants for events that the upstream SDK doesn't yet expose.
// All share BaseHookInput (session_id, transcript_path, cwd, permission_mode)
// plus a hook_event_name discriminant and event-specific fields. Shapes are
// derived from utils/hooks.ts callsites (createBaseHookInput + extra fields).

export type StopFailureHookInput = BaseHookInput & {
  hook_event_name: 'StopFailure'
  error: string
  error_details?: unknown
  last_assistant_message?: string
}

export type TeammateIdleHookInput = BaseHookInput & {
  hook_event_name: 'TeammateIdle'
  teammate_name: string
  team_name?: string
}

export type TaskCreatedHookInput = BaseHookInput & {
  hook_event_name: 'TaskCreated'
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}

export type TaskCompletedHookInput = BaseHookInput & {
  hook_event_name: 'TaskCompleted'
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}

export type ConfigChangeHookInput = BaseHookInput & {
  hook_event_name: 'ConfigChange'
  source: string
  file_path?: string
}

export type CwdChangedHookInput = BaseHookInput & {
  hook_event_name: 'CwdChanged'
  old_cwd: string
  new_cwd: string
}

export type FileChangedHookInput = BaseHookInput & {
  hook_event_name: 'FileChanged'
  file_path: string
  event: 'change' | 'add' | 'unlink'
}

export type InstructionsLoadedHookInput = BaseHookInput & {
  hook_event_name: 'InstructionsLoaded'
  file_path: string
  memory_type?: string
  load_reason?: string
  globs?: string[]
  trigger_file_path?: string
  parent_file_path?: string
}

export type ElicitationHookInput = BaseHookInput & {
  hook_event_name: 'Elicitation'
  mcp_server_name: string
  message: string
  mode?: string
  url?: string
  elicitation_id: string
  requested_schema?: unknown
}

export type ElicitationResultHookInput = BaseHookInput & {
  hook_event_name: 'ElicitationResult'
  mcp_server_name: string
  elicitation_id: string
  mode?: string
  action: string
  content?: unknown
}

// Const arrays for runtime usage
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const

// Local HookEvent — derived from the runtime HOOK_EVENTS list, which is wider
// than the upstream SDK's HookEvent union. Explicit named export shadows the
// generated `export *` above so all callsites see the wider set.
export type HookEvent = (typeof HOOK_EVENTS)[number]

// Hook input shims for events the upstream SDK doesn't yet type. Field
// shapes mirror what utils/hooks.ts dispatches on; everything past the
// discriminator is open via index sig so consumers can read extra fields.
export type PermissionDeniedHookInput = BaseHookInput & {
  hook_event_name: 'PermissionDenied'
  tool_name?: string
  tool_input?: Record<string, unknown>
  reason?: string
  retry?: boolean
  [key: string]: unknown
}

export type PostCompactHookInput = BaseHookInput & {
  hook_event_name: 'PostCompact'
  trigger?: 'auto' | 'manual' | 'microcompact' | string
  custom_instructions?: string
  [key: string]: unknown
}

export type SetupHookInput = BaseHookInput & {
  hook_event_name: 'Setup'
  additionalContext?: string
  [key: string]: unknown
}

export type WorktreeCreateHookInput = BaseHookInput & {
  hook_event_name: 'WorktreeCreate'
  worktree_path?: string
  branch?: string
  [key: string]: unknown
}

export type WorktreeRemoveHookInput = BaseHookInput & {
  hook_event_name: 'WorktreeRemove'
  worktree_path?: string
  [key: string]: unknown
}

// Widen SyncHookJSONOutput.hookSpecificOutput so utils/hooks.ts can narrow on
// the wider HookEvent set (Setup, PermissionDenied, Elicitation, etc.).
// Upstream type only covers a subset; we add the remaining shapes.
export type SyncHookJSONOutput = {
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: 'approve' | 'block'
  systemMessage?: string
  reason?: string
  hookSpecificOutput?:
    | {
        hookEventName: 'PreToolUse'
        permissionDecision?: 'allow' | 'deny' | 'ask'
        permissionDecisionReason?: string
        updatedInput?: Record<string, unknown>
        additionalContext?: string
      }
    | {
        hookEventName: 'UserPromptSubmit'
        additionalContext?: string
      }
    | {
        hookEventName: 'SessionStart'
        additionalContext?: string
        initialUserMessage?: string
        watchPaths?: string[]
      }
    | {
        hookEventName: 'SubagentStart'
        additionalContext?: string
      }
    | {
        hookEventName: 'PostToolUse'
        additionalContext?: string
        updatedMCPToolOutput?: unknown
      }
    | {
        hookEventName: 'PostToolUseFailure'
        additionalContext?: string
      }
    | {
        hookEventName: 'PermissionRequest'
        decision?:
          | {
              behavior: 'allow'
              updatedInput?: Record<string, unknown>
              updatedPermissions?: unknown[]
            }
          | {
              behavior: 'deny'
              message?: string
              interrupt?: boolean
            }
      }
    | {
        hookEventName: 'Setup'
        additionalContext?: string
      }
    | {
        hookEventName: 'PermissionDenied'
        retry?: boolean
      }
    | {
        hookEventName: 'Elicitation'
        action?: 'accept' | 'decline' | 'cancel' | string
        content?: unknown
      }
    | {
        hookEventName: 'ElicitationResult'
        action?: 'accept' | 'decline' | 'cancel' | string
        content?: unknown
      }
}

export type HookJSONOutput =
  | { async: true; asyncTimeout?: number }
  | SyncHookJSONOutput
