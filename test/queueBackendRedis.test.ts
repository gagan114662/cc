// Integration tests for the BullMQ-backed queue backend.
//
// Runs when REDIS_URL is set AND points to a reachable Redis. Skipped
// otherwise — this matches our CI posture: mainline CI stays zero-
// infra, while operators validating multi-daemon setups locally
// point REDIS_URL at a running instance and re-run the suite to
// confirm the shared-substrate path still works.
//
// Tests cover the only guarantees a caller actually depends on:
//   - enqueue then drain consumes the job exactly once
//   - a runner throw marks the job failed in the JSONL state mirror
//   - the second daemon's recover() picks up nothing after clean
//     shutdown (the happy-path absence of false recoveries)

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import IORedis from 'ioredis'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  __resetQueueBackendForTest,
  getQueueBackend,
} from 'src/services/assignmentQueue/backend.js'
import { loadAssignmentQueue } from 'src/services/assignmentQueue/storage.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'

const REDIS_URL = process.env.REDIS_URL
const describeIfRedis = REDIS_URL ? describe : describe.skip

let projectRoot: string
let flushClient: IORedis | null = null

const ORIGINAL_BACKEND = process.env.CC_QUEUE_BACKEND

beforeAll(async () => {
  if (!REDIS_URL) return
  process.env.CC_QUEUE_BACKEND = 'redis'
  // Full wipe before the suite runs so any leftover state from a
  // previous aborted run can't cross-contaminate the assertions.
  flushClient = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
  await flushClient.flushdb()
})

afterAll(async () => {
  if (ORIGINAL_BACKEND === undefined) delete process.env.CC_QUEUE_BACKEND
  else process.env.CC_QUEUE_BACKEND = ORIGINAL_BACKEND
  if (flushClient) await flushClient.quit()
})

beforeEach(async () => {
  __resetQueueBackendForTest()
  projectRoot = path.join(
    tmpdir(),
    `cc-redis-backend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(projectRoot, { recursive: true })
})

afterEach(async () => {
  const backend = await getQueueBackend()
  await backend.close()
  __resetQueueBackendForTest()
  if (flushClient) await flushClient.flushdb()
  await rm(projectRoot, { recursive: true, force: true })
})

describeIfRedis('BullMQ queue backend (needs REDIS_URL)', () => {
  test('enqueue → drainOnce runs the runner exactly once and writes done to JSONL mirror', async () => {
    const backend = await getQueueBackend()
    expect(backend.kind).toBe('redis')

    const seen: string[] = []
    await backend.enqueue(
      { id: 'asg-one', assignment: 'write tests' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )

    await backend.drainOnce({
      projectRoot,
      tenant: DEFAULT_TENANT,
      runner: async input => {
        seen.push(input.id)
      },
    })

    expect(seen).toEqual(['asg-one'])

    // A second drain pass should not re-run the completed job.
    await backend.drainOnce({
      projectRoot,
      tenant: DEFAULT_TENANT,
      runner: async input => {
        seen.push(input.id)
      },
    })
    expect(seen).toEqual(['asg-one'])

    // The JSONL mirror should have a 'done' record for auditability.
    // BullMQ is the queue source of truth; JSONL is where the audit
    // trail lives alongside every other durable log.
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    const done = queue.find(r => r.id === 'asg-one')
    expect(done?.state).toBe('done')
  })

  test('runner throw marks the job failed in JSONL with the error message', async () => {
    const backend = await getQueueBackend()

    await backend.enqueue(
      { id: 'asg-fail', assignment: 'explode please' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )

    await backend.drainOnce({
      projectRoot,
      tenant: DEFAULT_TENANT,
      runner: async () => {
        throw new Error('simulated_runner_failure')
      },
    })

    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    const rec = queue.find(r => r.id === 'asg-fail')
    expect(rec?.state).toBe('failed')
    expect(rec?.lastError).toContain('simulated_runner_failure')
  })

  test('recover() on a clean queue returns no ids', async () => {
    const backend = await getQueueBackend()
    const recovered = await backend.recover({
      projectRoot,
      tenantId: DEFAULT_TENANT.id,
    })
    expect(recovered).toEqual([])
  })
})
