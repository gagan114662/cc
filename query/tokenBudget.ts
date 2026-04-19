import { getBudgetContinuationMessage } from '../utils/tokenBudget.js'

const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_THRESHOLD = 500

export type BudgetTracker = {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  }
}

type ContinueDecision = {
  action: 'continue'
  nudgeMessage: string
  continuationCount: number
  pct: number
  turnTokens: number
  budget: number
}

type StopDecision = {
  action: 'stop'
  completionEvent: {
    continuationCount: number
    pct: number
    turnTokens: number
    budget: number
    diminishingReturns: boolean
    durationMs: number
  } | null
}

export type TokenBudgetDecision = ContinueDecision | StopDecision

// Per-duty/per-assignment hard ceiling. When either bound is exceeded,
// checkTokenBudget throws DutyBudgetExceededError instead of returning a
// decision. This is the mechanical difference from the per-turn
// `budget` arg (which only nudges/stops continuation, never throws).
export type DutyBudgetContext = {
  dutyId?: string
  assignmentId?: string
  // Hard token ceiling for this duty/assignment tick. Exceeding it throws.
  maxTokens?: number
  // Hard cumulative USD cap. Checked against currentCostUSD.
  maxCostUSD?: number
  currentCostUSD?: number
}

export class DutyBudgetExceededError extends Error {
  readonly dutyId?: string
  readonly assignmentId?: string
  readonly reason: 'tokens' | 'cost'
  readonly limit: number
  readonly observed: number

  constructor(args: {
    reason: 'tokens' | 'cost'
    limit: number
    observed: number
    dutyId?: string
    assignmentId?: string
  }) {
    const subject = args.dutyId
      ? `duty ${args.dutyId}`
      : args.assignmentId
        ? `assignment ${args.assignmentId}`
        : 'budget scope'
    super(
      `${subject} exceeded ${args.reason} ceiling (${args.observed} > ${args.limit})`,
    )
    this.name = 'DutyBudgetExceededError'
    this.dutyId = args.dutyId
    this.assignmentId = args.assignmentId
    this.reason = args.reason
    this.limit = args.limit
    this.observed = args.observed
  }
}

export function enforceDutyHardStop(
  globalTurnTokens: number,
  dutyContext: DutyBudgetContext | undefined,
): void {
  if (!dutyContext) return
  const { maxTokens, maxCostUSD, currentCostUSD, dutyId, assignmentId } =
    dutyContext
  if (typeof maxTokens === 'number' && maxTokens > 0 && globalTurnTokens > maxTokens) {
    throw new DutyBudgetExceededError({
      reason: 'tokens',
      limit: maxTokens,
      observed: globalTurnTokens,
      dutyId,
      assignmentId,
    })
  }
  if (
    typeof maxCostUSD === 'number' &&
    maxCostUSD > 0 &&
    typeof currentCostUSD === 'number' &&
    currentCostUSD > maxCostUSD
  ) {
    throw new DutyBudgetExceededError({
      reason: 'cost',
      limit: maxCostUSD,
      observed: currentCostUSD,
      dutyId,
      assignmentId,
    })
  }
}

export function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
  dutyContext?: DutyBudgetContext,
): TokenBudgetDecision {
  // Hard-stop enforcement runs first and is independent of the per-turn
  // continuation budget — a duty can exceed its ceiling mid-turn even when
  // the subagent budget hasn't triggered a nudge/stop yet.
  enforceDutyHardStop(globalTurnTokens, dutyContext)

  if (agentId || budget === null || budget <= 0) {
    return { action: 'stop', completionEvent: null }
  }

  const turnTokens = globalTurnTokens
  const pct = Math.round((turnTokens / budget) * 100)
  const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens

  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount++
    tracker.lastDeltaTokens = deltaSinceLastCheck
    tracker.lastGlobalTurnTokens = globalTurnTokens
    return {
      action: 'continue',
      nudgeMessage: getBudgetContinuationMessage(pct, turnTokens, budget),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens,
      budget,
    }
  }

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: 'stop',
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    }
  }

  return { action: 'stop', completionEvent: null }
}
