// Phase 3 distributed worker coordination proof.
//
// Runs only when REDIS_URL is set. It exercises the daemon seam, not
// just the raw backend: one daemon accepts work over HTTP onto a Redis
// queue, a second daemon drains that shared queue, and the JSONL mirror
// still reflects the resulting done state. This is the operator-facing
// guarantee the roadmap item actually cares about.

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
import { startDaemon, stopDaemon } from 'src/entrypoints/daemon.js'
import { createRedisQueueBackend } from 'src/services/assignmentQueue/backends/redis.js'
import { loadAssignmentQueue } from 'src/services/assignmentQueue/storage.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'

type DaemonHandle = Awaited<ReturnType<typeof startDaemon>>

const REDIS_URL = process.env.REDIS_URL
const describeIfRedis = REDIS_URL ? describe : describe.skip

let projectRoot: string
let auditDir: string
let flushClient: IORedis | null = null

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 4_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

beforeAll(async () => {
  if (!REDIS_URL) return
  flushClient = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
  await flushClient.flushdb()
})

afterAll(async () => {
  if (flushClient) await flushClient.quit()
})

beforeEach(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  projectRoot = path.join(tmpdir(), `cc-distributed-queue-${suffix}`)
  auditDir = path.join(tmpdir(), `cc-distributed-queue-audit-${suffix}`)
  await mkdir(projectRoot, { recursive: true })
  await mkdir(auditDir, { recursive: true })
})

afterEach(async () => {
  if (flushClient) await flushClient.flushdb()
  await rm(projectRoot, { recursive: true, force: true })
  await rm(auditDir, { recursive: true, force: true })
})

describeIfRedis('daemon distributed queue coordination (needs REDIS_URL)', () => {
  test('one daemon can accept while a second daemon drains the shared queue', async () => {
    const acceptedByA: string[] = []
    const drainedByB: string[] = []

    const daemonA = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'missing-cli.js'),
      once: false,
      auditDir,
      disableDrainer: true,
      assignmentRunner: async input => {
        acceptedByA.push(input.id)
      },
      queueBackend: createRedisQueueBackend(),
    })

    const daemonB = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'missing-cli.js'),
      once: false,
      auditDir,
      drainIntervalMs: 50,
      assignmentRunner: async input => {
        drainedByB.push(input.id)
      },
      queueBackend: createRedisQueueBackend(),
    })

    try {
      const { status, body } = await fetchJson(
        `http://127.0.0.1:${daemonA.args.port}/v1/employee/assign`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assignment: 'drain this from the other daemon' }),
        },
      )
      expect(status).toBe(202)

      const assignmentId = body.id as string
      const finalState = await waitFor(async () => {
        const records = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
        const match = records.find(r => r.id === assignmentId)
        if (!match) return null
        return match.state === 'done' ? match.state : null
      })

      expect(finalState).toBe('done')
      expect(acceptedByA).toEqual([])
      expect(drainedByB).toEqual([assignmentId])

      const outcomes = await fetchJson(
        `http://127.0.0.1:${daemonA.args.port}/v1/outcomes?assignmentLimit=5&auditLimit=5`,
      )
      expect(outcomes.status).toBe(200)
      expect(outcomes.body.queueBackend).toEqual({
        kind: 'redis',
        coordinationMode: 'shared-substrate',
      })
      expect(outcomes.body.liveScheduler.drainerTenantIds).toEqual([
        DEFAULT_TENANT.id,
      ])
    } finally {
      await stopDaemon(daemonA, 'test-cleanup-a')
      await stopDaemon(daemonB, 'test-cleanup-b')
    }
  })

  test('two active drainers coordinate so each assignment runs exactly once', async () => {
    const processed: string[] = []

    const daemonA = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'missing-cli.js'),
      once: false,
      auditDir,
      drainIntervalMs: 40,
      assignmentRunner: async input => {
        processed.push(`a:${input.id}`)
      },
      queueBackend: createRedisQueueBackend(),
    })

    const daemonB = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'missing-cli.js'),
      once: false,
      auditDir,
      drainIntervalMs: 40,
      assignmentRunner: async input => {
        processed.push(`b:${input.id}`)
      },
      queueBackend: createRedisQueueBackend(),
    })

    try {
      const submittedIds: string[] = []
      for (const assignment of [
        'first shared assignment',
        'second shared assignment',
        'third shared assignment',
      ]) {
        const res = await fetchJson(
          `http://127.0.0.1:${daemonA.args.port}/v1/employee/assign`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ assignment }),
          },
        )
        expect(res.status).toBe(202)
        submittedIds.push(res.body.id as string)
      }

      await waitFor(async () => {
        const records = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
        const allDone = submittedIds.every(id =>
          records.some(record => record.id === id && record.state === 'done'),
        )
        return allDone ? true : null
      })

      await new Promise(resolve => setTimeout(resolve, 150))

      expect(processed).toHaveLength(3)
      expect(
        new Set(processed.map(entry => entry.split(':', 2)[1])),
      ).toEqual(new Set(submittedIds))
    } finally {
      await stopDaemon(daemonA, 'test-cleanup-a')
      await stopDaemon(daemonB, 'test-cleanup-b')
    }
  })
})
