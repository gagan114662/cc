import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { VERIFY_PLAN_EXECUTION_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    plan: z.string().describe('The plan or execution summary to verify'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    verified: z.boolean(),
    summary: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export const VerifyPlanExecutionTool = buildTool({
  name: VERIFY_PLAN_EXECUTION_TOOL_NAME,
  searchHint: 'verify whether a plan was executed',
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
    return 'Check whether a plan appears to have been executed successfully.'
  },
  async prompt() {
    return 'Verify execution conservatively by checking the submitted plan summary for concrete completion evidence.'
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
    return output.summary
  },
  async call(input, context) {
    const appState = context.getAppState()
    const pending = appState.pendingPlanVerification
    const plan = pending?.plan || input.plan
    const normalizedPlan = plan
      .split('\n')
      .map(line => line.replace(/^\s*[-*0-9.]+\s*/, '').trim())
      .filter(Boolean)

    const completed = normalizedPlan.length > 0
      ? normalizedPlan.filter(step => {
          const normalizedStep = step.toLowerCase()
          return ['done', 'complete', 'verify', 'test', 'build', 'fix'].some(
            token => normalizedStep.includes(token),
          )
        }).length
      : 0

    const verified =
      normalizedPlan.length === 0
        ? false
        : completed >= Math.max(1, Math.ceil(normalizedPlan.length / 2))

    context.setAppState(prev => ({
      ...prev,
      pendingPlanVerification: prev.pendingPlanVerification
        ? {
            ...prev.pendingPlanVerification,
            verificationStarted: true,
            verificationCompleted: verified,
          }
        : prev.pendingPlanVerification,
    }))

    return {
      data: {
        verified,
        summary: verified
          ? `Plan verification completed. Reviewed ${normalizedPlan.length} step(s) and found enough execution evidence in the submitted plan summary to mark it verified.`
          : normalizedPlan.length === 0
            ? 'Plan verification could not run because no plan steps were provided.'
            : `Plan verification is still inconclusive. Reviewed ${normalizedPlan.length} step(s), but the submitted plan summary does not yet show enough completed execution evidence.`,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
