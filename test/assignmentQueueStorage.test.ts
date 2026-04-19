// Durable assignment queue — storage contract (Phase 2 item 3).
//
// The queue is tenant-scoped JSONL under
//   DEFAULT_TENANT → .claude/assignments-queue.jsonl
//   named tenant  → .claude/tenants/<id>/assignments-queue.jsonl
// mirroring item 2's layout. Records are append-only; reading folds the
// per-id state so a crash between two writes leaves the last durable
// state intact.
//
// Contract pinned here:
//   - getAssignmentQueuePath respects scope (same resolution order as
//     employeeConfig)
//   - enqueue + state transitions round-trip through the folded reader
//   - recoverCrashedAssignments flips 'running' to 'pending' on boot
//     (crash-recovery invariant — an assignment that was executing when
//      the daemon died must be retried, not orphaned)
//   - Two tenants are fully isolated on disk
//
// These assertions fail before services/assignmentQueue exists.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appendAssignmentStateRecord,
  enqueueAssignment,
  getAssignmentQueuePath,
  loadAssignmentQueue,
  recoverCrashedAssignments,
} from 'src/services/assignmentQueue/storage.js'
import {
  DEFAULT_TENANT,
  type TenantContext,
} from 'src/services/tenant/tenantContext.js'
import { runWithTenantScope } from 'src/services/tenant/tenantScope.js'

let projectRoot: string
const ACME: TenantContext = { id: 'acme', name: 'Acme', role: 'developer' }
const GLOBEX: TenantContext = { id: 'globex', name: 'Globex', role: 'developer' }

beforeEach(async () => {
  projectRoot = path.join(
    tmpdir(),
    `cc-queue-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(projectRoot, { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('getAssignmentQueuePath', () => {
  test('DEFAULT_TENANT → legacy .claude/assignments-queue.jsonl', () => {
    const p = getAssignmentQueuePath(projectRoot, DEFAULT_TENANT.id)
    expect(p).toBe(path.join(projectRoot, '.claude', 'assignments-queue.jsonl'))
  })

  test('named tenant → .claude/tenants/<id>/assignments-queue.jsonl', () => {
    const p = getAssignmentQueuePath(projectRoot, ACME.id)
    expect(p).toBe(
      path.join(projectRoot, '.claude', 'tenants', 'acme', 'assignments-queue.jsonl'),
    )
  })

  test('omitted tenantId reads from active scope', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => {
      expect(getAssignmentQueuePath(projectRoot)).toBe(
        path.join(projectRoot, '.claude', 'tenants', 'acme', 'assignments-queue.jsonl'),
      )
    })
  })
})

describe('enqueue + load round-trip', () => {
  test('DEFAULT_TENANT: enqueue writes a pending record', async () => {
    await runWithTenantScope({ tenant: DEFAULT_TENANT }, async () => {
      await enqueueAssignment(
        { id: 'a-1', assignment: 'refactor the widget' },
        { projectRoot },
      )
    })
    expect(
      existsSync(path.join(projectRoot, '.claude', 'assignments-queue.jsonl')),
    ).toBe(true)

    const loaded = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(loaded.length).toBe(1)
    expect(loaded[0]!.id).toBe('a-1')
    expect(loaded[0]!.state).toBe('pending')
    expect(loaded[0]!.assignment).toBe('refactor the widget')
  })

  test('state transitions fold — last state wins', async () => {
    await enqueueAssignment(
      { id: 'a-1', assignment: 'ok' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )
    await appendAssignmentStateRecord(
      { id: 'a-1', state: 'running' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )
    await appendAssignmentStateRecord(
      { id: 'a-1', state: 'done' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )

    const loaded = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(loaded.length).toBe(1)
    expect(loaded[0]!.state).toBe('done')
  })

  test('failed state carries the error message for later inspection', async () => {
    await enqueueAssignment(
      { id: 'a-1', assignment: 'ok' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )
    await appendAssignmentStateRecord(
      { id: 'a-1', state: 'failed', lastError: 'runner_threw: boom' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )

    const loaded = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(loaded[0]!.state).toBe('failed')
    expect(loaded[0]!.lastError).toBe('runner_threw: boom')
  })

  test('two tenants write to independent files', async () => {
    await enqueueAssignment(
      { id: 'acme-1', assignment: 'acme-work' },
      { projectRoot, tenantId: ACME.id },
    )
    await enqueueAssignment(
      { id: 'globex-1', assignment: 'globex-work' },
      { projectRoot, tenantId: GLOBEX.id },
    )

    const acmeIds = (await loadAssignmentQueue(projectRoot, ACME.id)).map(r => r.id)
    const globexIds = (await loadAssignmentQueue(projectRoot, GLOBEX.id)).map(r => r.id)
    expect(acmeIds).toEqual(['acme-1'])
    expect(globexIds).toEqual(['globex-1'])

    const acmePath = path.join(projectRoot, '.claude', 'tenants', 'acme', 'assignments-queue.jsonl')
    const globexPath = path.join(projectRoot, '.claude', 'tenants', 'globex', 'assignments-queue.jsonl')
    const acmeRaw = await readFile(acmePath, 'utf-8')
    const globexRaw = await readFile(globexPath, 'utf-8')
    expect(acmeRaw.includes('globex-work')).toBe(false)
    expect(globexRaw.includes('acme-work')).toBe(false)
  })
})

describe('recoverCrashedAssignments', () => {
  test('flips running → pending (crash-recovery invariant)', async () => {
    await enqueueAssignment(
      { id: 'a-1', assignment: 'x' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )
    await appendAssignmentStateRecord(
      { id: 'a-1', state: 'running' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )

    const recovered = await recoverCrashedAssignments(projectRoot, DEFAULT_TENANT.id)
    expect(recovered).toEqual(['a-1'])

    const loaded = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(loaded[0]!.state).toBe('pending')
  })

  test('does NOT touch done or failed assignments', async () => {
    await enqueueAssignment(
      { id: 'done-1', assignment: 'x' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )
    await appendAssignmentStateRecord(
      { id: 'done-1', state: 'done' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )
    await enqueueAssignment(
      { id: 'failed-1', assignment: 'x' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )
    await appendAssignmentStateRecord(
      { id: 'failed-1', state: 'failed', lastError: 'nope' },
      { projectRoot, tenantId: DEFAULT_TENANT.id },
    )

    const recovered = await recoverCrashedAssignments(projectRoot, DEFAULT_TENANT.id)
    expect(recovered).toEqual([])

    const loaded = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    const byId = Object.fromEntries(loaded.map(r => [r.id, r.state]))
    expect(byId['done-1']).toBe('done')
    expect(byId['failed-1']).toBe('failed')
  })

  test('returns [] when no queue file exists yet', async () => {
    const recovered = await recoverCrashedAssignments(projectRoot, 'never-written')
    expect(recovered).toEqual([])
  })
})
