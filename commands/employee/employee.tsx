import { setScheduledTasksEnabled } from '../../bootstrap/state.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { startBackgroundSession } from '../../tasks/LocalMainSessionTask.js'
import { cronToHuman, parseCronExpression } from '../../utils/cron.js'
import {
  addCronTask,
  listAllCronTasks,
  removeCronTasks,
} from '../../utils/cronTasks.js'
import {
  createAssignmentPrompt,
  createDutyPrompt,
  createEmployeeDutyId,
  getEmployeeConfigPath,
  readEmployeeConfig,
  summarizeEmployeeConfig,
  upsertEmployeeConfig,
} from '../../utils/employeeConfig.js'
import {
  buildEffectiveSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPrompt.js'
import { getQuerySourceForREPL } from '../../utils/promptCategory.js'
import {
  createSyntheticUserCaveatMessage,
  createUserMessage,
} from '../../utils/messages.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  type EmployeeDuty,
  ENGINEERING_LEAD_AGENT_TYPE,
} from '../../types/employee.js'

const HELP_TEXT = `Usage:
/employee init [goal one | goal two]
/employee assign <assignment>
/employee status
/employee duty list
/employee duty add <cron> | <title> | <prompt> [| auto-commit]
/employee duty remove <duty-id>

Examples:
/employee init Reduce flaky CI | Keep release branches green
/employee assign investigate the flaky CI job on main
/employee duty add 0 9 * * 1-5 | Morning CI sweep | Check CI health, triage failures, and report blockers
/employee duty remove ab12cd34`

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<undefined> {
  const trimmed = args.trim()
  if (!trimmed) {
    onDone(HELP_TEXT, { display: 'system' })
    return
  }

  const [subcommand] = trimmed.split(/\s+/)
  const remainder = trimmed.slice(subcommand.length).trim()

  switch (subcommand) {
    case 'init':
      await handleInit(onDone, remainder)
      return
    case 'assign':
      await handleAssign(onDone, context, remainder)
      return
    case 'status':
      await handleStatus(onDone, context)
      return
    case 'duty':
      await handleDuty(onDone, remainder)
      return
    default:
      onDone(HELP_TEXT, { display: 'system' })
  }
}

async function handleInit(
  onDone: LocalJSXCommandOnDone,
  args: string,
): Promise<void> {
  const goals = splitPipeArgs(args).filter(Boolean)
  const config = await upsertEmployeeConfig(existing => ({
    role: ENGINEERING_LEAD_AGENT_TYPE,
    goals: goals.length > 0 ? goals : existing?.goals ?? [],
    defaultAutonomy: 'full-operator',
    delegationMode: 'team',
    verificationRequired: existing?.verificationRequired ?? true,
    recurringDuties: existing?.recurringDuties ?? [],
  }))

  onDone(
    `Initialized the project AI employee at ${getEmployeeConfigPath()}.\n\n${summarizeEmployeeConfig(config)}`,
    { display: 'system' },
  )
}

async function handleAssign(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  assignment: string,
): Promise<void> {
  if (!assignment) {
    onDone('Usage: /employee assign <assignment>', { display: 'system' })
    return
  }

  const config = await readEmployeeConfig()
  const leadAgent = context.options.agentDefinitions.activeAgents.find(
    agent => agent.agentType === ENGINEERING_LEAD_AGENT_TYPE,
  )
  if (!leadAgent) {
    onDone(
      'The engineering-lead agent is not available in this session.',
      { display: 'system' },
    )
    return
  }
  if (!context.canUseTool) {
    onDone('This session cannot launch an employee assignment right now.', {
      display: 'system',
    })
    return
  }

  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    getSystemPrompt(
      context.options.tools,
      context.options.mainLoopModel,
      Array.from(
        context.getAppState().toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      context.options.mcpClients,
    ),
    getUserContext(),
    getSystemContext(),
  ])

  const systemPrompt = resolveEmployeeSystemPrompt(
    context,
    leadAgent,
    defaultSystemPrompt,
  )
  context.renderedSystemPrompt = systemPrompt

  const prompt = createAssignmentPrompt(assignment, config)
  const description = `Employee assignment: ${assignment.slice(0, 80)}`
  const taskId = startBackgroundSession({
    messages: [
      ...context.messages,
      createSyntheticUserCaveatMessage(),
      createUserMessage({ content: prompt }),
    ],
    queryParams: {
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: context.canUseTool,
      toolUseContext: context,
      querySource: context.options.querySource ?? getQuerySourceForREPL(),
    },
    description,
    setAppState: context.setAppStateForTasks ?? context.setAppState,
    agentDefinition: leadAgent,
  })

  onDone(
    `Started employee assignment ${taskId}.\nLead: ${ENGINEERING_LEAD_AGENT_TYPE}\nAssignment: ${assignment}`,
    { display: 'system' },
  )
}

