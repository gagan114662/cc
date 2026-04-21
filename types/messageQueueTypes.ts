/**
 * Types for the unified command queue operation log persisted via
 * `utils/sessionStorage.ts::recordQueueOperation`.
 *
 * Call sites:
 *   - `utils/messageQueueManager.ts` emits `QueueOperationMessage` entries
 *     tagged with one of the `QueueOperation` variants.
 *   - `utils/sessionStorage.ts` writes them to the session JSONL file as
 *     entries with `type: 'queue-operation'`.
 */

/** Queue mutation kinds — derived from logOperation() call sites. */
export type QueueOperation = 'enqueue' | 'dequeue' | 'remove' | 'popAll'

/** One queue-operation entry as persisted to the session transcript. */
export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  /** Present for enqueue/popAll when the queued command had string value. */
  content?: string
}
