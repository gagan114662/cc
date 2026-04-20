import { randomUUID } from 'crypto'
import type {
  SkillToolProgress,
  ToolCallProgress,
  ToolResult,
  ToolUseContext,
} from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { extractResultText } from '../../utils/forkedAgent.js'
import { createUserMessage, normalizeMessages } from '../../utils/messages.js'
import {
  buildWorkflowCodeModePrompt,
  buildWorkflowStepExecutionPrompt,
  buildWorkflowSynthesisRepairPrompt,
  buildWorkflowSynthesisPrompt,
  createWorkflowFailureState,
  createWorkflowSkippedState,
  extractWorkflowProgramSource,
  formatWorkflowFinalResult,
  parseWorkflowFinalState,
  parseWorkflowStepState,
  validateWorkflowFinalState,
  type WorkflowCommand,
  type WorkflowFinalState,
  type WorkflowStepOutcome,
  type WorkflowStepState,
} from '../../utils/workflowCommands.js'
import { createAgentId } from '../../utils/uuid.js'
import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { runAgent } from '../AgentTool/runAgent.js'
import { CodeModeExecutor, type CodeModeStateStore } from './codeModeExecutor.js'

type ForkedWorkflowOutput = {
  success: true
  commandName: string
  status: 'forked'
  agentId: string
  result: string
}

type WorkflowStageKind = 'codegen' | 'step' | 'synthesis'

export type WorkflowStageRunner = (args: {
  prompt: string
  stageKind: WorkflowStageKind
  stageIndex: number
  agentId: string
  transcriptSubdir: string
}) => Promise<string>

type WorkflowSynthesisResult = {
  rawResult: string
  finalState: WorkflowFinalState
}

type WorkflowOutcomeMap = Map<number, WorkflowStepOutcome>

type ExecuteForkedWorkflowArgs = {
  command: WorkflowCommand
  commandName: string
  args: string
  context: ToolUseContext
  canUseTool: CanUseToolFn
  parentMessage: AssistantMessage
  onProgress?: ToolCallProgress<SkillToolProgress>
  modifiedGetAppState: ToolUseContext['getAppState']
  agentDefinition: AgentDefinition
  skillContent: string
  stageRunner?: WorkflowStageRunner
  codeModeStatePath?: string
  codeModeSharedStatePath?: string
}

function buildCombinedHandoff(
  outcomes: WorkflowStepOutcome[],
): Record<string, string> {
  return Object.assign({}, ...outcomes.map(outcome => outcome.state.handoff))
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertValidWorkflowStepIndex(
  workflowSteps: NonNullable<WorkflowCommand['workflowSteps']>,
  stepIndex: number,
): void {
  if (!Number.isInteger(stepIndex)) {
    throw new Error(`Workflow step index must be an integer, got ${stepIndex}`)
  }

  if (stepIndex < 0 || stepIndex >= workflowSteps.length) {
    throw new Error(
      `Workflow step index ${stepIndex} is out of bounds for ${workflowSteps.length} workflow steps`,
    )
  }
}

function hasRequiredHandoff(
  requiredFields: string[] | undefined,
  handoff: Record<string, string>,
): boolean {
  if (!requiredFields || requiredFields.length === 0) {
    return true
  }

  return requiredFields.every(field => Boolean(handoff[field]))
}

function materializeWorkflowOutcomes(
  workflowSteps: NonNullable<WorkflowCommand['workflowSteps']>,
  outcomeMap: WorkflowOutcomeMap,
): WorkflowStepOutcome[] {
  return workflowSteps.flatMap((_, stepIndex) => {
    const outcome = outcomeMap.get(stepIndex)
    return outcome ? [outcome] : []
  })
}

function buildSkippedWorkflowSummary(args: {
  step: NonNullable<WorkflowCommand['workflowSteps']>[number]
  stepOutcomes: WorkflowStepOutcome[]
  explicitReason?: string
}): string {
  const explicitReason = args.explicitReason?.trim()
  if (explicitReason) {
    return `Skipped: ${explicitReason}`
  }

  const combinedHandoff = buildCombinedHandoff(args.stepOutcomes)
  if (!hasRequiredHandoff(args.step.requiresHandoff, combinedHandoff)) {
    const missingFields =
      args.step.requiresHandoff?.filter(field => !combinedHandoff[field]) ?? []
    return `Skipped: missing required handoff fields (${missingFields.join(', ')})`
  }

  return 'Skipped: workflow program did not invoke this step'
}

function createSkippedWorkflowOutcome(
  step: NonNullable<WorkflowCommand['workflowSteps']>[number],
  summary: string,
): WorkflowStepOutcome {
  return {
    step,
    result: summary,
    state: createWorkflowSkippedState(summary),
  }
}

async function runWorkflowStepWithRetries(args: {
  command: WorkflowCommand
  skillContent: string
  stepOutcomes: WorkflowStepOutcome[]
  stepIndex: number
  argsText: string
  runStage: WorkflowStageRunner
  transcriptSubdir: string
}): Promise<{
  result: string
  state: WorkflowStepState
}> {
  const {
    command,
    skillContent,
    stepOutcomes,
    stepIndex,
    argsText,
    runStage,
    transcriptSubdir,
  } = args
  const step = command.workflowSteps?.[stepIndex]
  if (!step) {
    throw new Error(`Missing workflow step at index ${stepIndex}`)
  }

  const maxAttempts = 1 + (step.retryCount ?? 0)
  let lastFailure: string | null = null

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const prompt = buildWorkflowStepExecutionPrompt(
      command,
      skillContent,
      argsText,
      step,
      stepIndex,
      stepOutcomes,
      {
        attemptNumber: attemptIndex + 1,
        maxAttempts,
        previousFailure: lastFailure,
      },
    )
    const agentId = createAgentId()

    try {
      const result = await runStage({
        prompt,
        stageKind: 'step',
        stageIndex: stepIndex,
        agentId,
        transcriptSubdir,
      })
      const state = parseWorkflowStepState(result, command)
      if (state.structured || attemptIndex === maxAttempts - 1) {
        return { result, state }
      }

      lastFailure =
        'Step did not return the required structured JSON handoff.'
    } catch (error) {
      lastFailure = summarizeError(error)
      if (attemptIndex === maxAttempts - 1) {
        throw error
      }
    }
  }

  throw new Error('Unreachable workflow retry state')
}

