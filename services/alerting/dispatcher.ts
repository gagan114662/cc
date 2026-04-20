import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { appendEncryptedJsonlRecord, buildEncryptionArtifact, readEncryptedJsonl } from '../security/encryptedJsonl.js'
import {
  DEFAULT_TENANT,
  DEFAULT_TENANT_ID,
  type TenantContext,
} from '../tenant/tenantContext.js'

const ALERT_LOG_FILE_NAME = 'alert-deliveries.jsonl'
const TENANTS_DIR_NAME = 'tenants'

export type AlertProvider = 'pagerduty' | 'opsgenie'
export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical'

export type AlertDeliveryRecord = {
  ts: string
  tenantId: string
  provider: AlertProvider
  severity: AlertSeverity
  summary: string
  source: string
  dedupeKey: string
  status: 'delivered' | 'failed' | 'disabled'
  responseStatus?: number
  error?: string
}

export type DispatchAlertOptions = {
  tenant?: TenantContext
  url?: string
  apiKey?: string
  routingKey?: string
  projectRoot?: string
  encryptionKey?: string
  now?: () => Date
}

function alertLogPath(projectRoot?: string, tenantId: string = DEFAULT_TENANT_ID): string {
  const root = projectRoot ?? getProjectRoot()
  if (tenantId === DEFAULT_TENANT_ID) {
    return path.join(root, '.claude', ALERT_LOG_FILE_NAME)
  }
  return path.join(root, '.claude', TENANTS_DIR_NAME, tenantId, ALERT_LOG_FILE_NAME)
}

function appendAlertRecord(
  record: AlertDeliveryRecord,
  opts: DispatchAlertOptions,
): void {
  appendEncryptedJsonlRecord(
    alertLogPath(opts.projectRoot, record.tenantId),
    record,
    opts.encryptionKey ? { key: opts.encryptionKey } : undefined,
  )
}