async function handleStatus(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<void> {
  const [config, allCronTasks] = await Promise.all([
    readEmployeeConfig(),
    listAllCronTasks(),
  ])

  const employeeTasks = Object.values(context.getAppState().tasks).filter(task =>
    isEmployeeTask(task),
  )

  const taskLines =
    employeeTasks.length > 0
      ? employeeTasks
          .map(
            task =>
              `- ${task.id} ${task.description} (${task.status}${task.agentType ? `, ${task.agentType}` : ''})`,
          )
          .join('\n')
      : '- No active employee tasks'

  const dutyLines =
    config?.recurringDuties.length
      ? config.recurringDuties
          .map(duty => {
            const cronTask = duty.cronTaskId
              ? allCronTasks.find(task => task.id === duty.cronTaskId)
              : undefined
            return `- ${duty.id} ${duty.title} (${duty.enabled ? 'enabled' : 'disabled'}, ${cronToHuman(duty.cron)}${cronTask ? '' : ', unscheduled'})`
          })
          .join('\n')
      : '- No recurring duties configured'

  onDone(
    `${summarizeEmployeeConfig(config)}\n\nActive employee tasks:\n${taskLines}\n\nDuty schedule:\n${dutyLines}`,
    { display: 'system' },
  )
}

async function handleDuty(
  onDone: LocalJSXCommandOnDone,
  args: string,
): Promise<void> {
  const [action] = args.trim().split(/\s+/)
  const remainder = args.trim().slice(action?.length ?? 0).trim()

  switch (action) {
    case 'list': {
      const config = await readEmployeeConfig()
      onDone(summarizeEmployeeConfig(config), { display: 'system' })
      return
    }
    case 'add':
      await handleDutyAdd(onDone, remainder)
      return
    case 'remove':
      await handleDutyRemove(onDone, remainder)
      return
    default:
      onDone(
        'Usage: /employee duty [list|add|remove]\nAdd syntax: /employee duty add <cron> | <title> | <prompt> [| auto-commit]',
        { display: 'system' },
      )
      return
  }
}

async function handleDutyAdd(
  onDone: LocalJSXCommandOnDone,
  args: string,
): Promise<void> {
  const config = (await readEmployeeConfig()) ?? {
    role: ENGINEERING_LEAD_AGENT_TYPE,
    goals: [],
    defaultAutonomy: 'full-operator',
    delegationMode: 'team',
    verificationRequired: true,
    recurringDuties: [],
  }

  const parts = splitPipeArgs(args)
  if (parts.length < 3) {
    onDone(
      'Usage: /employee duty add <cron> | <title> | <prompt> [| auto-commit]',
      { display: 'system' },
    )
    return
  }

  const [cron, title, prompt, ...flags] = parts
  if (!parseCronExpression(cron)) {
    onDone(`Invalid cron expression: ${cron}`, { display: 'system' })
    return
  }

  const autoCommit = flags.some(flag => flag.toLowerCase() === 'auto-commit')
  const dutyId = createEmployeeDutyId()
  const duty: EmployeeDuty = {
    id: dutyId,
    title,
    prompt,
    cron,
    enabled: true,
    autoCommit,
    targetAgent: ENGINEERING_LEAD_AGENT_TYPE,
  }

  const cronTaskId = await addCronTask(
    cron,
    createDutyPrompt(duty, config),
    true,
    true,
  )
  setScheduledTasksEnabled(true)

  const nextConfig = await upsertEmployeeConfig(existing => ({
    ...(existing ?? config),
    recurringDuties: [
      ...(existing?.recurringDuties ?? config.recurringDuties),
      { ...duty, cronTaskId },
    ],
  }))

  onDone(
    `Added duty ${dutyId}.\nSchedule: ${cronToHuman(cron)}\nCron task: ${cronTaskId}\n\n${summarizeEmployeeConfig(nextConfig)}`,
    { display: 'system' },
  )
}

async function handleDutyRemove(
  onDone: LocalJSXCommandOnDone,
  args: string,
): Promise<void> {
  const dutyId = args.trim()
  if (!dutyId) {
    onDone('Usage: /employee duty remove <duty-id>', { display: 'system' })
    return
  }

  const config = await readEmployeeConfig()
  if (!config) {
    onDone('AI employee is not initialized for this project.', {
      display: 'system',
    })
    return
  }

  const duty = config.recurringDuties.find(item => item.id === dutyId)
  if (!duty) {
    onDone(`No duty found with id ${dutyId}.`, { display: 'system' })
    return
  }

  if (duty.cronTaskId) {
    await removeCronTasks([duty.cronTaskId])
  }

  const nextConfig = await upsertEmployeeConfig(existing => ({
    ...(existing ?? config),
    recurringDuties: (existing?.recurringDuties ?? config.recurringDuties).filter(
      item => item.id !== dutyId,
    ),
  }))

  onDone(`Removed duty ${dutyId}.\n\n${summarizeEmployeeConfig(nextConfig)}`, {
    display: 'system',
  })
}

function splitPipeArgs(input: string): string[] {
  return input
    .split('|')
    .map(part => part.trim())
    .filter(Boolean)
}

function resolveEmployeeSystemPrompt(
  context: LocalJSXCommandContext,
  mainThreadAgentDefinition: NonNullable<
    LocalJSXCommandContext['options']['agentDefinitions']['activeAgents'][number]
  >,
  defaultSystemPrompt: string[],
): SystemPrompt {
  return buildEffectiveSystemPrompt({
    mainThreadAgentDefinition,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
}

function isEmployeeTask(
  task: unknown,
): task is { id: string; description: string; status: string; agentType?: string } {
  if (!task || typeof task !== 'object') return false
  const value = task as Record<string, unknown>
  if (typeof value.description !== 'string') return false
  return value.description.startsWith('Employee assignment:')
}
