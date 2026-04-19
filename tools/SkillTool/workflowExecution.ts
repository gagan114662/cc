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
  buildWorkflowStepExecutionPrompt,
  buildWorkflowSynthesisPrompt,
  createWorkflowFailureState,
  createWorkflowSkippedState,
  parseWorkflowStepState,
  type WorkflowCommand,
  type WorkflowStepOutcome,
  type WorkflowStepState,
} from '../../utils/workflowCommands.js'
import { createAgentId } from '../../utils/uuid.js'
import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { runAgent } from '../AgentTool/runAgent.js'

type ForkedWorkflowOutput = {
  success: true
  commandName: string
  status: 'forked'
  agentId: string
  result: string
}

type WorkflowStageKind = 'step' | 'synthesis'

export type WorkflowStageRunner = (args: {
  prompt: string
  stageKind: WorkflowStageKind
  stageIndex: number
  agentId: string
  transcriptSubdir: string
}) => Promise<string>

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
}

function buildCombinedHandoff(
  outcomes: WorkflowStepOutcome[],
): Record<string, string> {
  return Object.assign({}, ...outcomes.map(outcome => outcome.state.handoff))
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
        `${stageKind === 'step' ? 'Workflow step' : 'Workflow synthesis'} completed`,
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

  const stepOutcomes: WorkflowStepOutcome[] = []

  for (const [stepIndex, step] of workflowSteps.entries()) {
    const combinedHandoff = buildCombinedHandoff(stepOutcomes)
    if (!hasRequiredHandoff(step.requiresHandoff, combinedHandoff)) {
      const missingFields =
        step.requiresHandoff?.filter(field => !combinedHandoff[field]) ?? []
      const summary = `Skipped: missing required handoff fields (${missingFields.join(', ')})`
      stepOutcomes.push({
        step,
        result: summary,
        state: createWorkflowSkippedState(summary),
      })
      continue
    }

    try {
      const { result, state } = await runWorkflowStepWithRetries({
        command,
        skillContent,
        stepOutcomes,
        stepIndex,
        argsText: args,
        runStage,
        transcriptSubdir,
      })

      stepOutcomes.push({
        step,
        result,
        state,
      })
    } catch (error) {
      const summary = `Step failed: ${summarizeError(error)}`
      if (step.onFailure === 'continue') {
        stepOutcomes.push({
          step,
          result: summary,
          state: createWorkflowFailureState(summary),
        })
        continue
      }

      throw error
    }
  }

  const synthesisPrompt = buildWorkflowSynthesisPrompt(
    command,
    skillContent,
    args,
    stepOutcomes,
  )
  const synthesisAgentId = createAgentId()
  const finalResult = await runStage({
    prompt: synthesisPrompt,
    stageKind: 'synthesis',
    stageIndex: workflowSteps.length,
    agentId: synthesisAgentId,
    transcriptSubdir,
  })

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
