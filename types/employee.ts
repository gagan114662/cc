export const ENGINEERING_LEAD_AGENT_TYPE = 'engineering-lead'

export type EmployeeRole = typeof ENGINEERING_LEAD_AGENT_TYPE

export type EmployeeAutonomy = 'full-operator'

export type EmployeeDelegationMode = 'team'

// Optional hard ceilings for a recurring duty. tokenBudget caps tokens per
// single duty tick; costCap caps cumulative USD across all ticks. Both are
// enforced at duty execution time (see query/tokenBudget.ts) and — unlike
// the pre-existing per-turn continuation nudge — they throw rather than
// merely stopping continuation, which is what makes them a hard-stop.
export type EmployeeDutyBudget = {
  tokenBudget?: number
  costCap?: number
}

export type EmployeeDuty = {
  id: string
  title: string
  prompt: string
  cron: string
  enabled: boolean
  autoCommit: boolean
  targetAgent?: string
  cronTaskId?: string
} & EmployeeDutyBudget

export type EmployeeConfig = {
  role: EmployeeRole
  goals: string[]
  defaultAutonomy: EmployeeAutonomy
  delegationMode: EmployeeDelegationMode
  verificationRequired: boolean
  recurringDuties: EmployeeDuty[]
}
