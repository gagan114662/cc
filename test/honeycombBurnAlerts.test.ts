// Pins the pure helpers behind scripts/honeycombDeployBurnAlerts.ts:
// the exhaustion-minutes formula, per-flavor payload shape, and the
// create/update/skip plan against realistic existing-alert snapshots.
// The deploy script is otherwise HTTP-only — keeping these pure makes
// it safe to iterate on without touching Honeycomb.

import { describe, expect, test } from 'bun:test'
import {
  buildBurnAlertPayload,
  exhaustionMinutes,
  planBurnAlertDeployment,
  type ExistingBurnAlert,
  type ExistingSLO,
} from 'src/scripts/honeycombDeployBurnAlerts.js'
import {
  API_ERROR_RATE,
  ASSIGNMENT_LATENCY_P95,
  EMPLOYEE_DUTY_SUCCESS_RATE,
  STARTER_SLOS,
} from 'src/services/observability/slos.js'

describe('exhaustionMinutes', () => {
  test('28-day SLO at 14.4× burn → 2800 minutes (~46h)', () => {
    expect(exhaustionMinutes(28, 14.4)).toBe(2800)
  })

  test('28-day SLO at 6× burn → 6720 minutes (~4.7 days)', () => {
    expect(exhaustionMinutes(28, 6)).toBe(6720)
  })

  test('7-day SLO at 14.4× burn → 700 minutes', () => {
    expect(exhaustionMinutes(7, 14.4)).toBe(700)
  })

  test('rejects nonsensical zero / negative burn rates', () => {
    expect(() => exhaustionMinutes(28, 0)).toThrow(/invalid burnRate/)
    expect(() => exhaustionMinutes(28, -1)).toThrow(/invalid burnRate/)
  })
})

describe('buildBurnAlertPayload', () => {
  test('fast-burn payload carries the fast rate + tagged description', () => {
    const payload = buildBurnAlertPayload(
      EMPLOYEE_DUTY_SUCCESS_RATE,
      'slo-abc',
      'fast',
    )
    expect(payload.slo_id).toBe('slo-abc')
    expect(payload.exhaustion_minutes).toBe(
      exhaustionMinutes(28, EMPLOYEE_DUTY_SUCCESS_RATE.burnAlerts.fast),
    )
    expect(payload.sli.alias).toBe('sli.employee-duty-success-rate')
    expect(payload.description).toContain('[auto-burn-fast]')
    expect(payload.description).toContain('services/observability/slos.ts')
  })

  test('slow-burn payload uses the slow rate, distinct from fast', () => {
    const fast = buildBurnAlertPayload(ASSIGNMENT_LATENCY_P95, 'slo-1', 'fast')
    const slow = buildBurnAlertPayload(ASSIGNMENT_LATENCY_P95, 'slo-1', 'slow')
    expect(fast.exhaustion_minutes).not.toBe(slow.exhaustion_minutes)
    // Slow burn exhausts later than fast (lower burn rate).
    expect(slow.exhaustion_minutes).toBeGreaterThan(fast.exhaustion_minutes)
    expect(slow.description).toContain('[auto-burn-slow]')
  })
})

