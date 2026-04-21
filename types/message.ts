// Reconstructed from the bundled CLI (`tmp-recover-cli.js` lines 496286+, 501913+,
// 504363+) and observed call-site usage. All shapes mirror what the runtime
// constructors actually produce. Exports match the names callers import.

import type { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

import type { Attachment } from '../utils/attachments.js'
import type { PermissionMode } from './permissions.js'

// ---------------------------------------------------------------------------
// Origin (shape: discriminated on `.kind`, not a string literal).
// Evidence: utils/messages.ts wrapCommandText switch over origin?.kind.
// ---------------------------------------------------------------------------

export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'task-notification' }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string }

// ---------------------------------------------------------------------------
// User / Assistant envelopes
// ---------------------------------------------------------------------------

export type UserMessage = {
  type: 'user'
  uuid: string
  timestamp: string
  message: MessageParam
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  summarizeMetadata?: unknown
  toolUseResult?: unknown
  mcpMeta?: unknown
  imagePasteIds?: string[]
  sourceToolAssistantUUID?: string
  sourceToolUseID?: string
  permissionMode?: PermissionMode
  origin?: MessageOrigin
  planContent?: string
}

export type AssistantMessage = {
  type: 'assistant'
  uuid: string
  timestamp: string
  message: BetaMessage
  requestId?: string
  apiError?: unknown
  error?: unknown
  errorDetails?: unknown
  isApiErrorMessage?: boolean
  isVirtual?: boolean
  isMeta?: boolean
  advisorModel?: string
}

// ---------------------------------------------------------------------------
// System message — union of subtypes, discriminated on `.subtype`
// ---------------------------------------------------------------------------

export type SystemMessageLevel = 'info' | 'warning' | 'error' | 'suggestion'

type SystemMessageBase = {
  type: 'system'
  uuid: string
  timestamp: string
  isMeta?: boolean
  level?: SystemMessageLevel
}

export type SystemInformationalMessage = SystemMessageBase & {
  subtype: 'informational'
  content: string
  toolUseID?: string
  preventContinuation?: boolean
}

export type SystemLocalCommandMessage = SystemMessageBase & {
  subtype: 'local_command'
  content: string
}

export type CompactMetadata = {
  trigger: 'auto' | 'manual' | 'microcompact' | string
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  preCompactDiscoveredTools?: string[]
  preservedSegment?: {
    headUuid: string
    anchorUuid: string
    tailUuid: string
  }
}

export type SystemCompactBoundaryMessage = SystemMessageBase & {
  subtype: 'compact_boundary'
  content: string
  compactMetadata: CompactMetadata
  logicalParentUuid?: string | null
}

export type MicrocompactMetadata = {
  trigger?: string
  preTokens?: number
  tokensSaved?: number
  compactedToolIds?: string[]
  clearedAttachmentUUIDs?: string[]
}

export type SystemMicrocompactBoundaryMessage = SystemMessageBase & {
  subtype: 'microcompact_boundary'
  content?: string
  compactMetadata?: CompactMetadata
  microcompactMetadata?: MicrocompactMetadata
  logicalParentUuid?: string | null
}

export type SystemAPIErrorMessage = SystemMessageBase & {
  subtype: 'api_error'
  error: Error
  cause?: Error
  retryInMs?: number
  retryAttempt?: number
  maxRetries?: number
}

