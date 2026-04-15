import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const TUNGSTEN_TOOL_NAME = 'Tungsten'
type TungstenSession = {
  id: string
  task?: string
  command?: string
  usedAt: number
}

let initialized = false
const sessions = new Map<string, TungstenSession>()

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z.string().optional().describe('The terminal command to run'),
    task: z
      .string()
      .optional()
      .describe('Optional high-level task label for the terminal session'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string(),
    sessionId: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export function clearSessionsWithTungstenUsage(): void {
  sessions.clear()
}

export function resetInitializationState(): void {
  initialized = false
}

export const TungstenTool = buildTool({
  name: TUNGSTEN_TOOL_NAME,
  searchHint: 'manage a shared terminal workspace',
  maxResultSizeChars: 20_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return process.env.USER_TYPE === 'ant'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async description() {
    return 'Manage a shared terminal-session ledger for long-running shell work.'
  },
  async prompt() {
    return 'Use Tungsten to reserve or update a shared terminal-style work session and keep its state visible to the operator.'
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage(output) {
    return output.message
  },
  async call(input) {
    initialized = true
    const sessionId = `tungsten-${sessions.size + 1}`
    const session: TungstenSession = {
      id: sessionId,
      task: input.task,
      command: input.command,
      usedAt: Date.now(),
    }
    sessions.set(sessionId, session)

    return {
      data: {
        message: input.command
          ? `Tracked Tungsten session ${sessionId} for "${input.command}".`
          : `Tracked Tungsten session ${sessionId}${input.task ? ` for ${input.task}` : ''}.`,
        sessionId,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)

export function getTungstenSessions(): TungstenSession[] {
  return Array.from(sessions.values()).sort((a, b) => b.usedAt - a.usedAt)
}

export function isTungstenInitialized(): boolean {
  return initialized
}
