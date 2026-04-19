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

export type WorkflowStepState = {
  status: 'completed' | 'failed' | 'skipped'
  structured: boolean
  summary: string
  artifacts: string[]
  risks: string[]
  handoff: Record<string, string>
}

export type WorkflowStepOutcome = {
  step: WorkflowStep
  result: string
  state: WorkflowStepState
}

type WorkflowSummaryOptions = {
  includeWhenToUse?: boolean
  includeVerbs?: boolean
  includeInputs?: boolean
  includeOutputs?: boolean
  includeArtifactKinds?: boolean
  includeSuccessCriteria?: boolean
  includeHandoffFields?: boolean
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
    includeVerbs = true,
    includeInputs = true,
    includeOutputs = true,
    includeArtifactKinds = true,
    includeSuccessCriteria = true,
    includeHandoffFields = true,
    includeTools = false,
    includeArguments = false,
    includeSteps = true,
  } = options

  const parts = [cmd.description]

  if (includeWhenToUse && cmd.whenToUse) {
    parts.push(`Use when: ${cmd.whenToUse}`)
  }

  if (includeVerbs) {
    const verbs = formatLabeledList('Operations', cmd.verbs)
    if (verbs) parts.push(verbs)
  }

  if (includeInputs) {
    const inputs = formatLabeledList('Inputs', cmd.inputs)
    if (inputs) parts.push(inputs)
  }

  if (includeOutputs) {
    const outputs = formatLabeledList('Outputs', cmd.outputs)
    if (outputs) parts.push(outputs)
  }

  if (includeArtifactKinds) {
    const artifacts = formatLabeledList('Artifacts', cmd.artifactKinds)
    if (artifacts) parts.push(artifacts)
  }

  if (includeSuccessCriteria) {
    const success = formatLabeledList('Success', cmd.successCriteria)
    if (success) parts.push(success)
  }

  if (includeHandoffFields) {
    const handoff = formatLabeledList('Handoff', cmd.handoffFields)
    if (handoff) parts.push(handoff)
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
    formatLabeledList('Operations', cmd.verbs),
    formatLabeledList('Inputs', cmd.inputs),
    formatLabeledList('Expected outputs', cmd.outputs),
    formatLabeledList('Artifact kinds', cmd.artifactKinds),
    formatLabeledList('Success criteria', cmd.successCriteria),
    formatLabeledList('Structured handoff', cmd.handoffFields),
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
    if (step.retryCount !== undefined) {
      stepLines.push(`   Retries: ${step.retryCount}`)
    }
    if (step.onFailure) {
      stepLines.push(`   On failure: ${step.onFailure}`)
    }
    if (step.requiresHandoff?.length) {
      stepLines.push(`   Requires handoff: ${step.requiresHandoff.join(', ')}`)
    }
    return stepLines
  })
}

function formatWorkflowStepOutcomeList(
  outcomes: WorkflowStepOutcome[],
  emptyText: string,
): string[] {
  if (outcomes.length === 0) {
    return [emptyText]
  }

  return outcomes.flatMap((outcome, index) => {
    const lines = [
      `${index + 1}. ${outcome.step.title}`,
      `Status: ${outcome.state.status}`,
      `Summary: ${outcome.state.summary}`,
    ]
    if (outcome.state.artifacts.length > 0) {
      lines.push(`Artifacts: ${outcome.state.artifacts.join(', ')}`)
    }
    if (outcome.state.risks.length > 0) {
      lines.push(`Risks: ${outcome.state.risks.join(', ')}`)
    }
    if (Object.keys(outcome.state.handoff).length > 0) {
      lines.push(`Handoff: ${formatWorkflowHandoff(outcome.state.handoff)}`)
    }
    lines.push(`Raw result: ${outcome.result.trim()}`)
    return lines
  })
}

