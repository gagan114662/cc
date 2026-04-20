/**
 * Ant-only subcommand handlers — reconstructed stub.
 *
 * These handlers are only invoked under `USER_TYPE === 'ant'` / the
 * `("external" as string) === 'ant'` constant-false gate in main.tsx. In the external
 * build the gate folds to false and the dynamic import is never reached at
 * runtime, so the runtime bodies below are deliberately minimal stubs
 * sufficient to satisfy `tsc --strict` for the static imports in main.tsx.
 *
 * If/when the ant build path is revived, replace each `throw` with the real
 * implementation. Signatures are derived from the callsites in main.tsx.
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */

import type { Command as CommanderCommand } from '@commander-js/extra-typings'

// --- `claude log` ----------------------------------------------------------

/**
 * Handler for `claude log [number|sessionId]`.
 * `logId` is either a session UUID (string), a numeric log index, or undefined
 * to list/display the default log. See `validateLogId` in main.tsx.
 */
export async function logHandler(
  logId: string | number | undefined,
): Promise<void> {
  // FIXME: Real implementation lives in the internal (ant) build. The
  // external bundle strips it, so we stub here. The surrounding gate in
  // main.tsx (`("external" as string) === 'ant'`) prevents this from being reached.
  void logId
  throw new Error('logHandler: not implemented in external build')
}

// --- `claude error` --------------------------------------------------------

/**
 * Handler for `claude error [number]`.
 * `number` is a numeric index (0, -1, -2, ...) selecting an error log.
 */
export async function errorHandler(
  number: number | undefined,
): Promise<void> {
  // FIXME: stub — see logHandler note above.
  void number
  throw new Error('errorHandler: not implemented in external build')
}

// --- `claude export` -------------------------------------------------------

/**
 * Handler for `claude export <source> <outputFile>`.
 * `source` is a session ID, numeric log index as a string, or a path to a
 * .json/.jsonl log file. `outputFile` is the destination path for the
 * rendered text.
 */
export async function exportHandler(
  source: string,
  outputFile: string,
): Promise<void> {
  // FIXME: stub — see logHandler note above.
  void source
  void outputFile
  throw new Error('exportHandler: not implemented in external build')
}

// --- `claude task ...` -----------------------------------------------------

/**
 * Options common to all `claude task ...` subcommands.
 */
export interface TaskCommandOptionsBase {
  /** Task list ID (defaults to "tasklist"). */
  list?: string
}

/**
 * Options for `claude task create <subject>`.
 */
export interface TaskCreateHandlerOptions extends TaskCommandOptionsBase {
  /** Task description body. */
  description?: string
}

export async function taskCreateHandler(
  subject: string,
  opts: TaskCreateHandlerOptions,
): Promise<void> {
  // FIXME: stub — see logHandler note above.
  void subject
  void opts
  throw new Error('taskCreateHandler: not implemented in external build')
}

/**
 * Options for `claude task list`.
 */
export interface TaskListHandlerOptions extends TaskCommandOptionsBase {
  /** Show only pending tasks. */
  pending?: boolean
  /** Output as JSON. */
  json?: boolean
}

export async function taskListHandler(
  opts: TaskListHandlerOptions,
): Promise<void> {
  // FIXME: stub — see logHandler note above.
  void opts
  throw new Error('taskListHandler: not implemented in external build')
}

/**
 * Options for `claude task get <id>`.
 */
export type TaskGetHandlerOptions = TaskCommandOptionsBase

export async function taskGetHandler(
  id: string,
  opts: TaskGetHandlerOptions,
): Promise<void> {
  // FIXME: stub — see logHandler note above.
  void id
  void opts
  throw new Error('taskGetHandler: not implemented in external build')
}

/**
 * Options for `claude task update <id>`.
 *
 * `status` is kept as `string` (not the narrower `TaskStatus` union) because
 * commander passes the raw CLI string through; the real handler is
 * responsible for validating against `TASK_STATUSES`.
 */
export interface TaskUpdateHandlerOptions extends TaskCommandOptionsBase {
  status?: string
  subject?: string
  description?: string
  owner?: string
  clearOwner?: boolean
}

export async function taskUpdateHandler(
  id: string,
  opts: TaskUpdateHandlerOptions,
): Promise<void> {
  // FIXME: stub — see logHandler note above.
  void id
  void opts
  throw new Error('taskUpdateHandler: not implemented in external build')
}

/**
 * Options for `claude task dir`.
 */
export type TaskDirHandlerOptions = TaskCommandOptionsBase

export async function taskDirHandler(
  opts: TaskDirHandlerOptions,
): Promise<void> {
  // FIXME: stub — see logHandler note above.
  void opts
  throw new Error('taskDirHandler: not implemented in external build')
}

// --- `claude completion <shell>` -------------------------------------------

/**
 * Options for `claude completion <shell>`.
 */
export interface CompletionHandlerOptions {
  /** Write completion script directly to a file instead of stdout. */
  output?: string
}

/**
 * The `program` argument is the root commander program so the handler can
 * introspect registered subcommands when generating completions. We accept
 * the broadest commander `Command` shape to stay compatible with either the
 * `commander` or `@commander-js/extra-typings` variants used in the repo.
 */
export async function completionHandler(
  shell: string,
  opts: CompletionHandlerOptions,
  program: CommanderCommand<unknown[], Record<string, unknown>>,
): Promise<void> {
  // FIXME: stub — see logHandler note above.
  void shell
  void opts
  void program
  throw new Error('completionHandler: not implemented in external build')
}