async function runWorkflowStepByIndex(args: {
  command: WorkflowCommand
  workflowSteps: NonNullable<WorkflowCommand['workflowSteps']>
  outcomeMap: WorkflowOutcomeMap
  skillContent: string
  stepIndex: number
  argsText: string
  runStage: WorkflowStageRunner
  transcriptSubdir: string
}): Promise<WorkflowStepOutcome> {
  const {
    command,
    workflowSteps,
    outcomeMap,
    skillContent,
    stepIndex,
    argsText,
    runStage,
    transcriptSubdir,
  } = args

  assertValidWorkflowStepIndex(workflowSteps, stepIndex)

  const existingOutcome = outcomeMap.get(stepIndex)
  if (existingOutcome) {
    return existingOutcome
  }

  const step = workflowSteps[stepIndex]!
  const stepOutcomes = materializeWorkflowOutcomes(workflowSteps, outcomeMap)
  const combinedHandoff = buildCombinedHandoff(stepOutcomes)
  if (!hasRequiredHandoff(step.requiresHandoff, combinedHandoff)) {
    const summary = buildSkippedWorkflowSummary({
      step,
      stepOutcomes,
    })
    const skippedOutcome = createSkippedWorkflowOutcome(step, summary)
    outcomeMap.set(stepIndex, skippedOutcome)
    return skippedOutcome
  }

  try {
    const { result, state } = await runWorkflowStepWithRetries({
      command,
      skillContent,
      stepOutcomes,
      stepIndex,
      argsText,
      runStage,
      transcriptSubdir,
    })

    const outcome = {
      step,
      result,
      state,
    }
    outcomeMap.set(stepIndex, outcome)
    return outcome
  } catch (error) {
    const summary = `Step failed: ${summarizeError(error)}`
    if (step.onFailure === 'continue') {
      const failureOutcome = {
        step,
        result: summary,
        state: createWorkflowFailureState(summary),
      }
      outcomeMap.set(stepIndex, failureOutcome)
      return failureOutcome
    }

    throw error
  }
}

