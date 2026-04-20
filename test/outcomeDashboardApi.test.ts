import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startDaemon, stopDaemon } from 'src/entrypoints/daemon.js'
import {
  appendAssignmentStateRecord,
  enqueueAssignment,
} from 'src/services/assignmentQueue/storage.js'
import { writeAuditEntry } from 'src/services/audit/durableAuditLog.js'
import {
  GITHUB_WEBHOOK_QUEUED_AUDIT_KIND,
} from 'src/services/webhooks/githubRoute.js'
import {
  SLACK_WEBHOOK_IGNORED_AUDIT_KIND,
} from 'src/services/webhooks/slackRoute.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'

let projectRoot: string
let auditDir: string

async function writeEmployeeConfig(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    JSON.stringify(
      {
        role: 'engineering-lead',
        goals: [],
        defaultAutonomy: 'full-operator',
        delegationMode: 'team',
        verificationRequired: true,
        recurringDuties: [],
      },
      null,
      2,
    ),
  )
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

beforeEach(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  projectRoot = path.join(tmpdir(), `cc-outcomes-${suffix}`)
  auditDir = path.join(tmpdir(), `cc-outcomes-audit-${suffix}`)
  await mkdir(projectRoot, { recursive: true })
  await mkdir(auditDir, { recursive: true })

  await writeEmployeeConfig(path.join(projectRoot, '.claude', 'employee.json'))
  await writeEmployeeConfig(
    path.join(projectRoot, '.claude', 'tenants', 'acme', 'employee.json'),
  )

  await enqueueAssignment(
    { id: 'default-done', assignment: 'close loop for default tenant' },
    { projectRoot, tenantId: DEFAULT_TENANT.id },
  )
  await appendAssignmentStateRecord(
    { id: 'default-done', state: 'done' },
    { projectRoot, tenantId: DEFAULT_TENANT.id },
  )

  await enqueueAssignment(
    { id: 'acme-failed', assignment: 'handle acme failure' },
    { projectRoot, tenantId: 'acme' },
  )
  await appendAssignmentStateRecord(
    {
      id: 'acme-failed',
      state: 'failed',
      lastError: 'simulated failure',
    },
    { projectRoot, tenantId: 'acme' },
  )

  await enqueueAssignment(
    { id: 'globex-pending', assignment: 'queue only tenant still shows up' },
    { projectRoot, tenantId: 'globex' },
  )

  writeAuditEntry(
    {
      ts: '2026-04-20T10:00:00.000Z',
      kind: GITHUB_WEBHOOK_QUEUED_AUDIT_KIND,
      assignmentId: 'default-done',
    },
    { dir: auditDir, tenant: DEFAULT_TENANT },
  )
  writeAuditEntry(
    {
      ts: '2026-04-20T10:01:00.000Z',
      kind: SLACK_WEBHOOK_IGNORED_AUDIT_KIND,
      event: 'reaction_added',
    },
    {
      dir: auditDir,
      tenant: { id: 'acme', name: 'acme', role: 'developer' },
    },
  )
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(auditDir, { recursive: true, force: true })
})

describe('GET /v1/outcomes', () => {
  test('rolls up queue state and recent audit activity across configured and queue-only tenants', async () => {
    const daemon = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'does-not-exist-cli.js'),
      once: false,
      auditDir,
    })

    try {
      const { status, body } = await fetchJson(
        `http://127.0.0.1:${daemon.args.port}/v1/outcomes?assignmentLimit=1&auditLimit=10`,
      )

      expect(status).toBe(200)
      expect(body.status).toBe('ok')
      expect(body.projectRoot).toBe(projectRoot)
      expect(body.totals.tenantCount).toBe(3)
      expect(body.totals.assignments).toEqual({
        total: 3,
        pending: 1,
        running: 0,
        done: 1,
        failed: 1,
      })
      expect(body.liveScheduler.scheduledDutyCount).toBe(0)
      expect([...body.liveScheduler.drainerTenantIds].sort()).toEqual([
        'acme',
        'default',
        'globex',
      ])

      const tenantIds = body.tenants.map((t: { tenant: { id: string } }) => t.tenant.id)
      expect(tenantIds).toEqual(['acme', 'default', 'globex'])

      const globex = body.tenants.find(
        (t: { tenant: { id: string } }) => t.tenant.id === 'globex',
      )
      expect(globex.tenant.role).toBe('developer')
      expect(globex.queue.pending).toBe(1)
      expect(globex.recentAssignments).toHaveLength(1)

      const auditKinds = body.recentAuditKinds.map(
        (entry: { kind: string }) => entry.kind,
      )
      expect(auditKinds).toContain(GITHUB_WEBHOOK_QUEUED_AUDIT_KIND)
      expect(auditKinds).toContain(SLACK_WEBHOOK_IGNORED_AUDIT_KIND)
    } finally {
      await stopDaemon(daemon, 'test-cleanup')
    }
  })

  test('POST is rejected with 405', async () => {
    const daemon = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'does-not-exist-cli.js'),
      once: false,
      auditDir,
    })

    try {
      const { status, body } = await fetchJson(
        `http://127.0.0.1:${daemon.args.port}/v1/outcomes`,
        { method: 'POST' },
      )
      expect(status).toBe(405)
      expect(body.error).toBe('method_not_allowed')
    } finally {
      await stopDaemon(daemon, 'test-cleanup')
    }
  })
})
