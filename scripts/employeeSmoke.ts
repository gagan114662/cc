import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import {
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../bootstrap/state.js'
import { getBuiltInAgents } from '../tools/AgentTool/builtInAgents.js'
import { ENGINEERING_LEAD_AGENT } from '../tools/AgentTool/built-in/engineeringLeadAgent.js'
import { ENGINEERING_LEAD_AGENT_TYPE } from '../types/employee.js'
import {
  createAssignmentPrompt,
  createDutyPrompt,
  readEmployeeConfig,
  upsertEmployeeConfig,
} from '../utils/employeeConfig.js'
import {
  addCronTask,
  listAllCronTasks,
  readCronTasks,
  removeCronTasks,
} from '../utils/cronTasks.js'

async function main(): Promise<void> {
  const projectRoot = process.cwd()
  const claudeDir = join(projectRoot, '.claude')

  setOriginalCwd(projectRoot)
  setCwdState(projectRoot)
  setProjectRoot(projectRoot)

  await mkdir(claudeDir, { recursive: true })
  await rm(join(claudeDir, 'employee.json'), { force: true })
  await rm(join(claudeDir, 'scheduled_tasks.json'), { force: true })

  const builtInAgents = getBuiltInAgents()
  if (!builtInAgents.some(agent => agent.agentType === ENGINEERING_LEAD_AGENT_TYPE)) {
    throw new Error('engineering-lead is missing from built-in agents')
  }

  const config = await upsertEmployeeConfig(() => ({
    role: ENGINEERING_LEAD_AGENT_TYPE,
    goals: ['Keep CI healthy', 'Close engineering follow-ups'],
    defaultAutonomy: 'full-operator',
    delegationMode: 'team',
    verificationRequired: true,
    recurringDuties: [],
  }))

  const reloaded = await readEmployeeConfig(projectRoot)
  if (!reloaded || reloaded.role !== ENGINEERING_LEAD_AGENT_TYPE) {
    throw new Error('employee config did not round-trip')
  }

  const assignmentPrompt = createAssignmentPrompt('fix flaky CI', reloaded)
  if (!assignmentPrompt.includes('fix flaky CI')) {
    throw new Error('assignment prompt did not include assignment text')
  }

  const systemPrompt = ENGINEERING_LEAD_AGENT.getSystemPrompt()
  if (!systemPrompt.includes('engineering lead')) {
    throw new Error('engineering lead system prompt did not render')
  }

  const dutyPrompt = createDutyPrompt(
    {
      title: 'Morning CI sweep',
      prompt: 'Review CI failures and summarize blockers.',
      autoCommit: false,
    },
    config,
  )
  if (!dutyPrompt.includes('Morning CI sweep')) {
    throw new Error('duty prompt did not include duty title')
  }

  const cronTaskId = await addCronTask(
    '0 9 * * 1-5',
    dutyPrompt,
    true,
    true,
  )
  const persistedTasks = await readCronTasks(projectRoot)
  if (!persistedTasks.some(task => task.id === cronTaskId)) {
    throw new Error('cron task was not persisted')
  }

  await upsertEmployeeConfig(existing => ({
    ...(existing ?? config),
    recurringDuties: [
      {
        id: 'morning-ci',
        title: 'Morning CI sweep',
        prompt: 'Review CI failures and summarize blockers.',
        cron: '0 9 * * 1-5',
        enabled: true,
        autoCommit: false,
        cronTaskId,
      },
    ],
  }))

  const mergedTasks = await listAllCronTasks(projectRoot)
  if (!mergedTasks.some(task => task.id === cronTaskId)) {
    throw new Error('scheduled duty was not visible in task listing')
  }

  await removeCronTasks([cronTaskId], projectRoot)

  const finalConfig = await readEmployeeConfig(projectRoot)
  console.log(
    JSON.stringify(
      {
        cliAgentRegistered: true,
        employeeRole: finalConfig?.role,
        recurringDutyCount: finalConfig?.recurringDuties.length ?? 0,
        assignmentPromptChecked: true,
        dutyPromptChecked: true,
        cronTaskId,
      },
      null,
      2,
    ),
  )
}

void main()