async function executeCodeModeWorkflow(args: {
  command: WorkflowCommand
  workflowSteps: NonNullable<WorkflowCommand['workflowSteps']>
  skillContent: string
  argsText: string
  runStage: WorkflowStageRunner
  transcriptSubdir: string
  context: ToolUseContext
  codeModeStatePath?: string
  codeModeSharedStatePath?: string
}): Promise<{
  stepOutcomes: WorkflowStepOutcome[]
  stateStore: CodeModeStateStore
}> {
  const {
    command,
    workflowSteps,
    skillContent,
    argsText,
    runStage,
    transcriptSubdir,
    context,
    codeModeStatePath,
    codeModeSharedStatePath,
  } = args

  const codePrompt = buildWorkflowCodeModePrompt(command, skillContent, argsText)
  const rawProgram = await runStage({
    prompt: codePrompt,
    stageKind: 'codegen',
    stageIndex: 0,
    agentId: createAgentId(),
    transcriptSubdir,
  })
  const source = extractWorkflowProgramSource(rawProgram)
  if (!source) {
    throw new Error('Workflow code mode did not return any JavaScript source')
  }

  const outcomeMap: WorkflowOutcomeMap = new Map()
  const executor = await CodeModeExecutor.create({
    command,
    argsText,
    transcriptSubdir,
    context,
    commands: context.options.commands,
    statePath: codeModeStatePath,
    sharedStatePath: codeModeSharedStatePath,
    runStep: async stepIndex =>
      runWorkflowStepByIndex({
        command,
        workflowSteps,
        outcomeMap,
        skillContent,
        stepIndex,
        argsText,
        runStage,
        transcriptSubdir,
      }),
    skipStep: async (stepIndex, reason) => {
      assertValidWorkflowStepIndex(workflowSteps, stepIndex)
      const existingOutcome = outcomeMap.get(stepIndex)
      if (existingOutcome) {
        return existingOutcome
      }

      const stepOutcomes = materializeWorkflowOutcomes(workflowSteps, outcomeMap)
      const step = workflowSteps[stepIndex]!
      const summary = buildSkippedWorkflowSummary({
        step,
        stepOutcomes,
        explicitReason: reason,
      })
      const skippedOutcome = createSkippedWorkflowOutcome(step, summary)
      outcomeMap.set(stepIndex, skippedOutcome)
      return skippedOutcome
    },
    getHandoff: () =>
      buildCombinedHandoff(materializeWorkflowOutcomes(workflowSteps, outcomeMap)),
    getOutcomes: () => materializeWorkflowOutcomes(workflowSteps, outcomeMap),
    hasOutcome: stepIndex => {
      assertValidWorkflowStepIndex(workflowSteps, stepIndex)
      return outcomeMap.has(stepIndex)
    },
  })
  const { stateStore } = await executor.execute(source)

  for (const [stepIndex, step] of workflowSteps.entries()) {
    if (outcomeMap.has(stepIndex)) {
      continue
    }

    const stepOutcomes = materializeWorkflowOutcomes(workflowSteps, outcomeMap)
    const summary = buildSkippedWorkflowSummary({
      step,
      stepOutcomes,
    })
    outcomeMap.set(stepIndex, createSkippedWorkflowOutcome(step, summary))
  }

  const stepOutcomes = materializeWorkflowOutcomes(workflowSteps, outcomeMap)
  await stateStore.recordOutcomes(stepOutcomes)

  return {
    stepOutcomes,
    stateStore,
  }
}

async function runWorkflowSynthesisWithValidation(args: {
  command: WorkflowCommand
  skillContent: string
  stepOutcomes: WorkflowStepOutcome[]
  argsText: string
  runStage: WorkflowStageRunner
  transcriptSubdir: string
}): Promise<WorkflowSynthesisResult> {
  const {
    command,
    skillContent,
    stepOutcomes,
    argsText,
    runStage,
    transcriptSubdir,
  } = args

  let prompt = buildWorkflowSynthesisPrompt(
    command,
    skillContent,
    argsText,
    stepOutcomes,
  )

  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    const rawResult = await runStage({
      prompt,
      stageKind: 'synthesis',
      stageIndex: (command.workflowSteps?.length ?? 0) + attemptIndex,
      agentId: createAgentId(),
      transcriptSubdir,
    })
    const finalState = parseWorkflowFinalState(rawResult)
    const validation = validateWorkflowFinalState(
      finalState,
      command,
      stepOutcomes,
    )
    if (validation.valid) {
      return { rawResult, finalState }
    }

    if (attemptIndex === 1) {
      throw new Error(
        `Workflow synthesis did not produce a valid artifact contract: ${validation.issues.join('; ')}`,
      )
    }

    prompt = buildWorkflowSynthesisRepairPrompt(
      command,
      skillContent,
      argsText,
      stepOutcomes,
      rawResult,
      validation.issues,
    )
  }

  throw new Error('Unreachable workflow synthesis retry state')
}

function reportWorkflowProgress(
  message: Message,
  prompt: string,
  agentId: string,
  parentMessage: AssistantMessage,
  onProgress?: ToolCallProgress<SkillToolProgress>,
): void {
  if (
    !onProgress ||
    (message.type !== 'assistant' && message.type !== 'user')
  ) {
    return
  }

  const normalized = normalizeMessages([message])
  for (const normalizedMessage of normalized) {
    const hasToolContent = normalizedMessage.message.content.some(
      content => content.type === 'tool_use' || content.type === 'tool_result',
    )
    if (!hasToolContent) {
      continue
    }

    onProgress({
      toolUseID: `skill_${parentMessage.message.id}`,
      data: {
        message: normalizedMessage,
        type: 'skill_progress',
        prompt,
        agentId,
      },
    })
  }
}

