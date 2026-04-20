// Pins the pure helpers behind scripts/honeycombDeploySLOs.ts:
// payload shapes match the Honeycomb derived-column and SLO API, and
// planDeployment emits create/update/skip against realistic existing
// resource snapshots. Keeps the deploy script safe to iterate on
// without touching a real dataset.

import { describe, expect, test } from 'bun:test'
import {
  buildDerivedColumnPayload,
  buildSLOPayload,
  planDeployment,
  sliAliasFor,
  type ExistingResource,
} from 'src/scripts/honeycombDeploySLOs.js'
import {
  API_ERROR_RATE,
  ASSIGNMENT_LATENCY_P95,
  EMPLOYEE_DUTY_SUCCESS_RATE,
  STARTER_SLOS,
  type SLODefinition,
} from 'src/services/observability/slos.js'

describe('sliAliasFor', () => {
  test('prefixes the SLO id with "sli."', () => {
    expect(sliAliasFor(EMPLOYEE_DUTY_SUCCESS_RATE)).toBe(
      'sli.employee-duty-success-rate',
    )
    expect(sliAliasFor(API_ERROR_RATE)).toBe('sli.api-error-rate')
  })
})

describe('buildDerivedColumnPayload', () => {
  test('carries the SLO expression verbatim and labels the source', () => {
    const payload = buildDerivedColumnPayload(ASSIGNMENT_LATENCY_P95)
    expect(payload.alias).toBe('sli.employee-assignment-latency-p95')
    expect(payload.expression).toBe(ASSIGNMENT_LATENCY_P95.sli)
    expect(payload.description).toContain('services/observability/slos.ts')
  })
})

describe('buildSLOPayload', () => {
  test('translates target fraction to target_per_million as a rounded integer', () => {
    const payload = buildSLOPayload(API_ERROR_RATE)
    expect(payload.name).toBe('Anthropic API error rate')
    expect(payload.time_period_days).toBe(7)
    expect(payload.target_per_million).toBe(995_000)
    expect(payload.sli.alias).toBe('sli.api-error-rate')
  })

  test('rounds awkward fractions rather than truncating', () => {
    const weird: SLODefinition = {
      id: 'weird',
      name: 'Weird',
      description: 'x',
      query: 'q',
      sli: 'IF(1,1,0)',
      target: 0.9995,
      windowDays: 7,
      burnAlerts: { fast: 14.4, slow: 6 },
    }
    expect(buildSLOPayload(weird).target_per_million).toBe(999_500)
  })
})

describe('planDeployment', () => {
  test('creates derived columns and SLOs when nothing exists', () => {
    const plan = planDeployment(STARTER_SLOS, [], [])
    expect(plan.derivedColumns).toHaveLength(STARTER_SLOS.length)
    expect(plan.slos).toHaveLength(STARTER_SLOS.length)
    for (const item of plan.derivedColumns) expect(item.action).toBe('create')
    for (const item of plan.slos) expect(item.action).toBe('create')
  })

  test('skips when existing derived column and SLO match the registry', () => {
    const derivedPayload = buildDerivedColumnPayload(EMPLOYEE_DUTY_SUCCESS_RATE)
    const sloPayload = buildSLOPayload(EMPLOYEE_DUTY_SUCCESS_RATE)

    const existingDerived: ExistingResource[] = [
      { id: 'dc-1', alias: derivedPayload.alias, expression: derivedPayload.expression, description: derivedPayload.description },
    ]
    const existingSLOs: ExistingResource[] = [
      {
        id: 'slo-1',
        name: sloPayload.name,
        description: sloPayload.description,
        target_per_million: sloPayload.target_per_million,
        time_period_days: sloPayload.time_period_days,
        sli: { alias: sloPayload.sli.alias },
      },
    ]

    const plan = planDeployment(
      [EMPLOYEE_DUTY_SUCCESS_RATE],
      existingDerived,
      existingSLOs,
    )
    expect(plan.derivedColumns[0].action).toBe('skip')
    expect(plan.derivedColumns[0].existingId).toBe('dc-1')
    expect(plan.slos[0].action).toBe('skip')
    expect(plan.slos[0].existingId).toBe('slo-1')
  })

  test('updates the derived column when the expression drifts', () => {
    const derivedPayload = buildDerivedColumnPayload(API_ERROR_RATE)
    const existingDerived: ExistingResource[] = [
      {
        id: 'dc-99',
        alias: derivedPayload.alias,
        expression: 'IF(1,1,0)', // drifted
        description: derivedPayload.description,
      },
    ]
    const plan = planDeployment([API_ERROR_RATE], existingDerived, [])
    expect(plan.derivedColumns[0].action).toBe('update')
    expect(plan.derivedColumns[0].existingId).toBe('dc-99')
    expect(plan.derivedColumns[0].reason).toContain('drifted')
  })

  test('updates the SLO when the target drifts', () => {
    const sloPayload = buildSLOPayload(ASSIGNMENT_LATENCY_P95)
    const existingSLOs: ExistingResource[] = [
      {
        id: 'slo-42',
        name: sloPayload.name,
        description: sloPayload.description,
        target_per_million: 800_000, // drifted from 950_000
        time_period_days: sloPayload.time_period_days,
        sli: { alias: sloPayload.sli.alias },
      },
    ]
    const plan = planDeployment([ASSIGNMENT_LATENCY_P95], [], existingSLOs)
    expect(plan.slos[0].action).toBe('update')
    expect(plan.slos[0].existingId).toBe('slo-42')
  })

  test('updates the SLO when the SLI alias points somewhere else', () => {
    const sloPayload = buildSLOPayload(EMPLOYEE_DUTY_SUCCESS_RATE)
    const existingSLOs: ExistingResource[] = [
      {
        id: 'slo-7',
        name: sloPayload.name,
        description: sloPayload.description,
        target_per_million: sloPayload.target_per_million,
        time_period_days: sloPayload.time_period_days,
        sli: { alias: 'sli.stale-alias' },
      },
    ]
    const plan = planDeployment(
      [EMPLOYEE_DUTY_SUCCESS_RATE],
      [],
      existingSLOs,
    )
    expect(plan.slos[0].action).toBe('update')
  })
})
