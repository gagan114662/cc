import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import {
  DEFAULT_TENANT,
  DEFAULT_TENANT_ID,
  type TenantContext,
} from '../services/tenant/tenantContext.js'
import { currentTenantContext } from '../services/tenant/tenantScope.js'
import { getEmployeeStore } from '../services/employeeStore/store.js'
import { cronToHuman } from './cron.js'
import { safeParseJSON } from './json.js'
import {
  type EmployeeConfig,
  type EmployeeDuty,
  ENGINEERING_LEAD_AGENT_TYPE,
} from '../types/employee.js'

const EMPLOYEE_FILE_NAME = 'employee.json'
const TENANTS_DIR_NAME = 'tenants'

// Tenant-aware path resolution.
//
// DEFAULT_TENANT keeps reading/writing `.claude/employee.json` so a
// single-operator install does not need to migrate any files. Named
// tenants live under `.claude/tenants/<id>/employee.json`. The split
// matters because this file is the hot path for `/employee` and the
// daemon scheduler — both must see exactly the subset of duties owned
// by the active tenant, even when other tenants are configured in the
// same project root.
//
// Resolution order for the caller's tenant:
//   1. explicit `tenantId` argument (daemon scheduler passes this)
//   2. active AsyncLocalStorage scope (runWithTenantScope)
//   3. env-derived context (legacy single-operator path)
function resolveTenantId(tenantId?: string): string {
  if (tenantId !== undefined) return tenantId
  return currentTenantContext().id
}

// Path of the on-disk snapshot for a given tenant. Under the JSON
// backend (the default) this is the authoritative location of the
// config. Under the Postgres backend it is the cache mirror the
// store writes after every DB upsert, kept so the synchronous
// reader (engineeringLeadAgent) continues to work in a subprocess
// that has no Postgres connection.
export function getEmployeeConfigPath(
  projectRoot?: string,
  tenantId?: string,
): string {
  const root = projectRoot ?? getProjectRoot()
  const resolved = resolveTenantId(tenantId)
  if (resolved === DEFAULT_TENANT_ID) {
    return join(root, '.claude', EMPLOYEE_FILE_NAME)
  }
  return join(root, '.claude', TENANTS_DIR_NAME, resolved, EMPLOYEE_FILE_NAME)
}

export async function readEmployeeConfig(
  projectRoot?: string,
  tenantId?: string,
): Promise<EmployeeConfig | null> {
  const root = projectRoot ?? getProjectRoot()
  const resolved = resolveTenantId(tenantId)
  const store = await getEmployeeStore()
  return store.read({ projectRoot: root, tenantId: resolved })
}

// Synchronous read, by design always against the on-disk snapshot.
// This is the single synchronous entry point into the store and
// exists only for `tools/AgentTool/built-in/engineeringLeadAgent.ts`,
// whose `getSystemPrompt()` is a synchronous frame deep inside Ink
// and cannot be refactored to await. The Postgres backend writes the
// same snapshot after every upsert, so this reader returns the same
// bytes as an async `readEmployeeConfig` in steady state.
export function readEmployeeConfigSync(
  projectRoot?: string,
  tenantId?: string,
): EmployeeConfig | null {
  try {
    const raw = readFileSync(
      getEmployeeConfigPath(projectRoot, tenantId),
      'utf-8',
    )
    return parseEmployeeConfigRaw(raw)
  } catch {
    return null
  }
}

export async function writeEmployeeConfig(
  config: EmployeeConfig,
  projectRoot?: string,
  tenantId?: string,
): Promise<void> {
  const root = projectRoot ?? getProjectRoot()
  const resolved = resolveTenantId(tenantId)
  const store = await getEmployeeStore()
  await store.write(config, { projectRoot: root, tenantId: resolved })
}

export async function upsertEmployeeConfig(
  updater: (existing: EmployeeConfig | null) => EmployeeConfig,
  projectRoot?: string,
  tenantId?: string,
): Promise<EmployeeConfig> {
  const next = updater(await readEmployeeConfig(projectRoot, tenantId))
  await writeEmployeeConfig(next, projectRoot, tenantId)
  return next
}

// Enumerate the tenants that actually have an employee config under
// the given project root. Used by the daemon on boot to schedule
// duties for every configured tenant — and by future Phase 2 code
// paths (durable queue, audit aggregation) that need the same
// enumeration.
//
// Semantics are preserved across backends:
//   - JSON backend: scans `.claude/employee.json` + `.claude/tenants/<id>/employee.json`
//   - Postgres backend: SELECT DISTINCT tenant_id FROM employee_configs
//     WHERE project_root = $1
// Both return DEFAULT_TENANT with role 'admin' and named tenants with
// role 'developer'. Hosted deployments that need richer role metadata
// attach it at a layer above this store.
export async function listConfiguredTenants(
  projectRoot?: string,
): Promise<TenantContext[]> {
  const root = projectRoot ?? getProjectRoot()
  const store = await getEmployeeStore()
  return store.listTenants(root)
}

export function createEmployeeDutyId(): string {
  return randomUUID().slice(0, 8)
}