describe('planBurnAlertDeployment', () => {
  function existingAllSLOs(): ExistingSLO[] {
    return STARTER_SLOS.map((slo, i) => ({
      id: `slo-${i}`,
      name: slo.name,
    }))
  }

  test('creates fast + slow for every SLO when no alerts exist', () => {
    const plan = planBurnAlertDeployment(STARTER_SLOS, existingAllSLOs(), [])
    expect(plan.unresolvedSLOs).toEqual([])
    expect(plan.items).toHaveLength(STARTER_SLOS.length * 2)
    for (const item of plan.items) expect(item.action).toBe('create')
    // Each SLO gets exactly one fast and one slow.
    for (const slo of STARTER_SLOS) {
      const forSlo = plan.items.filter(i => i.sloName === slo.name)
      expect(forSlo.map(i => i.flavor).sort()).toEqual(['fast', 'slow'])
    }
  })

  test('flags SLOs that have not been deployed to Honeycomb yet', () => {
    // Only EMPLOYEE_DUTY_SUCCESS_RATE exists on the Honeycomb side.
    const partial: ExistingSLO[] = [
      { id: 'slo-0', name: EMPLOYEE_DUTY_SUCCESS_RATE.name },
    ]
    const plan = planBurnAlertDeployment(STARTER_SLOS, partial, [])
    expect(plan.unresolvedSLOs.sort()).toEqual(
      [ASSIGNMENT_LATENCY_P95.name, API_ERROR_RATE.name].sort(),
    )
    // 2 alerts (fast + slow) for the one resolvable SLO.
    expect(plan.items).toHaveLength(2)
  })

  test('skips when existing alert matches registry exhaustion_minutes', () => {
    const sloList = existingAllSLOs()
    const apiSloId = sloList.find(s => s.name === API_ERROR_RATE.name)!.id
    const fast = buildBurnAlertPayload(API_ERROR_RATE, apiSloId, 'fast')
    const slow = buildBurnAlertPayload(API_ERROR_RATE, apiSloId, 'slow')
    const existingAlerts: ExistingBurnAlert[] = [
      {
        id: 'alert-fast-1',
        slo_id: apiSloId,
        exhaustion_minutes: fast.exhaustion_minutes,
        description: fast.description,
      },
      {
        id: 'alert-slow-1',
        slo_id: apiSloId,
        exhaustion_minutes: slow.exhaustion_minutes,
        description: slow.description,
      },
    ]
    const plan = planBurnAlertDeployment(
      [API_ERROR_RATE],
      sloList,
      existingAlerts,
    )
    expect(plan.items.every(i => i.action === 'skip')).toBe(true)
    expect(plan.items[0]!.existingId).toBeDefined()
  })

  test('updates when exhaustion_minutes drifted from registry', () => {
    const sloList = existingAllSLOs()
    const apiSloId = sloList.find(s => s.name === API_ERROR_RATE.name)!.id
    const fast = buildBurnAlertPayload(API_ERROR_RATE, apiSloId, 'fast')
    // Existing alert has the correct flavor tag but wrong threshold.
    const existingAlerts: ExistingBurnAlert[] = [
      {
        id: 'alert-drifted',
        slo_id: apiSloId,
        exhaustion_minutes: fast.exhaustion_minutes + 999,
        description: fast.description,
      },
    ]
    const plan = planBurnAlertDeployment(
      [API_ERROR_RATE],
      sloList,
      existingAlerts,
    )
    const fastPlan = plan.items.find(i => i.flavor === 'fast')!
    expect(fastPlan.action).toBe('update')
    expect(fastPlan.existingId).toBe('alert-drifted')
    expect(fastPlan.reason).toContain('drifted')
    // Slow still needs creating (no match).
    const slowPlan = plan.items.find(i => i.flavor === 'slow')!
    expect(slowPlan.action).toBe('create')
  })

  test('ignores untagged alerts — operators can add ad-hoc alerts safely', () => {
    const sloList = existingAllSLOs()
    const apiSloId = sloList.find(s => s.name === API_ERROR_RATE.name)!.id
    // An alert against the same SLO but without our flavor tag — maybe
    // a human added it manually. Our plan should NOT touch it.
    const existingAlerts: ExistingBurnAlert[] = [
      {
        id: 'human-made',
        slo_id: apiSloId,
        exhaustion_minutes: 1234,
        description: 'on-call experiment, do not auto-manage',
      },
    ]
    const plan = planBurnAlertDeployment(
      [API_ERROR_RATE],
      sloList,
      existingAlerts,
    )
    // Two creates (fast + slow) — the human's alert is untouched.
    expect(plan.items).toHaveLength(2)
    expect(plan.items.every(i => i.action === 'create')).toBe(true)
  })
})
