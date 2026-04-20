/**
 * Phantom stub — MonitorMcp background task (feature('MONITOR_TOOL')).
 *
 * Callsites:
 *   - tasks.ts:13                        — MonitorMcpTask (runtime Task)
 *   - tools/AgentTool/runAgent.ts:851    — killMonitorMcpTasksForAgent(agentId, getAppState, setAppState)
 *   - components/tasks/BackgroundTasksDialog.tsx:117 — killMonitorMcp(taskId, setAppState)
 *
 * Also type-exported as `MonitorMcpTaskState` in tasks/types.ts and consumed
 * by BackgroundTasksDialog.tsx.
 */

import type { SetAppState, Task, TaskStateBase } from '../../Task.js'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  /** MCP server being monitored. */
  serverName?: string
  /** Optional agent this monitor is scoped to — used by killMonitorMcpTasksForAgent. */
  agentId?: string
  // FIXME: real state likely tracks recent events / last-seen-ts / error buffer.
  // Only the fields read at known callsites are guaranteed above; extend on recovery.
}

// Runtime Task entry registered in tasks.ts — left as a placeholder so
// imports resolve. Real Task instance carries type/label/lifecycle hooks.
export const MonitorMcpTask: Task = {
  // FIXME: Task shape is an ambiguous runtime object — real module supplies
  // concrete type/label/background-flag/etc. Throwing on access makes the
  // unimplemented path loud rather than silently wrong.
  get type(): 'monitor_mcp' {
    throw new Error('not implemented')
  },
} as unknown as Task

export function killMonitorMcp(
  _taskId: string,
  _setAppState: SetAppState,
): void {
  throw new Error('not implemented')
}

// FIXME: getAppState type loosely modeled — tasks/framework uses a
// thunk-style getter. Callsite passes toolUseContext.getAppState.
export function killMonitorMcpTasksForAgent(
  _agentId: string,
  _getAppState: () => unknown,
  _setAppState: SetAppState,
): void {
  throw new Error('not implemented')
}
