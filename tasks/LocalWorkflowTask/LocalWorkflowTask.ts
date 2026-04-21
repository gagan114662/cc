// Reconstructed phantom module.
//
// Direct `import type` importers (for the state shape):
//   - tasks/types.ts
//   - components/tasks/BackgroundTasksDialog.tsx
//
// BackgroundTasksDialog additionally does
//   `typeof import('src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')`
// to extract runtime helpers (killWorkflowTask / skipWorkflowAgent /
// retryWorkflowAgent), and tasks.ts does
//   `require('./tasks/LocalWorkflowTask/LocalWorkflowTask.js').LocalWorkflowTask`
// to pick up the Task definition when the WORKFLOW_SCRIPTS feature flag is
// on. Both of those need runtime-visible values, so this file publishes
// types plus runtime stubs guarded by `throw new Error('not implemented')`.
//
// Shape fields come from these concrete callsites (all via DeepImmutable):
//   - components/tasks/BackgroundTask.tsx:     task.workflowName ?? task.summary ?? task.description
//                                              task.agentCount, task.status, task.notified
//   - components/tasks/BackgroundTasksDialog.tsx: task.summary ?? task.description,
//                                                 task.startTime, task.status, task.id, task.type
//   - utils/hooks/sessionHooks.ts:             mention of agentControllers map
//   - utils/task/sdkProgress.ts:               mention of progress batching

import type { SetAppState, Task, TaskStateBase } from '../../Task.js'

/**
 * Discriminated-union member for `TaskState` covering workflow-script tasks.
 * Extends TaskStateBase (id, status, description, startTime, endTime,
 * totalPausedMs, outputFile, outputOffset, notified, toolUseId?).
 */
export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  /** meta.name from the workflow script, surfaced in the background task
   *  pill when available. Falls back to summary → description. */
  workflowName?: string
  /** One-line summary shown in the dialog row, if the workflow emitted one. */
  summary?: string
  /** Number of agents currently running inside this workflow (used for the
   *  "N agents" status suffix in the background task pill). */
  agentCount: number
  /** False when the task is still foregrounded (see isBackgroundTask). */
  isBackgrounded?: boolean
  // FIXME: agentControllers is referenced in utils/hooks/sessionHooks.ts as a
  // parallel to the session hooks map. Exact value type is workflow-internal
  // and not read structurally by any importer of this file, so it is typed
  // as `unknown` to satisfy both `DeepImmutable<LocalWorkflowTaskState>` and
  // any future property access without over-committing.
  agentControllers?: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Runtime surface
// ---------------------------------------------------------------------------
//
// These exports are read via `typeof import(...)` in
// components/tasks/BackgroundTasksDialog.tsx and via `require(...)` in
// tasks.ts. Both sites are gated by `feature('WORKFLOW_SCRIPTS')`, which is
// false in external builds, so in practice these bodies are never invoked
// when the phantom file is present. The throws exist to make accidental
// invocation loud.

/** Cancel a running workflow task. */
export function killWorkflowTask(
  _taskId: string,
  _setAppState: SetAppState,
): Promise<void> {
  throw new Error('not implemented')
}

/** Skip a single agent inside a running workflow task. */
export function skipWorkflowAgent(
  _taskId: string,
  _agentId: string,
  _setAppState: SetAppState,
): Promise<void> {
  throw new Error('not implemented')
}

/** Retry a failed agent inside a running workflow task. */
export function retryWorkflowAgent(
  _taskId: string,
  _agentId: string,
  _setAppState: SetAppState,
): Promise<void> {
  throw new Error('not implemented')
}

/** Task definition registered in tasks.ts when WORKFLOW_SCRIPTS is on. */
export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(_taskId: string, _setAppState: SetAppState): Promise<void> {
    throw new Error('not implemented')
  },
}