function formatWorkflowHandoff(handoff: Record<string, string>): string {
  return Object.entries(handoff)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

export function buildWorkflowStepExecutionPrompt(
  cmd: WorkflowCommand,
  skillContent: string,
  args: string,
  step: WorkflowStep,
  stepIndex: number,
  priorOutcomes: WorkflowStepOutcome[],
  options: {
    attemptNumber?: number
    maxAttempts?: number
    previousFailure?: string | null
  } = {},
): string {
  const lines = [
    `You are executing step ${stepIndex + 1} of ${cmd.workflowSteps?.length ?? stepIndex + 1} for workflow "${cmd.userFacingName?.() ?? cmd.name}".`,
    'Complete only this step, then hand off the most useful state for the next step.',
  ]
  const attemptNumber = options.attemptNumber ?? 1
  const maxAttempts = options.maxAttempts ?? 1

  const contract = buildWorkflowExecutionContract(cmd)
  if (contract) {
    lines.push('', contract)
  }

  lines.push('', 'Current step:')
  lines.push(`Title: ${step.title}`)
  if (step.objective) {
    lines.push(`Objective: ${step.objective}`)
  }
  if (step.success) {
    lines.push(`Step success bar: ${step.success}`)
  }
  if (step.tools?.length) {
    lines.push(`Step tools: ${step.tools.join(', ')}`)
  }
  if (maxAttempts > 1) {
    lines.push(`Attempt: ${attemptNumber} of ${maxAttempts}`)
  }
  if (options.previousFailure) {
    lines.push(`Previous failure: ${options.previousFailure}`)
  }
  if (args.trim()) {
    lines.push(`Workflow arguments: ${args.trim()}`)
  }

  lines.push('', 'Completed steps so far:')
  lines.push(
    ...formatWorkflowStepOutcomeList(
      priorOutcomes,
      'None yet. Establish the initial fact base for the workflow.',
    ),
  )

  lines.push('', 'Workflow reference:')
  lines.push(skillContent.trim())
  lines.push(
    '',
    'Return ONLY JSON with this shape:',
    '{',
    '  "summary": "what this step completed",',
    '  "artifacts": ["durable outputs or evidence produced"],',
    '  "risks": ["open gaps, blockers, or follow-up risks"],',
    `  "handoff": {${buildWorkflowHandoffTemplate(cmd)}}`,
    '}',
    'Keep handoff values concise strings. If a handoff field is unknown, omit it instead of inventing it.',
  )

  return lines.join('\n')
}

export function buildWorkflowSynthesisPrompt(
  cmd: WorkflowCommand,
  skillContent: string,
  args: string,
  outcomes: WorkflowStepOutcome[],
): string {
  const lines = [
    `You have completed workflow "${cmd.userFacingName?.() ?? cmd.name}".`,
    'Synthesize the step outputs into the final workflow deliverable.',
  ]

  const contract = buildWorkflowExecutionContract(cmd)
  if (contract) {
    lines.push('', contract)
  }

  if (args.trim()) {
    lines.push('', `Workflow arguments: ${args.trim()}`)
  }

  lines.push('', 'Step outcomes:')
  lines.push(
    ...formatWorkflowStepOutcomeList(
      outcomes,
      'No step outcomes were captured. State that the workflow could not complete.',
    ),
  )

  lines.push('', 'Workflow reference:')
  lines.push(skillContent.trim())
  lines.push(
    '',
    'Return the final workflow result aligned to the expected outputs and success criteria.',
    'Call out any unresolved input gaps or follow-up risks explicitly instead of claiming the workflow is fully complete.',
  )

  return lines.join('\n')
}

function buildWorkflowHandoffTemplate(cmd: WorkflowCommand): string {
  const fields = cmd.handoffFields ?? []
  if (fields.length === 0) {
    return '"next_step_context": "key state for the next step"'
  }

  return fields
    .map(field => `"${field}": "..."`)
    .join(', ')
}

function extractJsonObject(value: string): string | null {
  const fencedMatch = value.match(/```json\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  const firstBrace = value.indexOf('{')
  const lastBrace = value.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null
  }

  return value.slice(firstBrace, lastBrace + 1)
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

export function parseWorkflowStepState(
  result: string,
  cmd: WorkflowCommand,
): WorkflowStepState {
  const fallback: WorkflowStepState = {
    status: 'completed',
    structured: false,
    summary: result.trim() || 'Step completed',
    artifacts: [],
    risks: [],
    handoff: {},
  }

  const jsonObject = extractJsonObject(result)
  if (!jsonObject) {
    return fallback
  }

  try {
    const parsed = JSON.parse(jsonObject) as Record<string, unknown>
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : fallback.summary
    const artifacts = normalizeStringList(parsed.artifacts)
    const risks = normalizeStringList(parsed.risks)
    const rawHandoff =
      parsed.handoff && typeof parsed.handoff === 'object' && !Array.isArray(parsed.handoff)
        ? (parsed.handoff as Record<string, unknown>)
        : {}
    const handoff = Object.fromEntries(
      Object.entries(rawHandoff)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([key, value]) => [key, String(value).trim()]),
    )

    if ((cmd.handoffFields?.length ?? 0) > 0) {
      for (const field of cmd.handoffFields ?? []) {
        if (!(field in handoff)) {
          continue
        }
      }
    }

    return {
      status: 'completed',
      structured: true,
      summary,
      artifacts,
      risks,
      handoff,
    }
  } catch {
    return fallback
  }
}

export function createWorkflowFailureState(summary: string): WorkflowStepState {
  return {
    status: 'failed',
    structured: false,
    summary,
    artifacts: [],
    risks: [summary],
    handoff: {},
  }
}

export function createWorkflowSkippedState(summary: string): WorkflowStepState {
  return {
    status: 'skipped',
    structured: false,
    summary,
    artifacts: [],
    risks: [],
    handoff: {},
  }
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
