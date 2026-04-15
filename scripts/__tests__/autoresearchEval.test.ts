import { describe, it, expect } from 'bun:test'
import { aggregateObservationMetrics, median } from '../autoresearchEval.js'

describe('median', () => {
  it('returns 0 for empty array', () => {
    expect(median([])).toBe(0)
  })

  it('returns single value', () => {
    expect(median([5])).toBe(5)
  })

  it('returns middle value for odd-length array', () => {
    expect(median([1, 3, 2])).toBe(2)
  })

  it('returns average of middle two for even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})

describe('aggregateObservationMetrics', () => {
  it('returns median values from observations', () => {
    const observations = [
      { tokenCost: 0.10, runtimeMs: 10000, toolCallCount: 20 },
      { tokenCost: 0.20, runtimeMs: 30000, toolCallCount: 40 },
      { tokenCost: 0.15, runtimeMs: 20000, toolCallCount: 30 },
    ]
    const result = aggregateObservationMetrics(observations)
    expect(result.tokenCost).toBe(0.15)
    expect(result.runtimeMs).toBe(20000)
    expect(result.toolCallCount).toBe(30)
  })

  it('returns zeros when no observations have cost data', () => {
    const observations = [
      { tokenCost: undefined, runtimeMs: undefined, toolCallCount: undefined },
    ]
    const result = aggregateObservationMetrics(observations)
    expect(result.tokenCost).toBe(0)
    expect(result.runtimeMs).toBe(0)
    expect(result.toolCallCount).toBe(0)
  })

  it('returns zeros for empty array', () => {
    const result = aggregateObservationMetrics([])
    expect(result.tokenCost).toBe(0)
    expect(result.runtimeMs).toBe(0)
    expect(result.toolCallCount).toBe(0)
  })

  it('filters out zero and undefined values before computing median', () => {
    const observations = [
      { tokenCost: 0.10, runtimeMs: 10000, toolCallCount: 20 },
      { tokenCost: 0, runtimeMs: 0, toolCallCount: 0 },
      { tokenCost: undefined, runtimeMs: undefined, toolCallCount: undefined },
      { tokenCost: 0.20, runtimeMs: 30000, toolCallCount: 40 },
    ]
    const result = aggregateObservationMetrics(observations)
    expect(result.tokenCost).toBeCloseTo(0.15, 10)
    expect(result.runtimeMs).toBe(20000)
    expect(result.toolCallCount).toBe(30)
  })
})
