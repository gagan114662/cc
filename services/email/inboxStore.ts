import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { appendEncryptedJsonlRecord, buildEncryptionArtifact, readEncryptedJsonl } from '../security/encryptedJsonl.js'
import {
  DEFAULT_TENANT,
  DEFAULT_TENANT_ID,
  type TenantContext,
} from '../tenant/tenantContext.js'
import { currentTenantContext } from '../tenant/tenantScope.js'

const INBOX_DIR_NAME = 'employee-inbox'
const TENANTS_DIR_NAME = 'tenants'

export type InboxMessageRecord = {
  id: string
  tenantId: string
  employee: string
  from: string
  to: string
  subject: string
  receivedAt: string
  message: string
}

export type InboxWriteOptions = {
  projectRoot?: string
  tenantId?: string
  encryptionKey?: string
}

function resolveTenantId(tenantId?: string): string {
  if (tenantId !== undefined) return tenantId
  return currentTenantContext().id
}

function normalizeEmployeeId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  return normalized || 'inbox'
}

function inboxDirectory(
  projectRoot?: string,
  tenantId?: string,
): string {
  const root = projectRoot ?? getProjectRoot()
  const resolved = resolveTenantId(tenantId)
  if (resolved === DEFAULT_TENANT_ID) {
    return path.join(root, '.claude', INBOX_DIR_NAME)
  }
  return path.join(root, '.claude', TENANTS_DIR_NAME, resolved, INBOX_DIR_NAME)
}

export function getEmployeeInboxPath(
  employee: string,
  projectRoot?: string,
  tenantId?: string,
): string {
  return path.join(
    inboxDirectory(projectRoot, tenantId),
    `${normalizeEmployeeId(employee)}.jsonl`,
  )
}

export function appendInboxMessage(
  record: InboxMessageRecord,
  opts: InboxWriteOptions = {},
): void {
  appendEncryptedJsonlRecord(
    getEmployeeInboxPath(record.employee, opts.projectRoot, opts.tenantId ?? record.tenantId),
    record,
    opts.encryptionKey ? { key: opts.encryptionKey } : undefined,
  )
}

export function loadEmployeeInbox(
  employee: string,
  opts: InboxWriteOptions = {},
): InboxMessageRecord[] {
  return readEncryptedJsonl<InboxMessageRecord>(
    getEmployeeInboxPath(employee, opts.projectRoot, opts.tenantId),
    opts.encryptionKey ? { key: opts.encryptionKey } : undefined,
  )
}

export function listInboxTenants(projectRoot?: string): string[] {
  const root = projectRoot ?? getProjectRoot()
  const tenants = new Set<string>()
  const defaultDir = inboxDirectory(root, DEFAULT_TENANT_ID)
  if (existsSync(defaultDir)) tenants.add(DEFAULT_TENANT_ID)

  const tenantsDir = path.join(root, '.claude', TENANTS_DIR_NAME)
  try {
    for (const entry of readdirSync(tenantsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = inboxDirectory(root, entry.name)
      if (existsSync(dir)) tenants.add(entry.name)
    }
  } catch {
    // No tenant inboxes yet.
  }

  return Array.from(tenants).sort()
}

export type InboxTenantSummary = {
  tenant: { id: string; name: string; role: TenantContext['role'] }
  employeeCount: number
  messageCount: number
  recentMessages: Array<{
    id: string
    employee: string
    subject: string
    from: string
    receivedAt: string
  }>
}

function buildTenantContext(id: string): TenantContext {
  if (id === DEFAULT_TENANT_ID) return DEFAULT_TENANT
  return { id, name: id, role: 'developer' }
}

export function summarizeInboxStore(
  projectRoot?: string,
  opts: { recentLimit?: number; encryptionKey?: string } = {},
): InboxTenantSummary[] {
  const root = projectRoot ?? getProjectRoot()
  const recentLimit = Math.max(1, opts.recentLimit ?? 5)
  const summaries: InboxTenantSummary[] = []

  for (const tenantId of listInboxTenants(root)) {
    const dir = inboxDirectory(root, tenantId)
    const files = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(entry => entry.name)
      .sort()
    const messages = files.flatMap(file =>
      readEncryptedJsonl<InboxMessageRecord>(
        path.join(dir, file),
        opts.encryptionKey ? { key: opts.encryptionKey } : undefined,
      ),
    )
    const recentMessages = [...messages]
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, recentLimit)
      .map(message => ({
        id: message.id,
        employee: message.employee,
        subject: message.subject,
        from: message.from,
        receivedAt: message.receivedAt,
      }))
    summaries.push({
      tenant: buildTenantContext(tenantId),
      employeeCount: files.length,
      messageCount: messages.length,
      recentMessages,
    })
  }

  return summaries
}

export function buildInboxSecurityArtifact(now?: () => Date): {
  generatedAt: string
  encryptionAtRest: {
    enabled: boolean
    env: string
    algorithm: string
    coveredStores: string[]
  }
} {
  return buildEncryptionArtifact({
    now,
    coveredStores: ['employee-inbox'],
  })
}
