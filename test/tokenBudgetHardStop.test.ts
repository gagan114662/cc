// The per-turn tokenBudget nudge already existed; the new guarantee is
// that duty/assignment contexts impose a HARD stop that throws, not a
// soft nudge. These tests pin that behavior so future edits to the
// nudge-path don't silently neuter the hard-stop.

import { describe, expect, test } from 'bun:test'
import {
  checkTokenBudget,
  createBudgetTracker,
  DutyBudgetExceededError,
} from 'src/query/tokenBudget.js'

describe('checkTokenBudget — duty hard-stop', () => {
  test('throws DutyBudgetExceededError when maxTokens is exceeded', () => {
    const tracker = createBudgetTracker()
    expect(() =>
      checkTokenBudget(tracker, undefined, 100_000, 12_001, {
        dutyId: 'd1',
        maxTokens: 12_000,
      }),
    ).toThrow(DutyBudgetExceededError)
  })

  test('throws with reason=cost when cumulative USD exceeds cap', () => {
    const tracker = createBudgetTracker()
    try {
      checkTokenBudget(tracker, undefined, 100_000, 1_000, {
        dutyId: 'd-cost',
        maxCostUSD: 1.0,
        currentCostUSD: 1.25,
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DutyBudgetExceededError)
      const e = err as DutyBudgetExceededError
      expect(e.reason).toBe('cost')
      expect(e.limit).toBe(1.0)
      expect(e.observed).toBe(1.25)
      expect(e.dutyId).toBe('d-cost')
    }
  })

  test('stays backward compatible when no duty context is supplied', () => {
    const tracker = createBudgetTracker()
    const decision = checkTokenBudget(tracker, undefined, 100_000, 1_000)
    // Well under budget → continue nudge
    expect(decision.action).toBe('continue')
  })

  test('does not throw when cumulative cost is present but below cap', () => {
    const tracker = createBudgetTracker()
    expect(() =>
      checkTokenBudget(tracker, undefined, 100_000, 1_000, {
        dutyId: 'd-ok',
        maxCostUSD: 5.0,
        currentCostUSD: 0.75,
      }),
    ).not.toThrow()
  })

  test('ignores maxTokens when it is zero (disabled)', () => {
    const tracker = createBudgetTracker()
    expect(() =>
      checkTokenBudget(tracker, undefined, 100_000, 10_000_000, {
        dutyId: 'd-disabled',
        maxTokens: 0,
      }),
    ).not.toThrow()
  })
})