export function createDutyPrompt(
  duty: Pick<EmployeeDuty, 'title' | 'prompt' | 'autoCommit'>,
  config: Pick<EmployeeConfig, 'goals' | 'verificationRequired'>,
): string {
  const goals =
    config.goals.length > 0
      ? `Project goals:\n- ${config.goals.join('\n- ')}\n\n`
      : ''
  const verification = config.verificationRequired
    ? 'You must include a verification phase before calling the work complete.'
    : 'Verification is helpful but not required for this duty.'
  const autoCommit = duty.autoCommit
    ? 'Auto-commit is enabled for this duty if changes are ready.'
    : 'Do not auto-commit unless the user explicitly asks.'

  return [
    `You are the project's engineering-lead AI employee running a recurring duty.`,
    `Duty: ${duty.title}`,
    '',
    goals.trimEnd(),
    `Execute this as a coordinated engineering lead. Delegate research, implementation, and verification when the work is multi-step. Keep ownership of the result and summarize the outcome clearly.`,
    verification,
    autoCommit,
    '',
    `Duty instructions:`,
    duty.prompt,
  ]
    .filter(Boolean)
    .join('\n')
}

export function createAssignmentPrompt(
  assignment: string,
  config: Pick<EmployeeConfig, 'goals' | 'verificationRequired'> | null,
): string {
  const goals =
    config && config.goals.length > 0
      ? `Current project goals:\n- ${config.goals.join('\n- ')}\n\n`
      : ''
  const verification =
    config?.verificationRequired === false
      ? 'Verification is optional if there is no meaningful check to run.'
      : 'You must verify implementation work before marking the assignment complete.'

  return [
    `You are the engineering-lead AI employee for this repository.`,
    `Own this assignment end to end. Break it into research, implementation, and verification as needed. Delegate work to workers when that is the fastest safe path, then synthesize the result for the user.`,
    verification,
    '',
    goals.trimEnd(),
    `Assignment:`,
    assignment,
  ]
    .filter(Boolean)
    .join('\n')
}

export function summarizeEmployeeConfig(config: EmployeeConfig | null): string {
  if (!config) {
    return 'AI employee is not initialized for this project.'
  }

  const goalLines =
    config.goals.length > 0
      ? config.goals.map(goal => `- ${goal}`).join('\n')
      : '- No goals configured'

  const dutyLines =
    config.recurringDuties.length > 0
      ? config.recurringDuties
          .map(duty => {
            const status = duty.enabled ? 'enabled' : 'disabled'
            return `- ${duty.id} ${duty.title} (${status}, ${cronToHuman(duty.cron)})`
          })
          .join('\n')
      : '- No recurring duties configured'

  return [
    `Role: ${config.role}`,
    `Autonomy: ${config.defaultAutonomy}`,
    `Delegation: ${config.delegationMode}`,
    `Verification required: ${config.verificationRequired ? 'yes' : 'no'}`,
    `Goals:`,
    goalLines,
    `Recurring duties:`,
    dutyLines,
  ].join('\n')
}

export function isEngineeringLeadAgentType(
  agentType: string | undefined | null,
): boolean {
  return agentType === ENGINEERING_LEAD_AGENT_TYPE
}

// Exported so the store backends (services/employeeStore/backends/*)
// can validate raw config payloads through the same parser the
// synchronous file reader uses. Returns null for any shape that
// doesn't match the current EmployeeConfig schema; callers treat
// null as "no config" identically across backends.
export function parseEmployeeConfigRaw(raw: string): EmployeeConfig | null {
  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') return null

  const value = parsed as Partial<EmployeeConfig>
  if (value.role !== ENGINEERING_LEAD_AGENT_TYPE) return null
  if (!Array.isArray(value.goals) || !Array.isArray(value.recurringDuties)) {
    return null
  }

  const duties: EmployeeDuty[] = value.recurringDuties
    .filter(
      duty =>
        duty &&
        typeof duty === 'object' &&
        typeof duty.id === 'string' &&
        typeof duty.title === 'string' &&
        typeof duty.prompt === 'string' &&
        typeof duty.cron === 'string' &&
        typeof duty.enabled === 'boolean' &&
        typeof duty.autoCommit === 'boolean',
    )
    .map(duty => ({
      id: duty.id,
      title: duty.title,
      prompt: duty.prompt,
      cron: duty.cron,
      enabled: duty.enabled,
      autoCommit: duty.autoCommit,
      ...(typeof duty.targetAgent === 'string'
        ? { targetAgent: duty.targetAgent }
        : {}),
      ...(typeof duty.cronTaskId === 'string'
        ? { cronTaskId: duty.cronTaskId }
        : {}),
      ...(typeof duty.tokenBudget === 'number' && duty.tokenBudget > 0
        ? { tokenBudget: duty.tokenBudget }
        : {}),
      ...(typeof duty.costCap === 'number' && duty.costCap > 0
        ? { costCap: duty.costCap }
        : {}),
    }))

  return {
    role: ENGINEERING_LEAD_AGENT_TYPE,
    goals: value.goals.filter(goal => typeof goal === 'string'),
    defaultAutonomy: 'full-operator',
    delegationMode: 'team',
    verificationRequired: value.verificationRequired !== false,
    recurringDuties: duties,
  }
}
