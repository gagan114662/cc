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

export type WorkflowOutputState = {
  name: string
  status: 'produced' | 'missing'
  evidence: string
}

export type WorkflowArtifactState = {
  kind: string
  status: 'produced' | 'missing'
  evidence: string
}

export type WorkflowSuccessCriterionState = {
  criterion: string
  status: 'met' | 'unmet'
  evidence: string
}

export type WorkflowFinalState = {
  structured: boolean
  summary: string
  completionStatus: 'completed' | 'partial' | 'blocked'
  outputs: WorkflowOutputState[]
  artifacts: WorkflowArtifactState[]
  successCriteria: WorkflowSuccessCriterionState[]
  missingInputs: string[]
  unresolvedRisks: string[]
}

export type WorkflowFinalValidation = {
  valid: boolean
  issues: string[]
}

export type WorkflowCodeProgram = {
  source: string
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

export function buildWorkflowCodeModePrompt(
  cmd: WorkflowCommand,
  skillContent: string,
  args: string,
): string {
  const lines = [
    `You are writing JavaScript to orchestrate workflow "${cmd.userFacingName?.() ?? cmd.name}".`,
    'Return ONLY JavaScript that evaluates to an async function `(api) => { ... }`.',
    'Use code to decide sequencing, branching, looping, and state instead of explaining the workflow in prose.',
  ]

  const contract = buildWorkflowExecutionContract(cmd)
  if (contract) {
    lines.push('', contract)
  }

  if (args.trim()) {
    lines.push('', `Workflow arguments: ${args.trim()}`)
  }

  lines.push(
    '',
    'The runtime API passed to your function has:',
    '- `workflow`: readonly workflow metadata including `steps`, `outputs`, `artifactKinds`, and `successCriteria`',
    '- `args`: the raw workflow argument string',
    '- `state`: a mutable plain object for temporary state',
    '- `await runStep(stepIndex)`: execute one declared step and return its structured result',
    '- `await skipStep(stepIndex, reason?)`: mark a step as skipped',
    '- `getHandoff()`: returns the accumulated structured handoff object',
    '- `getOutcomes()`: returns the structured outcomes recorded so far',
    '- `hasOutcome(stepIndex)`: returns whether that step already has an outcome',
  )

  lines.push(
    '',
    'Rules:',
    '- Do not import modules or reference Node globals.',
    '- Only use the provided runtime API.',
    '- Prefer declared workflow steps over inventing ad hoc tasks.',
    '- If a step is not applicable, explicitly skip it with a concise reason.',
    '- Keep the program concise and executable as-is.',
  )

  lines.push('', 'Workflow reference:')
  lines.push(skillContent.trim())

  lines.push(
    '',
    'Return ONLY JavaScript for an async function. Example:',
    'async ({ runStep, getHandoff, skipStep }) => {',
    '  await runStep(0)',
    '  if (getHandoff().priority_segment) {',
    '    await runStep(1)',
    '  } else {',
    "    await skipStep(1, 'Missing priority segment')",
    '  }',
    '}',
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
    'Return ONLY JSON with this shape:',
    '{',
    '  "summary": "overall workflow result",',
    '  "completionStatus": "completed | partial | blocked",',
    `  "outputs": [${buildWorkflowOutputTemplate(cmd)}],`,
    `  "artifacts": [${buildWorkflowArtifactTemplate(cmd)}],`,
    `  "successCriteria": [${buildWorkflowSuccessTemplate(cmd)}],`,
    '  "missingInputs": ["required inputs that were unavailable"],',
    '  "unresolvedRisks": ["follow-up risk, blocker, or caveat"]',
    '}',
    'Copy the exact expected output names, artifact kinds, and success criteria from the workflow contract.',
    'If something was not produced or not met, mark it as missing/unmet instead of omitting it.',
    'Do not claim completion when required outputs or success criteria are still missing.',
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

function buildWorkflowOutputTemplate(cmd: WorkflowCommand): string {
  const outputs = cmd.outputs ?? []
  if (outputs.length === 0) {
    return '{"name": "primary deliverable", "status": "produced", "evidence": "how it was produced"}'
  }

  return outputs
    .map(
      output =>
        `{"name": ${JSON.stringify(output)}, "status": "produced | missing", "evidence": "proof or gap"}`,
    )
    .join(', ')
}

function buildWorkflowArtifactTemplate(cmd: WorkflowCommand): string {
  const artifactKinds = cmd.artifactKinds ?? []
  if (artifactKinds.length === 0) {
    return '{"kind": "deliverable", "status": "produced", "evidence": "artifact or proof"}'
  }

  return artifactKinds
    .map(
      artifactKind =>
        `{"kind": ${JSON.stringify(artifactKind)}, "status": "produced | missing", "evidence": "artifact or gap"}`,
    )
    .join(', ')
}

function buildWorkflowSuccessTemplate(cmd: WorkflowCommand): string {
  const successCriteria = cmd.successCriteria ?? []
  if (successCriteria.length === 0) {
    return '{"criterion": "workflow completed", "status": "met", "evidence": "what proves completion"}'
  }

  return successCriteria
    .map(
      criterion =>
        `{"criterion": ${JSON.stringify(criterion)}, "status": "met | unmet", "evidence": "supporting evidence or gap"}`,
    )
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

export function extractWorkflowProgramSource(value: string): string {
  const fencedMatch = value.match(/```(?:javascript|js|ts|typescript)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  return value.trim()
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

function normalizeWorkflowOutputList(value: unknown): WorkflowOutputState[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return []
    }

    const name =
      typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null
    const status =
      item.status === 'produced' || item.status === 'missing'
        ? item.status
        : null
    const evidence =
      typeof item.evidence === 'string' ? item.evidence.trim() : ''

    if (!name || !status) {
      return []
    }

    return [{ name, status, evidence }]
  })
}

function normalizeWorkflowArtifactList(value: unknown): WorkflowArtifactState[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return []
    }

    const kind =
      typeof item.kind === 'string' && item.kind.trim() ? item.kind.trim() : null
    const status =
      item.status === 'produced' || item.status === 'missing'
        ? item.status
        : null
    const evidence =
      typeof item.evidence === 'string' ? item.evidence.trim() : ''

    if (!kind || !status) {
      return []
    }

    return [{ kind, status, evidence }]
  })
}

function normalizeWorkflowSuccessList(
  value: unknown,
): WorkflowSuccessCriterionState[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return []
    }

    const criterion =
      typeof item.criterion === 'string' && item.criterion.trim()
        ? item.criterion.trim()
        : null
    const status =
      item.status === 'met' || item.status === 'unmet' ? item.status : null
    const evidence =
      typeof item.evidence === 'string' ? item.evidence.trim() : ''

    if (!criterion || !status) {
      return []
    }

    return [{ criterion, status, evidence }]
  })
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

export function parseWorkflowFinalState(
  result: string,
): WorkflowFinalState {
  const fallback: WorkflowFinalState = {
    structured: false,
    summary: result.trim() || 'Workflow completed',
    completionStatus: 'partial',
    outputs: [],
    artifacts: [],
    successCriteria: [],
    missingInputs: [],
    unresolvedRisks: [],
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
    const completionStatus =
      parsed.completionStatus === 'completed' ||
      parsed.completionStatus === 'partial' ||
      parsed.completionStatus === 'blocked'
        ? parsed.completionStatus
        : fallback.completionStatus

    return {
      structured: true,
      summary,
      completionStatus,
      outputs: normalizeWorkflowOutputList(parsed.outputs),
      artifacts: normalizeWorkflowArtifactList(parsed.artifacts),
      successCriteria: normalizeWorkflowSuccessList(parsed.successCriteria),
      missingInputs: normalizeStringList(parsed.missingInputs),
      unresolvedRisks: normalizeStringList(parsed.unresolvedRisks),
    }
  } catch {
    return fallback
  }
}

function validateExpectedItems<T extends { status: string; evidence: string }>(
  label: string,
  expected: string[] | undefined,
  actual: T[],
  keyOf: (value: T) => string,
  producedStatus: string,
): string[] {
  const normalizedExpected = expected?.map(value => value.trim()).filter(Boolean) ?? []
  if (normalizedExpected.length === 0) {
    return []
  }

  const issues: string[] = []
  const actualByKey = new Map(actual.map(value => [keyOf(value), value]))

  for (const expectedValue of normalizedExpected) {
    const actualValue = actualByKey.get(expectedValue)
    if (!actualValue) {
      issues.push(`Missing ${label}: ${expectedValue}`)
      continue
    }
    if (actualValue.status !== producedStatus) {
      issues.push(`${label} not satisfied: ${expectedValue}`)
      continue
    }
    if (!actualValue.evidence.trim()) {
      issues.push(`${label} missing evidence: ${expectedValue}`)
    }
  }

  return issues
}

export function validateWorkflowFinalState(
  state: WorkflowFinalState,
  cmd: WorkflowCommand,
): WorkflowFinalValidation {
  const issues: string[] = []

  if (!state.structured) {
    issues.push('Final workflow result did not return structured JSON.')
  }

  issues.push(
    ...validateExpectedItems(
      'output',
      cmd.outputs,
      state.outputs,
      value => value.name,
      'produced',
    ),
  )
  issues.push(
    ...validateExpectedItems(
      'artifact',
      cmd.artifactKinds,
      state.artifacts,
      value => value.kind,
      'produced',
    ),
  )
  issues.push(
    ...validateExpectedItems(
      'success criterion',
      cmd.successCriteria,
      state.successCriteria,
      value => value.criterion,
      'met',
    ),
  )

  if (
    state.completionStatus === 'completed' &&
    (state.missingInputs.length > 0 ||
      state.outputs.some(output => output.status !== 'produced') ||
      state.artifacts.some(artifact => artifact.status !== 'produced') ||
      state.successCriteria.some(criterion => criterion.status !== 'met'))
  ) {
    issues.push(
      'Completion status cannot be "completed" while required outputs, artifacts, inputs, or success criteria are still missing.',
    )
  }

  return {
    valid: issues.length === 0,
    issues,
  }
}

export function buildWorkflowSynthesisRepairPrompt(
  cmd: WorkflowCommand,
  skillContent: string,
  args: string,
  outcomes: WorkflowStepOutcome[],
  previousResult: string,
  validationIssues: string[],
): string {
  const lines = [
    buildWorkflowSynthesisPrompt(cmd, skillContent, args, outcomes),
    '',
    'Your previous answer failed workflow artifact validation.',
    'Fix these issues exactly:',
    ...validationIssues.map(issue => `- ${issue}`),
    '',
    'Previous invalid result:',
    previousResult.trim(),
    '',
    'Return ONLY corrected JSON.',
  ]

  return lines.join('\n')
}

function formatWorkflowCoverageSection<T extends { status: string; evidence: string }>(
  title: string,
  entries: T[],
  getLabel: (value: T) => string,
): string[] {
  if (entries.length === 0) {
    return []
  }

  return [
    `${title}:`,
    ...entries.map(entry => {
      const evidenceText = entry.evidence ? ` (${entry.evidence})` : ''
      return `- ${getLabel(entry)}: ${entry.status}${evidenceText}`
    }),
  ]
}

export function formatWorkflowFinalResult(state: WorkflowFinalState): string {
  const lines = [state.summary, `Completion: ${state.completionStatus}`]

  lines.push(
    ...formatWorkflowCoverageSection('Outputs', state.outputs, value => value.name),
  )
  lines.push(
    ...formatWorkflowCoverageSection(
      'Artifacts',
      state.artifacts,
      value => value.kind,
    ),
  )
  lines.push(
    ...formatWorkflowCoverageSection(
      'Success criteria',
      state.successCriteria,
      value => value.criterion,
    ),
  )

  if (state.missingInputs.length > 0) {
    lines.push(`Missing inputs: ${state.missingInputs.join(', ')}`)
  }
  if (state.unresolvedRisks.length > 0) {
    lines.push(`Open risks: ${state.unresolvedRisks.join(', ')}`)
  }

  return lines.join('\n')
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