function createDefaultWorkflowStageRunner({
  context,
  canUseTool,
  parentMessage,
  onProgress,
  modifiedGetAppState,
  agentDefinition,
  command,
}: Pick<
  ExecuteForkedWorkflowArgs,
  | 'context'
  | 'canUseTool'
  | 'parentMessage'
  | 'onProgress'
  | 'modifiedGetAppState'
  | 'agentDefinition'
  | 'command'
>): WorkflowStageRunner {
  return async ({ prompt, stageKind, stageIndex, agentId, transcriptSubdir }) => {
    const agentMessages: Message[] = []

    logForDebugging(
      `SkillTool executing workflow ${command.name} ${stageKind} ${stageIndex + 1} with agent ${agentDefinition.agentType}`,
    )

    try {
      for await (const message of runAgent({
        agentDefinition,
        promptMessages: [createUserMessage({ content: prompt })],
        toolUseContext: {
          ...context,
          getAppState: modifiedGetAppState,
        },
        canUseTool,
        isAsync: false,
        querySource: 'agent:custom',
        model: command.model,
        availableTools: context.options.tools,
        override: { agentId },
        transcriptSubdir,
      })) {
        agentMessages.push(message)
        reportWorkflowProgress(
          message,
          prompt,
          agentId,
          parentMessage,
          onProgress,
        )
      }

      return extractResultText(
        agentMessages,
        `${stageKind === 'step' ? 'Workflow step' : stageKind === 'codegen' ? 'Workflow code generation' : 'Workflow synthesis'} completed`,
      )
    } finally {
      clearInvokedSkillsForAgent(agentId)
    }
  }
}

export async function executeForkedWorkflow({
  command,
  commandName,
  args,
  context,
  canUseTool,
  parentMessage,
  onProgress,
  modifiedGetAppState,
  agentDefinition,
  skillContent,
  stageRunner,
  codeModeStatePath,
  codeModeSharedStatePath,
}: ExecuteForkedWorkflowArgs): Promise<ToolResult<ForkedWorkflowOutput>> {
  const workflowSteps = command.workflowSteps ?? []
  if (workflowSteps.length === 0) {
    throw new Error('Workflow execution requires at least one declared step')
  }

  const runId = randomUUID()
  const transcriptSubdir = `workflows/${runId}`
  const runStage =
    stageRunner ??
    createDefaultWorkflowStageRunner({
      context,
      canUseTool,
      parentMessage,
      onProgress,
      modifiedGetAppState,
      agentDefinition,
      command,
    })

  let codeModeStateStore: CodeModeStateStore | undefined
  const stepOutcomes =
    command.workflowRuntime === 'code'
      ? await (async (): Promise<WorkflowStepOutcome[]> => {
          const result = await executeCodeModeWorkflow({
            command,
            workflowSteps,
            skillContent,
            argsText: args,
            runStage,
            transcriptSubdir,
            context,
            codeModeStatePath,
            codeModeSharedStatePath,
          })
          codeModeStateStore = result.stateStore
          return result.stepOutcomes
        })()
      : await (async (): Promise<WorkflowStepOutcome[]> => {
          const outcomeMap: WorkflowOutcomeMap = new Map()
          for (const [stepIndex] of workflowSteps.entries()) {
            await runWorkflowStepByIndex({
              command,
              workflowSteps,
              outcomeMap,
              skillContent,
              stepIndex,
              argsText: args,
              runStage,
              transcriptSubdir,
            })
          }

          return materializeWorkflowOutcomes(workflowSteps, outcomeMap)
        })()

  const synthesisAgentId = createAgentId()
  let finalState: WorkflowFinalState
  try {
    const synthesisResult = await runWorkflowSynthesisWithValidation({
      command,
      skillContent,
      stepOutcomes,
      argsText: args,
      runStage: async stageArgs =>
        runStage({
          ...stageArgs,
          agentId: synthesisAgentId,
        }),
      transcriptSubdir,
    })
    finalState = synthesisResult.finalState
    if (codeModeStateStore) {
      await codeModeStateStore.setFinalState(finalState)
    }
  } catch (error) {
    if (codeModeStateStore) {
      await codeModeStateStore.setPhase('failed', summarizeError(error))
    }
    throw error
  }
  const finalResult = formatWorkflowFinalResult(finalState)

  return {
    data: {
      success: true,
      commandName,
      status: 'forked',
      agentId: synthesisAgentId,
      result: finalResult,
    },
  }
}
