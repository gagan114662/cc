import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import {
  DEFAULT_TENANT,
  DEFAULT_TENANT_ID,
  type TenantContext,
} from '../services/tenant/tenantContext.js'
import { currentTenantContext } from '../services/tenant/tenantScope.js'
import { cronToHuman } from './cron.js'
import { safeParseJSON } from './json.js'
import { jsonStringify } from './slowOperations.js'
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
  try {
    const raw = await readFile(
      getEmployeeConfigPath(projectRoot, tenantId),
      'utf-8',
    )
    return parseEmployeeConfig(raw)
  } catch {
    return null
  }
}

export function readEmployeeConfigSync(
  projectRoot?: string,
  tenantId?: string,
): EmployeeConfig | null {
  try {
    const raw = readFileSync(
      getEmployeeConfigPath(projectRoot, tenantId),
      'utf-8',
    )
    return parseEmployeeConfig(raw)
  } catch {
    return null
  }
}

export async function writeEmployeeConfig(
  config: EmployeeConfig,
  projectRoot?: string,
  tenantId?: string,
): Promise<void> {
  const filePath = getEmployeeConfigPath(projectRoot, tenantId)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    jsonStringify(config, null, 2) + '\n',
    'utf-8',
  )
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

// Enumerate the tenants that actually have an employee.json under the
// given project root. Used by the daemon on boot to schedule duties
// for every configured tenant — and by future Phase 2 code paths
// (durable queue, audit aggregation) that need the same enumeration.
//
// Contract:
//   - If `.claude/employee.json` exists, DEFAULT_TENANT is included.
//   - Every subdirectory of `.claude/tenants/` that contains its own
//     `employee.json` is returned as a TenantContext with role
//     'developer' (the safe default — hosted deployments must opt a
//     tenant up to admin through their own registry).
//   - An empty `.claude/tenants/<id>/` directory (no employee.json) is
//     skipped — plausibly leftover from a migration, not a configured
//     tenant.
export async function listConfiguredTenants(
  projectRoot?: string,
): Promise<TenantContext[]> {
  const root = projectRoot ?? getProjectRoot()
  const tenants: TenantContext[] = []

  try {
    await readFile(join(root, '.claude', EMPLOYEE_FILE_NAME), 'utf-8')
    tenants.push(DEFAULT_TENANT)
  } catch {
    // No default employee.json — that's fine, the project may only
    // have named tenants.
  }

  const tenantsDir = join(root, '.claude', TENANTS_DIR_NAME)
  let entries: string[] = []
  try {
    entries = await readdir(tenantsDir)
  } catch {
    return tenants
  }

  for (const entry of entries) {
    const configPath = join(tenantsDir, entry, EMPLOYEE_FILE_NAME)
    try {
      await readFile(configPath, 'utf-8')
    } catch {
      continue
    }
    tenants.push({ id: entry, name: entry, role: 'developer' })
  }

  return tenants
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

function parseEmployeeConfig(raw: string): EmployeeConfig | null {
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
