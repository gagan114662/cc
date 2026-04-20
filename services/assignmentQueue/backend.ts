// Queue backend contract (Phase 2 item 3, Redis/BullMQ closure slice).
//
// Two backends live behind this interface:
//   - 'jsonl': the default, on-disk append-only queue that ships with
//     single-daemon deployments (services/assignmentQueue/storage.ts +
//     drainer.ts). Zero infra, crash-safe via append-only record
//     pattern; does not support multi-worker coordination.
//   - 'redis': a BullMQ-backed queue that supports multi-worker
//     consumption, retries, delayed jobs, and cross-daemon routing.
//     Opt-in because it requires a running Redis instance.
//
// Which backend is active is decided once at process boot by reading
// CC_QUEUE_BACKEND. Callers never branch on it — they go through
// getQueueBackend(), which returns the singleton for this process.
//
// Why an adapter (not a shared storage substrate): JSONL's semantics
// are "append records, fold on read"; BullMQ's semantics are "claim
// job, ack, retry". The call sites we need to serve (HTTP route,
// webhooks, daemon drain loop, recovery on boot) are the right seam
// for the abstraction — the internals below them do not share code.

import type { AssignmentRecord, AssignmentState } from './storage.js'
import type { TenantContext } from '../tenant/tenantContext.js'

export type QueueBackendKind = 'jsonl' | 'redis'
export type QueueCoordinationMode =
  | 'local-append-only'
  | 'shared-substrate'

export type EnqueueInput = { id: string; assignment: string }
export type EnqueueContext = { projectRoot?: string; tenantId: string }

export type DrainOptions = {
  projectRoot: string
  tenant: TenantContext
  runner: AssignmentRunner
  correlationIdFor?: (rec: AssignmentRecord) => string
}

export type AssignmentRunner = (input: {
  id: string
  assignment: string
  tenant: TenantContext
}) => Promise<void>

export type QueueBackend = {
  readonly kind: QueueBackendKind
  enqueue(input: EnqueueInput, ctx: EnqueueContext): Promise<void>
  // Run one drain pass over every pending assignment for the given
  // tenant. The JSONL backend folds its log; the Redis backend pulls
  // from the BullMQ queue. Returns when there are no more pending
  // records in this pass — the daemon calls on a timer.
  drainOnce(opts: DrainOptions): Promise<void>
  // Boot-time crash recovery: any assignment that was in 'running'
  // from a prior daemon's life gets re-pended so the next drain
  // picks it up. Returns the ids that were recovered.
  recover(ctx: EnqueueContext): Promise<string[]>
  // Called once at daemon shutdown so backends with long-lived
  // connections (Redis) can close cleanly. JSONL has no resources
  // to release but is still expected to resolve.
  close(): Promise<void>
}

export type { AssignmentRecord, AssignmentState }

let active: QueueBackend | null = null

// Called by tests to clear the singleton between setups. Production
// code never touches this — the singleton lives for the daemon
// process lifetime. Kept tiny so the test seam is obvious.
export function __resetQueueBackendForTest(): void {
  active = null
}

export function getQueueBackendKind(): QueueBackendKind {
  const raw = process.env.CC_QUEUE_BACKEND?.toLowerCase()
  if (raw === 'redis') return 'redis'
  return 'jsonl'
}

export function coordinationModeForQueueBackend(
  kind: QueueBackendKind,
): QueueCoordinationMode {
  return kind === 'redis' ? 'shared-substrate' : 'local-append-only'
}

// Lazy import of the concrete backend so a single-daemon deployment
// without Redis never loads BullMQ/ioredis code paths.
export async function getQueueBackend(): Promise<QueueBackend> {
  if (active) return active
  const kind = getQueueBackendKind()
  if (kind === 'redis') {
    const mod = await import('./backends/redis.js')
    active = mod.createRedisQueueBackend()
  } else {
    const mod = await import('./backends/jsonl.js')
    active = mod.createJsonlQueueBackend()
  }
  return active
}
