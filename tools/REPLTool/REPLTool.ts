import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { REPL_TOOL_NAME } from './constants.js'
import { getReplPrimitiveTools } from './primitiveTools.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    input: z.string().describe('The instruction to run through the REPL wrapper'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string(),
    primitiveTools: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
  searchHint: 'coordinate batched terminal work',
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
    return 'Summarize the primitive tools available through the REPL orchestration layer.'
  },
  async prompt() {
    return 'Use REPL when you want to reason about a grouped shell/file workflow before picking a primitive tool.'
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
    const primitiveTools = getReplPrimitiveTools().map(tool => tool.name)
    return {
      data: {
        message: `REPL plan accepted: "${input.input}". Available primitive tools: ${primitiveTools.join(', ')}.`,
        primitiveTools,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
