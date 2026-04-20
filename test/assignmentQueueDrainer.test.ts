// Drainer — the worker that consumes pending queue entries (Phase 2 item 3).
//
// Contract pinned here:
//   - drainOnce picks up every pending assignment, marks running,
//     invokes the runner, then marks done or failed
//   - runner is called under runWithTenantScope so deep calls (audit,
//     spans, cost counters) see the right tenant
//   - runner exceptions land as state='failed' with the error message
//     persisted; the drainer keeps going for other assignments
//   - two tenants in the same project root don't cross-drain each other
//   - drainer is single-flight: a long-running runner does not block
//     the scope of another tenant's concurrent drain
//
// These tests drive drainOnce directly (not a polling loop) so we can
// assert deterministic state without sleeping.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { currentTenantContext } from 'src/services/tenant/tenantScope.js'
import {
  DEFAULT_TENANT,
  type TenantContext,
} from 'src/services/tenant/tenantContext.js'
import {
  enqueueAssignment,
  loadAssignmentQueue,
} from 'src/services/assignmentQueue/storage.js'
import { drainOnce } from 'src/services/assignmentQueue/drainer.js'

const ACME: TenantContext = { id: 'acme', name: 'Acme', role: 'developer' }
const GLOBEX: TenantContext = { id: 'globex', name: 'Globex', role: 'developer' }

let projectRoot: string

beforeEach(async () => {
  projectRoot = path.join(
    tmpdir(),
    `cc-drainer-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(projectRoot, { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('drainOnce', () => {
  test('happy path: pending → running → done, runner invoked once', async () => {
    await enqueueAssignment(
      { id: 'a-1', assignment: 'do the thing' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )

    const runnerCalls: Array<{ id: string; assignment: string; tenantId: string }> = []
    const runner = async (input: {
      id: string
      assignment: string
      tenant: TenantContext
    }): Promise<void> => {
      runnerCalls.push({
        id: input.id,
        assignment: input.assignment,
        tenantId: input.tenant.id,
      })
    }

    await drainOnce({
      projectRoot,
      tenant: DEFAULT_TENANT,
      runner,
    })

    expect(runnerCalls.length).toBe(1)
    expect(runnerCalls[0].id).toBe('a-1')
    expect(runnerCalls[0].tenantId).toBe(DEFAULT_TENANT.id)

    const loaded = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(loaded[0].state).toBe('done')
  })

  test('runner throws → state=failed with error message', async () => {
    await enqueueAssignment(
      { id: 'a-fail', assignment: 'x' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )

    const runner = async (): Promise<void> => {
      throw new Error('runner_boom')
    }

    await drainOnce({ projectRoot, tenant: DEFAULT_TENANT, runner })

    const loaded = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(loaded[0].state).toBe('failed')
    expect(loaded[0].lastError).toBe('runner_boom')
  })

  test('one failure does NOT block the next pending assignment in the same drain', async () => {
    await enqueueAssignment(
      { id: 'a-fail', assignment: 'boom' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )
    await enqueueAssignment(
      { id: 'a-ok', assignment: 'ok' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )

    const runner = async (input: { id: string }): Promise<void> => {
      if (input.id === 'a-fail') throw new Error('boom')
    }

    await drainOnce({ projectRoot, tenant: DEFAULT_TENANT, runner })

    const loaded = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    const byId = Object.fromEntries(loaded.map(r => [r.id, r.state]))
    expect(byId['a-fail']).toBe('failed')
    expect(byId['a-ok']).toBe('done')
  })

  test('runner sees the active tenant scope (concurrent tenants do not leak)', async () => {
    await enqueueAssignment(
      { id: 'acme-1', assignment: 'acme-work' },
      { projectRoot, tenantId: ACME.id },
    )
    await enqueueAssignment(
      { id: 'globex-1', assignment: 'globex-work' },
      { projectRoot, tenantId: GLOBEX.id },
    )

    const seenByRunner: Array<{ id: string; scopedTenantId: string }> = []
    // Runner reads currentTenantContext() — if the drainer forgot to
    // wrap in runWithTenantScope, this would leak the process default.
    const runner = async (input: { id: string }): Promise<void> => {
      const scoped = currentTenantContext()
      seenByRunner.push({ id: input.id, scopedTenantId: scoped.id })
    }

    await Promise.all([
      drainOnce({ projectRoot, tenant: ACME, runner }),
      drainOnce({ projectRoot, tenant: GLOBEX, runner }),
    ])

    // Each runner must have seen the correct tenant, regardless of
    // which tenant's drain ran first.
    const byId = Object.fromEntries(seenByRunner.map(s => [s.id, s.scopedTenantId]))
    expect(byId['acme-1']).toBe('acme')
    expect(byId['globex-1']).toBe('globex')
  })

  test('already-done assignments are not re-run', async () => {
    await enqueueAssignment(
      { id: 'a-1', assignment: 'x' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )
    const runner = async (): Promise<void> => {
      /* done on first call */
    }
    await drainOnce({ projectRoot, tenant: DEFAULT_TENANT, runner })

    let secondCalls = 0
    const failRunner = async (): Promise<void> => {
      secondCalls += 1
      throw new Error('should-not-run')
    }
    await drainOnce({ projectRoot, tenant: DEFAULT_TENANT, runner: failRunner })
    expect(secondCalls).toBe(0)
  })
})