export type SystemTurnDurationMessage = SystemMessageBase & {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export type SystemMemorySavedMessage = SystemMessageBase & {
  subtype: 'memory_saved'
  writtenPaths: string[]
}

export type SystemAwaySummaryMessage = SystemMessageBase & {
  subtype: 'away_summary'
  content: string
}

export type SystemAgentsKilledMessage = SystemMessageBase & {
  subtype: 'agents_killed'
}

export type SystemThinkingMessage = SystemMessageBase & {
  subtype: 'thinking'
  content: string
}

export type SystemBridgeStatusMessage = SystemMessageBase & {
  subtype: 'bridge_status'
  content?: string
  url?: string
  upgradeNudge?: string
}

export type SystemScheduledTaskFireMessage = SystemMessageBase & {
  subtype: 'scheduled_task_fire'
  content?: string
}

export type StopHookInfo = {
  hookName?: string
  hookLabel?: string
  durationMs: number
  stdout?: string
  stderr?: string
  exitCode?: number
  success?: boolean
  error?: string
}

export type SystemPermissionRetryMessage = SystemMessageBase & {
  subtype: 'permission_retry'
  content: string
  commands: string[]
}

export type SystemStopHookSummaryMessage = SystemMessageBase & {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors?: unknown[]
  preventedContinuation?: boolean
  stopReason?: string
  hasOutput?: boolean
  toolUseID?: string
  hookLabel?: string
  totalDurationMs?: number
}

export type SystemFileSnapshotMessage = SystemMessageBase & {
  subtype: 'file_snapshot'
  snapshotFiles?: string[]
  content?: string
}

export type SystemApiMetricsMessage = SystemMessageBase & {
  subtype: 'api_metrics'
  content?: string
  ttftMs?: number
  otps?: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export type SystemMessage =
  | SystemInformationalMessage
  | SystemLocalCommandMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemAPIErrorMessage
  | SystemTurnDurationMessage
  | SystemMemorySavedMessage
  | SystemAwaySummaryMessage
  | SystemAgentsKilledMessage
  | SystemThinkingMessage
  | SystemBridgeStatusMessage
  | SystemScheduledTaskFireMessage
  | SystemPermissionRetryMessage
  | SystemStopHookSummaryMessage
  | SystemFileSnapshotMessage
  | SystemApiMetricsMessage

// ---------------------------------------------------------------------------
// Attachment / Progress / Tombstone / ToolUseSummary / StreamEvent /
// RequestStartEvent / HookResultMessage
// ---------------------------------------------------------------------------

export type AttachmentMessage<A extends Attachment = Attachment> = {
  type: 'attachment'
  uuid: string
  timestamp: string
  attachment: A
}

export type ProgressMessage<P = Record<string, unknown>> = {
  type: 'progress'
  uuid: string
  timestamp: string
  toolUseID: string
  parentToolUseID?: string
  data: P & { message?: UserMessage | AssistantMessage }
}

export type TombstoneMessage = {
  type: 'tombstone'
  uuid?: string
  timestamp?: string
  message: Message
}

export type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  uuid: string
  timestamp: string
  summary: string
  precedingToolUseIds: string[]
}

export type StreamEvent = {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
  uuid?: string
  timestamp?: string
  ttftMs?: number
}

export type StreamRequestStartMessage = {
  type: 'stream_request_start'
  uuid?: string
  timestamp?: string
}

export type RequestStartEvent = {
  type: 'request_start_event'
  requestId: string
  timestamp?: string
}

// Hooks synthesise a subset of normal messages (user/attachment/system).
export type HookResultMessage = UserMessage | AttachmentMessage | SystemMessage

// ---------------------------------------------------------------------------
// The top-level discriminated union
// ---------------------------------------------------------------------------

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | AttachmentMessage
  | ProgressMessage
  | TombstoneMessage
  | ToolUseSummaryMessage
  | StreamEvent
  | StreamRequestStartMessage

// ---------------------------------------------------------------------------
// Normalized variants — post-normalization, message.content is always an array.
// ---------------------------------------------------------------------------

export type NormalizedUserMessage = UserMessage & {
  message: MessageParam & {
    content: Exclude<MessageParam['content'], string>
  }
}

export type NormalizedAssistantMessage = AssistantMessage

export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | SystemMessage
  | AttachmentMessage
  | ProgressMessage

// ---------------------------------------------------------------------------
// UI-side grouped / collapsed variants
// ---------------------------------------------------------------------------

export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  uuid: string
  timestamp?: string
  toolName?: string
  messages: Array<AssistantMessage | UserMessage>
  results?: unknown[]
  displayMessage?: AssistantMessage | UserMessage
  messageId?: string
}

export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  uuid: string
  timestamp?: string
  messages: Array<AssistantMessage | UserMessage | GroupedToolUseMessage>
  relevantMemories?: Array<{ path: string; content: string; mtimeMs: number }>
  // Counts and metadata accumulated by createCollapsedGroup in
  // utils/collapseReadSearch.ts. All optional because they're populated only
  // when the corresponding tool kind appeared in the group.
  searchCount?: number
  readCount?: number
  listCount?: number
  replCount?: number
  memorySearchCount?: number
  memoryReadCount?: number
  memoryWriteCount?: number
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  readFilePaths?: string[]
  searchArgs?: string[]
  latestDisplayHint?: string
  displayMessage?: AssistantMessage | UserMessage | GroupedToolUseMessage
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: Array<{ kind: string; sha: string }>
  pushes?: Array<{ branch: string }>
  branches?: Array<{ action: string; ref: string }>
  prs?: Array<{ action: string; number: number; url?: string }>
  hookCount?: number
  hookTotalMs?: number
  hookInfos?: Array<
    { command: string; durationMs?: number } | StopHookInfo
  >
}

export type RenderableMessage =
  | NormalizedMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup
  | ToolUseSummaryMessage
  | TombstoneMessage

export type CollapsibleMessage = RenderableMessage

// ---------------------------------------------------------------------------
// Compact direction (literal union)
// ---------------------------------------------------------------------------

export type PartialCompactDirection = 'from' | 'to' | 'up_to'