async function deliverPagerDuty(
  record: AlertDeliveryRecord,
  opts: DispatchAlertOptions,
): Promise<AlertDeliveryRecord> {
  const url = opts.url ?? process.env.CC_PAGERDUTY_URL ?? 'https://events.pagerduty.com/v2/enqueue'
  const routingKey =
    opts.routingKey ?? process.env.CC_PAGERDUTY_ROUTING_KEY
  if (!routingKey && !opts.url) {
    return { ...record, status: 'disabled', error: 'pagerduty_routing_key_unset' }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        routing_key: routingKey ?? 'test',
        event_action: 'trigger',
        dedup_key: record.dedupeKey,
        payload: {
          summary: record.summary,
          source: record.source,
          severity: record.severity === 'critical' ? 'critical' : 'error',
          custom_details: {
            tenant_id: record.tenantId,
          },
        },
      }),
    })
    return {
      ...record,
      status: res.ok ? 'delivered' : 'failed',
      responseStatus: res.status,
      ...(res.ok ? {} : { error: 'pagerduty_http_error' }),
    }
  } catch (error) {
    return {
      ...record,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function deliverOpsGenie(
  record: AlertDeliveryRecord,
  opts: DispatchAlertOptions,
): Promise<AlertDeliveryRecord> {
  const url = opts.url ?? process.env.CC_OPSGENIE_URL ?? 'https://api.opsgenie.com/v2/alerts'
  const apiKey = opts.apiKey ?? process.env.CC_OPSGENIE_API_KEY
  if (!apiKey && !opts.url) {
    return { ...record, status: 'disabled', error: 'opsgenie_api_key_unset' }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `GenieKey ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        message: record.summary,
        alias: record.dedupeKey,
        description: record.source,
        priority:
          record.severity === 'critical'
            ? 'P1'
            : record.severity === 'error'
              ? 'P2'
              : record.severity === 'warning'
                ? 'P3'
                : 'P5',
        details: {
          tenant_id: record.tenantId,
        },
      }),
    })
    return {
      ...record,
      status: res.ok ? 'delivered' : 'failed',
      responseStatus: res.status,
      ...(res.ok ? {} : { error: 'opsgenie_http_error' }),
    }
  } catch (error) {
    return {
      ...record,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function dispatchOperationalAlert(input: {
  provider: AlertProvider
  severity: AlertSeverity
  summary: string
  source: string
  dedupeKey: string
}, opts: DispatchAlertOptions = {}): Promise<AlertDeliveryRecord> {
  const tenant = opts.tenant ?? DEFAULT_TENANT
  const record: AlertDeliveryRecord = {
    ts: (opts.now ?? (() => new Date()))().toISOString(),
    tenantId: tenant.id,
    provider: input.provider,
    severity: input.severity,
    summary: input.summary,
    source: input.source,
    dedupeKey: input.dedupeKey,
    status: 'disabled',
  }
  const delivered =
    input.provider === 'pagerduty'
      ? await deliverPagerDuty(record, opts)
      : await deliverOpsGenie(record, opts)
  appendAlertRecord(delivered, opts)
  return delivered
}

export async function dispatchConfiguredOperationalAlerts(input: {
  severity: AlertSeverity
  summary: string
  source: string
  dedupeKey: string
}, opts: DispatchAlertOptions = {}): Promise<AlertDeliveryRecord[]> {
  const providers: AlertProvider[] = ['pagerduty', 'opsgenie']
  const deliveries: AlertDeliveryRecord[] = []
  for (const provider of providers) {
    const delivery = await dispatchOperationalAlert(
      { ...input, provider },
      opts,
    )
    deliveries.push(delivery)
  }
  return deliveries
}

export function loadAlertDeliveries(
  projectRoot?: string,
  tenantId: string = DEFAULT_TENANT_ID,
  encryptionKey?: string,
): AlertDeliveryRecord[] {
  return readEncryptedJsonl<AlertDeliveryRecord>(
    alertLogPath(projectRoot, tenantId),
    encryptionKey ? { key: encryptionKey } : undefined,
  )
}

export function listAlertTenants(projectRoot?: string): string[] {
  const root = projectRoot ?? getProjectRoot()
  const tenants = new Set<string>()
  if (existsSync(alertLogPath(root, DEFAULT_TENANT_ID))) {
    tenants.add(DEFAULT_TENANT_ID)
  }
  const tenantsDir = path.join(root, '.claude', TENANTS_DIR_NAME)
  try {
    for (const entry of readdirSync(tenantsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (existsSync(alertLogPath(root, entry.name))) {
        tenants.add(entry.name)
      }
    }
  } catch {
    // No named-tenant alert logs yet.
  }
  return Array.from(tenants).sort()
}

function tenantContext(id: string): TenantContext {
  if (id === DEFAULT_TENANT_ID) return DEFAULT_TENANT
  return { id, name: id, role: 'developer' }
}

export function summarizeAlertDeliveries(
  projectRoot?: string,
  opts: { recentLimit?: number; encryptionKey?: string } = {},
): {
  total: number
  recent: AlertDeliveryRecord[]
  byProvider: Array<{ provider: AlertProvider; count: number }>
  tenants: Array<{
    tenant: { id: string; name: string; role: TenantContext['role'] }
    count: number
  }>
} {
  const recentLimit = Math.max(1, opts.recentLimit ?? 10)
  const all = listAlertTenants(projectRoot).flatMap(tenantId =>
    loadAlertDeliveries(projectRoot, tenantId, opts.encryptionKey),
  )
  const recent = [...all]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, recentLimit)
  const byProvider = ['opsgenie', 'pagerduty'].map(provider => ({
    provider: provider as AlertProvider,
    count: all.filter(entry => entry.provider === provider).length,
  }))
  const tenants = listAlertTenants(projectRoot).map(tenantId => ({
    tenant: tenantContext(tenantId),
    count: loadAlertDeliveries(projectRoot, tenantId, opts.encryptionKey).length,
  }))
  return { total: all.length, recent, byProvider, tenants }
}

export function buildAlertingSecurityArtifact(now?: () => Date): {
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
    coveredStores: ['alert-deliveries'],
  })
}
