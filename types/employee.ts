export const ENGINEERING_LEAD_AGENT_TYPE = 'engineering-lead'

export type EmployeeRole = typeof ENGINEERING_LEAD_AGENT_TYPE

export type EmployeeAutonomy = 'full-operator'

export type EmployeeDelegationMode = 'team'

export type EmployeeDuty = {
  id: string
  title: string
  prompt: string
  cron: string
  enabled: boolean
  autoCommit: boolean
  targetAgent?: string
  cronTaskId?: string
}

export type EmployeeConfig = {
  role: EmployeeRole
  goals: string[]
  defaultAutonomy: EmployeeAutonomy
  delegationMode: EmployeeDelegationMode
  verificationRequired: boolean
  recurringDuties: EmployeeDuty[]
}
