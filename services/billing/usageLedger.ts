import { type BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { appendEncryptedJsonlRecord, buildEncryptionArtifact, readEncryptedJsonl } from '../security/encryptedJsonl.js'
import {
  DEFAULT_TENANT,
  DEFAULT_TENANT_ID,
  type TenantContext,
} from '../tenant/tenantContext.js'

const BILLING_LEDGER_FILE_NAME = 'billing-usage.jsonl'
const TENANTS_DIR_NAME = 'tenants'

export const BILLING_STRIPE_DELIVERED_AUDIT_KIND = 'billing.stripe.delivered'
export const BILLING_STRIPE_FAILED_AUDIT_KIND = 'billing.stripe.failed'

export type UsageLedgerRecord = {
  ts: string
  tenantId: string
  subjectKind: 'session' | 'duty' | 'assignment'
  subjectId: string
  sessionId: string
  model: string
  costUSD: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
}

export type UsageLedgerWriteOptions = {
  projectRoot?: string
  tenantId?: string
  encryptionKey?: string
}

function billingPath(projectRoot?: string, tenantId: string = DEFAULT_TENANT_ID): string {
  const root = projectRoot ?? getProjectRoot()
  if (tenantId === DEFAULT_TENANT_ID) {
    return path.join(root, '.claude', BILLING_LEDGER_FILE_NAME)
  }
  return path.join(root, '.claude', TENANTS_DIR_NAME, tenantId, BILLING_LEDGER_FILE_NAME)
}

export function appendUsageLedgerRecord(
  record: UsageLedgerRecord,
  opts: UsageLedgerWriteOptions = {},
): void {
  appendEncryptedJsonlRecord(
    billingPath(opts.projectRoot, opts.tenantId ?? record.tenantId),
    record,
    opts.encryptionKey ? { key: opts.encryptionKey } : undefined,
  )
}

export function loadUsageLedger(
  projectRoot?: string,
  tenantId: string = DEFAULT_TENANT_ID,
  encryptionKey?: string,
): UsageLedgerRecord[] {
  return readEncryptedJsonl<UsageLedgerRecord>(
    billingPath(projectRoot, tenantId),
    encryptionKey ? { key: encryptionKey } : undefined,
  )
}

export function listUsageLedgerTenants(projectRoot?: string): string[] {
  const root = projectRoot ?? getProjectRoot()
  const tenants = new Set<string>()
  if (existsSync(billingPath(root, DEFAULT_TENANT_ID))) {
    tenants.add(DEFAULT_TENANT_ID)
  }
  const tenantsDir = path.join(root, '.claude', TENANTS_DIR_NAME)
  try {
    for (const entry of readdirSync(tenantsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (existsSync(billingPath(root, entry.name))) {
        tenants.add(entry.name)
      }
    }
  } catch {
    // No tenant billing ledgers yet.
  }
  return Array.from(tenants).sort()
}

function tenantContext(id: string): TenantContext {
  if (id === DEFAULT_TENANT_ID) return DEFAULT_TENANT
  return { id, name: id, role: 'developer' }
}

export function summarizeUsageLedger(
  projectRoot?: string,
  opts: { recentLimit?: number; encryptionKey?: string } = {},
): {
  totals: {
    costUSD: number
    records: number
  }
  tenants: Array<{
    tenant: { id: string; name: string; role: TenantContext['role'] }
    costUSD: number
    records: number
    recent: UsageLedgerRecord[]
  }>
} {
  const recentLimit = Math.max(1, opts.recentLimit ?? 5)
  const tenants = listUsageLedgerTenants(projectRoot)
  const summaries = tenants.map(tenantId => {
    const records = loadUsageLedger(projectRoot, tenantId, opts.encryptionKey)
      .sort((a, b) => b.ts.localeCompare(a.ts))
    return {
      tenant: tenantContext(tenantId),
      costUSD: records.reduce((sum, record) => sum + record.costUSD, 0),
      records: records.length,
      recent: records.slice(0, recentLimit),
    }
  })
  return {
    totals: {
      costUSD: summaries.reduce((sum, summary) => sum + summary.costUSD, 0),
      records: summaries.reduce((sum, summary) => sum + summary.records, 0),
    },
    tenants: summaries,
  }
}

export async function postStripeBillingHook(
  record: UsageLedgerRecord,
  opts: {
    url?: string
    apiKey?: string
  } = {},
): Promise<{
  delivered: boolean
  status?: number
  error?: string
}> {
  const url =
    opts.url ??
    process.env.CC_STRIPE_BILLING_WEBHOOK_URL ??
    process.env.CC_STRIPE_BILLING_URL
  if (!url) return { delivered: false, error: 'stripe_hook_unset' }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ?? process.env.CC_STRIPE_BILLING_API_KEY
          ? {
              authorization: `Bearer ${opts.apiKey ?? process.env.CC_STRIPE_BILLING_API_KEY}`,
            }
          : {}),
      },
      body: JSON.stringify({
        type: 'cc.usage_record.created',
        data: {
          object: {
            event_name: 'cc_usage',
            identifier: `${record.subjectKind}:${record.subjectId}:${record.ts}`,
            payload: {
              tenant_id: record.tenantId,
              subject_kind: record.subjectKind,
              subject_id: record.subjectId,
              session_id: record.sessionId,
              model: record.model,
              cost_usd: record.costUSD,
              input_tokens: record.inputTokens,
              output_tokens: record.outputTokens,
            },
          },
        },
      }),
    })
    return { delivered: res.ok, status: res.status }
  } catch (error) {
    return {
      delivered: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function recordUsageFromContext(input: {
  usage: BetaUsage
  model: string
  costUSD: number
  tenant: TenantContext
  dutyId?: string
  assignmentId?: string
  projectRoot?: string
  encryptionKey?: string
}): UsageLedgerRecord {
  const record: UsageLedgerRecord = {
    ts: new Date().toISOString(),
    tenantId: input.tenant.id,
    subjectKind: input.dutyId
      ? 'duty'
      : input.assignmentId
        ? 'assignment'
        : 'session',
    subjectId: input.dutyId ?? input.assignmentId ?? getSessionId(),
    sessionId: getSessionId(),
    model: input.model,
    costUSD: input.costUSD,
    inputTokens: input.usage.input_tokens,
    outputTokens: input.usage.output_tokens,
    cacheReadInputTokens: input.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: input.usage.cache_creation_input_tokens ?? 0,
    webSearchRequests: input.usage.server_tool_use?.web_search_requests ?? 0,
  }
  appendUsageLedgerRecord(record, {
    projectRoot: input.projectRoot,
    tenantId: input.tenant.id,
    ...(input.encryptionKey ? { encryptionKey: input.encryptionKey } : {}),
  })
  return record
}

export function buildBillingSecurityArtifact(now?: () => Date): {
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
    coveredStores: ['billing-usage'],
  })
}
