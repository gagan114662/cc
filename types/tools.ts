// Reconstructed from the bundled CLI (`tmp-recover-cli.js`) and live callsites.
// Every tool progress shape mirrors what the runtime actually emits. Consumers
// narrow by the `type` discriminator (and `status` for MCPProgress).
//
// Evidence trail: /tmp/tools-types-inventory.md

import type { NormalizedMessage } from './message.js'

// ---------------------------------------------------------------------------
// Shell progress — Bash + PowerShell share an identical field set, so the
// generic `ShellProgress` alias narrows via the `type` discriminator.
// Bundle: tmp-recover-cli.js:483988 (bash), :445928 (powershell).
// ---------------------------------------------------------------------------

export type BashProgress = {
  type: 'bash_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds?: number
  totalLines?: number
  totalBytes?: number
  taskId?: string
  timeoutMs?: number
}

export type PowerShellProgress = {
  type: 'powershell_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds?: number
  totalLines?: number
  totalBytes?: number
  taskId?: string
  timeoutMs?: number
}

export type ShellProgress = BashProgress | PowerShellProgress

// ---------------------------------------------------------------------------
// MCPProgress — nested discriminator (type → status) emitted by services/mcp.
// Bundle: tmp-recover-cli.js:340409, 341323, 341355, 341385.
// ---------------------------------------------------------------------------

type MCPProgressBase = {
  type: 'mcp_progress'
  serverName: string
  toolName: string
}

export type MCPProgressStarted = MCPProgressBase & {
  status: 'started'
}

export type MCPProgressInFlight = MCPProgressBase & {
  status: 'progress'
  progress: number
  total?: number
  progressMessage?: string
}

export type MCPProgressCompleted = MCPProgressBase & {
  status: 'completed'
  elapsedTimeMs: number
}

export type MCPProgressFailed = MCPProgressBase & {
  status: 'failed'
  elapsedTimeMs: number
}

export type MCPProgress =
  | MCPProgressStarted
  | MCPProgressInFlight
  | MCPProgressCompleted
  | MCPProgressFailed

// ---------------------------------------------------------------------------
// AgentToolProgress / SkillToolProgress — both carry a forwarded sub-agent
// message plus the spawning prompt and agent id.
// Bundle: tmp-recover-cli.js:425237, 480459, 480686 (agent); :432097 (skill).
// ---------------------------------------------------------------------------

export type AgentToolProgress = {
  type: 'agent_progress'
  message: NormalizedMessage
  prompt: string
  agentId: string
}

export type SkillToolProgress = {
  type: 'skill_progress'
  message: NormalizedMessage
  prompt: string
  agentId: string
}

// ---------------------------------------------------------------------------
// TaskOutputProgress — emitted while the tool is waiting for a scheduled task.
// Live: tools/TaskOutputTool/TaskOutputTool.tsx:244.
// ---------------------------------------------------------------------------

export type TaskOutputProgress = {
  type: 'waiting_for_task'
  taskDescription: string
  taskType: string
}

// ---------------------------------------------------------------------------
// WebSearchProgress — two-variant union emitted during query refinement and
// on result arrival. Live: tools/WebSearchTool/WebSearchTool.ts:349, 379.
// ---------------------------------------------------------------------------

export type WebSearchQueryUpdate = {
  type: 'query_update'
  query: string
}

export type WebSearchResultsReceived = {
  type: 'search_results_received'
  query: string
  resultCount: number
}

export type WebSearchProgress = WebSearchQueryUpdate | WebSearchResultsReceived

// ---------------------------------------------------------------------------
// REPLToolProgress — vestigial placeholder; Tool.ts still imports and
// re-exports it for backwards-compat but no runtime emits it.
// ---------------------------------------------------------------------------

export type REPLToolProgress = {
  type: 'repl_progress'
}

// ---------------------------------------------------------------------------
// SdkWorkflowProgress — not a ToolProgressData variant. Carried inside the
// `workflow_progress?: SdkWorkflowProgress[]` field on the SDK's
// TaskProgressEvent. Clients upsert by `${type}:${index}` and group by
// phaseIndex. Extra per-variant fields are tolerated.
// ---------------------------------------------------------------------------

export type SdkWorkflowProgress = {
  type: string
  index: number
  phaseIndex: number
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// ToolProgressData — the union every tool's onProgress narrows from.
// HookProgress is intentionally excluded (see Tool.ts:305).
// ---------------------------------------------------------------------------

export type ToolProgressData =
  | AgentToolProgress
  | BashProgress
  | PowerShellProgress
  | MCPProgress
  | REPLToolProgress
  | SkillToolProgress
  | TaskOutputProgress
  | WebSearchProgress
