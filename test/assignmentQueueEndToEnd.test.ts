// End-to-end: HTTP POST → durable queue → daemon drainer → done state.
//
// Pins the Phase 2 item 3 contract at the daemon integration layer:
//   (1) A successful POST /v1/employee/assign enqueues the assignment
//       in the tenant's queue file (durable on disk — survives crash).
//   (2) The daemon's per-tenant drainer picks up the pending entry and
//       runs the injected runner under the correct tenant scope.
//   (3) The queue file records pending → running → done transitions.
//   (4) Crash recovery: a queue that was left in 'running' on boot is
//       re-pended and re-run by the drainer (no orphaned assignments).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  startDaemon,
  stopDaemon,
} from 'src/entrypoints/daemon.js'
import { loadAssignmentQueue } from 'src/services/assignmentQueue/storage.js'
import type { AssignmentRunner } from 'src/services/assignmentQueue/drainer.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'

type DaemonHandle = Awaited<ReturnType<typeof startDaemon>>

let projectRoot: string
let auditDir: string
let daemon: DaemonHandle | null = null

beforeEach(async () => {
  projectRoot = path.join(
    tmpdir(),
    `cc-queue-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  auditDir = path.join(projectRoot, '.audit')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(auditDir, { recursive: true })
})

afterEach(async () => {
  if (daemon) {
    await stopDaemon(daemon, 'test-cleanup')
    daemon = null
  }
  await rm(projectRoot, { recursive: true, force: true })
})

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await probe()
    if (v !== null) return v
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

describe('HTTP → durable queue → drain (end-to-end)', () => {
  test('POST /v1/employee/assign enqueues and drainer runs it', async () => {
    const seen: string[] = []
    const runner: AssignmentRunner = async input => {
      seen.push(input.id)
    }

    daemon = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'dist', 'cli.js'),
      once: false,
      auditDir,
      drainIntervalMs: 50,
      assignmentRunner: runner,
    })

    const port = daemon.args.port
    const res = await fetch(`http://127.0.0.1:${port}/v1/employee/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignment: 'ship the thing' }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { id: string; status: string }
    expect(body.status).toBe('accepted')
    const assignedId = body.id

    // Wait for the drainer to pick up and mark done.
    const finalState = await waitFor(async () => {
      const records = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
      const match = records.find(r => r.id === assignedId)
      if (!match) return null
      return match.state === 'done' ? match.state : null
    })
    expect(finalState).toBe('done')
    expect(seen).toEqual([assignedId])
  })

  test('crash recovery: running assignment on boot re-runs exactly once', async () => {
    // Seed a queue file where assignment "crashed-1" was stuck mid-run.
    // On boot, recoverCrashedAssignments flips it to pending, then the
    // drainer picks it up and runs it to done.
    const queueDir = path.join(projectRoot, '.claude')
    mkdirSync(queueDir, { recursive: true })
    const queuePath = path.join(queueDir, 'assignments-queue.jsonl')
    writeFileSync(queuePath, '', 'utf-8')
    appendFileSync(
      queuePath,
      JSON.stringify({
        kind: 'enqueue',
        id: 'crashed-1',
        assignment: 'resume me',
        ts: '2026-04-19T00:00:00.000Z',
      }) + '\n',
    )
    appendFileSync(
      queuePath,
      JSON.stringify({
        kind: 'state',
        id: 'crashed-1',
        state: 'running',
        ts: '2026-04-19T00:00:01.000Z',
      }) + '\n',
    )

    const runs: string[] = []
    const runner: AssignmentRunner = async input => {
      runs.push(input.id)
    }

    daemon = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'dist', 'cli.js'),
      once: false,
      auditDir,
      drainIntervalMs: 50,
      assignmentRunner: runner,
    })

    const done = await waitFor(async () => {
      const records = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
      const match = records.find(r => r.id === 'crashed-1')
      if (!match) return null
      return match.state === 'done' ? match.state : null
    })
    expect(done).toBe('done')
    // Exactly one re-run — not zero (recovery forgot it), not two
    // (recovery double-enqueued).
    expect(runs).toEqual(['crashed-1'])
  })

  test('runner throw → state=failed with error message', async () => {
    const runner: AssignmentRunner = async () => {
      throw new Error('drainer_fake_failure')
    }

    daemon = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'dist', 'cli.js'),
      once: false,
      auditDir,
      drainIntervalMs: 50,
      assignmentRunner: runner,
    })

    const port = daemon.args.port
    const res = await fetch(`http://127.0.0.1:${port}/v1/employee/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignment: 'this will throw' }),
    })
    const { id } = (await res.json()) as { id: string }

    const failed = await waitFor(async () => {
      const records = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
      const match = records.find(r => r.id === id)
      if (!match) return null
      return match.state === 'failed' ? match : null
    })
    expect(failed.state).toBe('failed')
    expect(failed.lastError).toBe('drainer_fake_failure')
  })
})
