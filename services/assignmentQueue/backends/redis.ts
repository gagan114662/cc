// BullMQ + ioredis queue backend.
//
// Why: JSONL is single-daemon by construction. The Phase 3 gap
// "Distributed worker coordination" needs a shared substrate so two
// daemons on two machines pull from the same queue. BullMQ gives us
// claim/ack semantics, retries, delayed jobs, and a standard ops
// story (Redis monitoring) without inventing any of it.
//
// Wiring:
//   - one Queue per tenant, name `cc:assignments:<tenantId>`
//   - Workers are short-lived (created per drainOnce call) so a
//     crashed daemon doesn't leak long-running subscriptions. This
//     is consistent with the JSONL backend's "poll-on-timer" model;
//     callers that want continuous consumption should loop drainOnce
//     at the daemon level — same as today.
//   - Failed jobs are recorded by appending to the JSONL state log
//     *in addition to* BullMQ's own failure tracking. That dual-
//     write is deliberate: ops can inspect either, and the audit
//     record stays in the same place whether queueing is local or
//     cross-machine. If the audit append fails we still surface
//     the runner error to BullMQ (so retry policies work).
//
// Connection: REDIS_URL env var. No Redis password support yet —
// if you need auth, use the URL's userinfo component (ioredis
// supports it natively). That keeps the config surface narrow.

import { Queue, Worker, type Job } from 'bullmq'
import type { QueueBackend, EnqueueInput, EnqueueContext } from '../backend.js'
import {
  appendAssignmentStateRecord,
  enqueueAssignment,
} from '../storage.js'
import { runWithTenantScope } from '../../tenant/tenantScope.js'

type JobPayload = { assignment: string }

function queueName(tenantId: string): string {
  // BullMQ rejects ':' in queue names (it reserves that for its own
  // Redis key structure). Use '-' separators and let BullMQ's
  // prefix handle namespacing under the hood.
  return `cc-assignments-${tenantId}`
}

function redisConnectionOpts() {
  const url = process.env.REDIS_URL
  if (!url) {
    // Fail loud: a misconfigured prod with CC_QUEUE_BACKEND=redis but
    // no REDIS_URL would silently fall over at first enqueue. Better
    // to error at boot so the operator notices in logs immediately.
    throw new Error(
      'redis_backend_missing_url: set REDIS_URL when CC_QUEUE_BACKEND=redis',
    )
  }
  return { connection: { url } }
}

async function listDrainableJobs(
  queue: Queue<JobPayload>,
): Promise<Job<JobPayload>[]> {
  const waitingJobs = await queue.getJobs(['waiting', 'delayed'], 0, -1)
  if (waitingJobs.length > 0) return waitingJobs

  // BullMQ can acknowledge add() before the new waiting job is
  // visible to an immediate read in the same tick. One short retry
  // keeps drainOnce deterministic for callers that enqueue and then
  // drain right away, while still preserving the daemon's timer-loop
  // semantics for long-running workers.
  await new Promise(resolve => setTimeout(resolve, 25))
  return queue.getJobs(['waiting', 'delayed'], 0, -1)
}

