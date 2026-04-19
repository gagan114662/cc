import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolUseContext } from '../Tool.js'
import type {
  Command,
  CommandBase,
  PromptCommand,
  WorkflowStep,
} from '../types/command.js'

export type WorkflowCommand = CommandBase &
  PromptCommand & {
    kind: 'workflow'
  }

type WorkflowSummaryOptions = {
  includeWhenToUse?: boolean
  includeInputs?: boolean
  includeOutputs?: boolean
  includeSuccessCriteria?: boolean
  includeTools?: boolean
  includeArguments?: boolean
  includeSteps?: boolean
}

export function isWorkflowCommand(
  cmd: Command | CommandBase,
): cmd is WorkflowCommand {
  return 'type' in cmd ? cmd.type === 'prompt' && cmd.kind === 'workflow' : false
}

function summarizeList(values: string[], maxItems = 4): string {
  if (values.length <= maxItems) {
    return values.join(', ')
  }

  const visible = values.slice(0, maxItems).join(', ')
  return `${visible}, +${values.length - maxItems} more`
}

function formatLabeledList(
  label: string,
  values: string[] | undefined,
): string | null {
  const normalized = values?.map(v => v.trim()).filter(Boolean) ?? []
  if (normalized.length === 0) {
    return null
  }

  return `${label}: ${summarizeList(normalized)}`
}

function summarizeWorkflowSteps(steps: WorkflowStep[] | undefined): string | null {
  const normalized = steps?.map(step => step.title.trim()).filter(Boolean) ?? []
  if (normalized.length === 0) {
    return null
  }

  return `Procedure: ${summarizeList(normalized, 3)}`
}

export function formatWorkflowCommandSummary(
  cmd: WorkflowCommand,
  options: WorkflowSummaryOptions = {},
): string {
  const {
    includeWhenToUse = true,
    includeInputs = true,
    includeOutputs = true,
    includeSuccessCriteria = true,
    includeTools = false,
    includeArguments = false,
    includeSteps = true,
  } = options

  const parts = [cmd.description]

  if (includeWhenToUse && cmd.whenToUse) {
    parts.push(`Use when: ${cmd.whenToUse}`)
  }

  if (includeInputs) {
    const inputs = formatLabeledList('Inputs', cmd.inputs)
    if (inputs) parts.push(inputs)
  }

  if (includeOutputs) {
    const outputs = formatLabeledList('Outputs', cmd.outputs)
    if (outputs) parts.push(outputs)
  }

  if (includeSuccessCriteria) {
    const success = formatLabeledList('Success', cmd.successCriteria)
    if (success) parts.push(success)
  }

  if (includeSteps) {
    const procedure = summarizeWorkflowSteps(cmd.workflowSteps)
    if (procedure) parts.push(procedure)
  }

  if (includeTools) {
    const tools = formatLabeledList('Tools', cmd.allowedTools)
    if (tools) parts.push(tools)
  }

  if (includeArguments) {
    const args = formatLabeledList('Arguments', cmd.argNames)
    if (args) parts.push(args)
  }

  return parts.join(' · ')
}

export function buildWorkflowExecutionContract(
  cmd: WorkflowCommand,
): string | null {
  const sections = [
    formatLabeledList('Inputs', cmd.inputs),
    formatLabeledList('Expected outputs', cmd.outputs),
    formatLabeledList('Success criteria', cmd.successCriteria),
    formatLabeledList('Arguments', cmd.argNames),
    formatLabeledList('Recommended tools', cmd.allowedTools),
  ].filter((value): value is string => value !== null)

  if (sections.length === 0 && !cmd.whenToUse) {
    return null
  }

  const lines = ['Workflow contract:']

  if (cmd.whenToUse) {
    lines.push(`Use when: ${cmd.whenToUse}`)
  }

  lines.push(...sections)
  if (cmd.workflowSteps?.length) {
    lines.push('Procedure:')
    lines.push(...formatWorkflowSteps(cmd.workflowSteps))
  }
  lines.push(
    'Treat the success criteria as the completion bar. If required inputs are missing, gather them or call out the gap before claiming the workflow is done.',
  )

  return lines.join('\n')
}

function formatWorkflowSteps(steps: WorkflowStep[]): string[] {
  return steps.flatMap((step, index) => {
    const stepLines = [`${index + 1}. ${step.title}`]
    if (step.objective) {
      stepLines.push(`   Objective: ${step.objective}`)
    }
    if (step.success) {
      stepLines.push(`   Success: ${step.success}`)
    }
    if (step.tools?.length) {
      stepLines.push(`   Tools: ${step.tools.join(', ')}`)
    }
    return stepLines
  })
}

export function decorateWorkflowPromptCommand(
  cmd: WorkflowCommand,
): WorkflowCommand {
  return {
    ...cmd,
    async getPromptForCommand(
      args: string,
      context: ToolUseContext,
    ): Promise<ContentBlockParam[]> {
      const blocks = await cmd.getPromptForCommand(args, context)
      const contract = buildWorkflowExecutionContract(cmd)

      if (!contract) {
        return blocks
      }

      return [{ type: 'text', text: `${contract}\n\n` }, ...blocks]
    },
  }
}
