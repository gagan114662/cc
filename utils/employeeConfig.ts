import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import { cronToHuman } from './cron.js'
import { safeParseJSON } from './json.js'
import { jsonStringify } from './slowOperations.js'
import {
  type EmployeeConfig,
  type EmployeeDuty,
  ENGINEERING_LEAD_AGENT_TYPE,
} from '../types/employee.js'

const EMPLOYEE_FILE_RELATIVE_PATH = join('.claude', 'employee.json')

export function getEmployeeConfigPath(projectRoot?: string): string {
  return join(projectRoot ?? getProjectRoot(), EMPLOYEE_FILE_RELATIVE_PATH)
}

export async function readEmployeeConfig(
  projectRoot?: string,
): Promise<EmployeeConfig | null> {
  try {
    const raw = await readFile(getEmployeeConfigPath(projectRoot), 'utf-8')
    return parseEmployeeConfig(raw)
  } catch {
    return null
  }
}

export function readEmployeeConfigSync(
  projectRoot?: string,
): EmployeeConfig | null {
  try {
    const raw = readFileSync(getEmployeeConfigPath(projectRoot), 'utf-8')
    return parseEmployeeConfig(raw)
  } catch {
    return null
  }
}

export async function writeEmployeeConfig(
  config: EmployeeConfig,
  projectRoot?: string,
): Promise<void> {
  const root = projectRoot ?? getProjectRoot()
  await mkdir(join(root, '.claude'), { recursive: true })
  await writeFile(
    getEmployeeConfigPath(root),
    jsonStringify(config, null, 2) + '\n',
    'utf-8',
  )
}

export async function upsertEmployeeConfig(
  updater: (existing: EmployeeConfig | null) => EmployeeConfig,
  projectRoot?: string,
): Promise<EmployeeConfig> {
  const next = updater(await readEmployeeConfig(projectRoot))
  await writeEmployeeConfig(next, projectRoot)
  return next
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
