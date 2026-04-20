import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadAssignmentQueue, listAssignmentQueueTenants, type AssignmentRecord } from '../assignmentQueue/storage.js'
import { readAuditTail, type AuditEntry } from '../audit/durableAuditLog.js'
import { summarizeAlertDeliveries } from '../alerting/dispatcher.js'
import {
  coordinationModeForQueueBackend,
  type QueueBackendKind,
} from '../assignmentQueue/backend.js'
import { summarizeUsageLedger } from '../billing/usageLedger.js'
import { summarizeInboxStore } from '../email/inboxStore.js'
import { buildSoc2EncryptionArtifact } from '../security/artifacts.js'
import { listConfiguredTenants } from '../../utils/employeeConfig.js'
import {
  DEFAULT_TENANT,
  DEFAULT_TENANT_ID,
  type TenantContext,
} from '../tenant/tenantContext.js'
import { summarizeWorkspaceLifecycle } from '../workspaces/lifecycleLog.js'

export const OUTCOME_DASHBOARD_ROUTE = '/v1/outcomes'

export type HandleOutcomeDashboardOptions = {
  projectRoot: string
  auditDir?: string
  startedAt?: string
  status?: 'ok' | 'draining'
  queueBackendKind?: QueueBackendKind
  scheduledDutyCount?: number
  drainerTenantIds?: string[]
}

type TenantQueueSummary = {
  tenant: { id: string; name: string; role: TenantContext['role'] }
  queue: {
    total: number
    pending: number
    running: number
    done: number
    failed: number
  }
  recentAssignments: Array<{
    id: string
    state: AssignmentRecord['state']
    enqueuedAt: string
    updatedAt: string
    lastError?: string
  }>
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function parseLimit(url: URL, key: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(key)
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

function buildTenantContext(
  id: string,
  configuredTenants: Map<string, TenantContext>,
): TenantContext {
  const configured = configuredTenants.get(id)
  if (configured) return configured
  if (id === DEFAULT_TENANT_ID) return DEFAULT_TENANT
  return { id, name: id, role: 'developer' }
}

function summarizeQueue(
  tenant: TenantContext,
  assignments: AssignmentRecord[],
  recentLimit: number,
): TenantQueueSummary {
  const counts = {
    total: assignments.length,
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
  }
  for (const assignment of assignments) {
    counts[assignment.state] += 1
  }

  const recentAssignments = [...assignments]
    .sort((a, b) => {
      const updated = b.updatedAt.localeCompare(a.updatedAt)
      if (updated !== 0) return updated
      return b.enqueuedAt.localeCompare(a.enqueuedAt)
    })
    .slice(0, recentLimit)
    .map(record => ({
      id: record.id,
      state: record.state,
      enqueuedAt: record.enqueuedAt,
      updatedAt: record.updatedAt,
      ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
    }))

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      role: tenant.role,
    },
    queue: counts,
    recentAssignments,
  }
}

function summarizeAuditKinds(entries: AuditEntry[]): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return a.kind.localeCompare(b.kind)
    })
}

export async function handleOutcomeDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HandleOutcomeDashboardOptions,
): Promise<void> {
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  const url = new URL(req.url ?? OUTCOME_DASHBOARD_ROUTE, 'http://localhost')
  const assignmentLimit = parseLimit(url, 'assignmentLimit', 5, 50)
  const auditLimit = parseLimit(url, 'auditLimit', 25, 200)

  const configuredTenants = new Map(
    (await listConfiguredTenants(opts.projectRoot)).map(tenant => [tenant.id, tenant]),
  )
  const tenantIds = new Set<string>([
    ...configuredTenants.keys(),
    ...listAssignmentQueueTenants(opts.projectRoot),
  ])
  if (tenantIds.size === 0) {
    tenantIds.add(DEFAULT_TENANT_ID)
  }

  const tenantSummaries: TenantQueueSummary[] = []
  for (const tenantId of Array.from(tenantIds).sort()) {
    const tenant = buildTenantContext(tenantId, configuredTenants)
    const assignments = await loadAssignmentQueue(opts.projectRoot, tenantId)
    tenantSummaries.push(summarizeQueue(tenant, assignments, assignmentLimit))
  }

  const totals = tenantSummaries.reduce(
    (acc, summary) => {
      acc.assignments.total += summary.queue.total
      acc.assignments.pending += summary.queue.pending
      acc.assignments.running += summary.queue.running
      acc.assignments.done += summary.queue.done
      acc.assignments.failed += summary.queue.failed
      return acc
    },
    {
      tenantCount: tenantSummaries.length,
      assignments: {
        total: 0,
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
      },
    },
  )

  const recentAudit = readAuditTail(
    auditLimit,
    opts.auditDir ? { dir: opts.auditDir } : undefined,
  )
  const inbox = summarizeInboxStore(opts.projectRoot, { recentLimit: 5 })
  const billing = summarizeUsageLedger(opts.projectRoot, { recentLimit: 5 })
  const alerts = summarizeAlertDeliveries(opts.projectRoot, { recentLimit: 10 })
  const workspaces = summarizeWorkspaceLifecycle(opts.projectRoot, {
    recentLimit: 10,
  })
  const security = buildSoc2EncryptionArtifact()

  writeJson(res, 200, {
    generatedAt: new Date().toISOString(),
    status: opts.status ?? 'ok',
    projectRoot: opts.projectRoot,
    ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
    ...(opts.queueBackendKind
      ? {
          queueBackend: {
            kind: opts.queueBackendKind,
            coordinationMode: coordinationModeForQueueBackend(
              opts.queueBackendKind,
            ),
          },
        }
      : {}),
    ...(opts.scheduledDutyCount !== undefined
      ? { liveScheduler: { scheduledDutyCount: opts.scheduledDutyCount, drainerTenantIds: opts.drainerTenantIds ?? [] } }
      : {}),
    totals,
    recentAuditKinds: summarizeAuditKinds(recentAudit),
    recentAudit,
    inbox: {
      tenantCount: inbox.length,
      employeeCount: inbox.reduce((sum, tenant) => sum + tenant.employeeCount, 0),
      messageCount: inbox.reduce((sum, tenant) => sum + tenant.messageCount, 0),
      tenants: inbox,
    },
    billing,
    alerts,
    workspaceLifecycle: workspaces,
    security,
    tenants: tenantSummaries,
  })
}
