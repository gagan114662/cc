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
  parseWorkflowStepState,
  type WorkflowCommand,
  type WorkflowStepOutcome,
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
    const prompt = buildWorkflowStepExecutionPrompt(
      command,
      skillContent,
      args,
      step,
      stepIndex,
      stepOutcomes,
    )
    const agentId = createAgentId()
    const result = await runStage({
      prompt,
      stageKind: 'step',
      stageIndex: stepIndex,
      agentId,
      transcriptSubdir,
    })

    stepOutcomes.push({
      step,
      result,
      state: parseWorkflowStepState(result, command),
    })
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
