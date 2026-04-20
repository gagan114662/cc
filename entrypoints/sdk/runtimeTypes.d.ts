export * from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/runtimeTypes.js'

// Local additions not present in the upstream SDK — surface them through
// runtimeTypes.d.ts so agentSdkTypes.ts can re-export via `export *`.

import type { Query, Options } from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/runtimeTypes.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.js'

// Effort tier for reasoning models. Matches EFFORT_LEVELS in utils/effort.ts.
export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

// Internal variants of Options/Query — same shape plus internal-only knobs.
export type InternalOptions = Options & Record<string, unknown>
export type InternalQuery = Query & { [key: string]: unknown }

// Session listing / mutation options. Shapes taken from consumer call sites
// (utils/listSessionsImpl.ts, cli/print.ts, entrypoints/agentSdkTypes.ts).
export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeWorktrees?: boolean
}

export type GetSessionInfoOptions = {
  dir?: string
}

export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export type SessionMutationOptions = {
  dir?: string
}

export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}

export type ForkSessionResult = {
  sessionId: string
}

// Session transcript message. Kept as a direct alias of SDKMessage since the
// disk-backed JSONL entries are the same shape.
export type SessionMessage = SDKMessage