export function createRedisQueueBackend(): QueueBackend {
  // One Queue per tenant — BullMQ's Queue is cheap (a pipelined
  // pub/sub client) and sharing a single queue across tenants would
  // re-create the module-scope-singleton problem Phase 2 item 1
  // closed.
  const queues = new Map<string, Queue<JobPayload>>()

  function getQueue(tenantId: string): Queue<JobPayload> {
    let q = queues.get(tenantId)
    if (!q) {
      q = new Queue<JobPayload>(queueName(tenantId), redisConnectionOpts())
      queues.set(tenantId, q)
    }
    return q
  }

  return {
    kind: 'redis',
    async enqueue(input: EnqueueInput, ctx: EnqueueContext) {
      // Dual-write: BullMQ is the queue source of truth for claim/ack
      // semantics; JSONL holds the append-only audit record so
      // `loadAssignmentQueue` projects a consistent view regardless of
      // which backend is active. Order matters — JSONL first so an
      // error writing the audit log surfaces before the job becomes
      // claimable; we would rather reject the enqueue than execute a
      // job with no audit trace.
      await enqueueAssignment(input, {
        projectRoot: ctx.projectRoot,
        tenantId: ctx.tenantId,
      })
      await getQueue(ctx.tenantId).add(
        input.id,
        { assignment: input.assignment },
        { jobId: input.id },
      )
    },

    async drainOnce(opts) {
      const tenant = opts.tenant
      // Pull a snapshot of waiting jobs so this call returns once the
      // current pending set is processed — matches the JSONL drainOnce
      // semantics. A long-running Worker would block; we want the
      // daemon's timer loop to stay in control of cadence.
      const queue = getQueue(tenant.id)
      const waitingJobs = await listDrainableJobs(queue)
      if (waitingJobs.length === 0) return

      // Single-concurrency Worker instantiated for this pass. On each
      // job, we run the caller-supplied runner under tenant scope so
      // audit/span/cost-counter reads see the right tenant — the
      // same contract the JSONL drainer upholds.
      const worker = new Worker<JobPayload>(
        queueName(tenant.id),
        async (job: Job<JobPayload>) => {
          await runWithTenantScope(
            { tenant, correlationId: job.id ?? job.name },
            () =>
              opts.runner({
                id: job.id ?? job.name,
                assignment: job.data.assignment,
                tenant,
              }),
          )
        },
        { ...redisConnectionOpts(), concurrency: 1, autorun: true },
      )

      try {
        await new Promise<void>((resolve, reject) => {
          let remaining = waitingJobs.length
          const onCompleted = async (job: Job<JobPayload>) => {
            try {
              await appendAssignmentStateRecord(
                { id: job.id ?? job.name, state: 'done' },
                { projectRoot: opts.projectRoot, tenantId: tenant.id },
              )
            } catch {
              // JSONL mirror is best-effort; BullMQ is source of
              // truth. Swallow so a disk error doesn't deadlock the
              // queue.
            }
            remaining -= 1
            if (remaining <= 0) resolve()
          }
          const onFailed = async (
            job: Job<JobPayload> | undefined,
            err: Error,
          ) => {
            if (job) {
              try {
                await appendAssignmentStateRecord(
                  { id: job.id ?? job.name, state: 'failed', lastError: err.message },
                  { projectRoot: opts.projectRoot, tenantId: tenant.id },
                )
              } catch {
                // Same best-effort rationale as above.
              }
            }
            remaining -= 1
            if (remaining <= 0) resolve()
          }
          worker.on('completed', onCompleted)
          worker.on('failed', onFailed)
          worker.on('error', err => reject(err))
        })
      } finally {
        await worker.close()
      }
    },

    async recover(ctx) {
      // BullMQ tracks "stalled" jobs itself — if a worker dies mid-
      // job, the job is returned to waiting after its lock expires.
      // We don't need to re-pend anything, but we do surface which
      // ids were stalled so callers can log recovery activity the
      // same way the JSONL backend does.
      const queue = getQueue(ctx.tenantId)
      const active = await queue.getJobs(['active'], 0, -1)
      const recovered: string[] = []
      for (const job of active) {
        // Force-move back to wait. This is only safe because our
        // workers are short-lived (see drainOnce comment above) —
        // a long-running worker would conflict with its own lock.
        try {
          await (job as any).moveToWait('daemon_boot_recovery', job.token ?? '')
          recovered.push(job.id ?? job.name)
        } catch {
          // Job may have been consumed between listing and moving;
          // nothing to recover in that case.
        }
      }
      return recovered
    },

    async close() {
      for (const q of queues.values()) {
        await q.close()
      }
      queues.clear()
    },
  }
}
