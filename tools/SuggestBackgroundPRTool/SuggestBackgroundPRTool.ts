import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const SUGGEST_BACKGROUND_PR_TOOL_NAME = 'SuggestBackgroundPR'

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z.string().describe('The task or change summary to evaluate'),
    branch_name: z.string().optional().describe('Optional branch name'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    shouldSuggest: z.boolean(),
    reason: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export const SuggestBackgroundPRTool = buildTool({
  name: SUGGEST_BACKGROUND_PR_TOOL_NAME,
  searchHint: 'decide whether to propose a background PR',
  maxResultSizeChars: 10_000,
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
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return 'Evaluate whether a task should be turned into a background pull request workflow.'
  },
  async prompt() {
    return 'Return a conservative recommendation for whether a background PR flow should be suggested.'
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output),
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage(output) {
    return output.reason
  },
  async call(input) {
    const prompt = input.prompt.toLowerCase()
    const score =
      (/\b(pr|pull request|review|branch|commit)\b/.test(prompt) ? 2 : 0) +
      (/\b(refactor|migration|release|ci|deploy|verification|tests?)\b/.test(
        prompt,
      )
        ? 1
        : 0) +
      (input.branch_name ? 1 : 0)

    const shouldSuggest = score >= 2

    return {
      data: {
        shouldSuggest,
        reason: shouldSuggest
          ? 'This task looks like a good background PR candidate because it already reads like multi-step branch work that benefits from reviewable progress.'
          : 'This task currently looks better suited to the main interactive flow than to a background PR handoff.',
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
