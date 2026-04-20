// Pins that tenant.id / tenant.name / tenant.role show up on every
// duty/assignment span — so Honeycomb can slice duty throughput, error
// rate, and cost by tenant the moment Phase 2 routing goes live, without
// a follow-up span-attribute migration.

import { describe, expect, test, beforeEach } from 'bun:test'
import { trace } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import {
  withAssignmentSpan,
  withDutySpan,
} from 'src/services/observability/dutySpans.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'

const exporter = new InMemorySpanExporter()

// beforeEach, not beforeAll — other test files (e.g. traceContextPropagation)
// register their own BasicTracerProvider at module load, which wins the race
// if we only set ours once. Resetting per-test also gives us a fresh exporter
// buffer, so tests don't cross-pollute finished spans.
beforeEach(() => {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  trace.disable()
  trace.setGlobalTracerProvider(provider)
  exporter.reset()
})

describe('duty spans carry tenant attributes', () => {
  test('withDutySpan stamps DEFAULT_TENANT when no tenant is passed', async () => {
    exporter.reset()
    // Strip any CC_TENANT_* the harness may have set.
    const savedId = process.env.CC_TENANT_ID
    const savedName = process.env.CC_TENANT_NAME
    const savedRole = process.env.CC_TENANT_ROLE
    try {
      delete process.env.CC_TENANT_ID
      delete process.env.CC_TENANT_NAME
      delete process.env.CC_TENANT_ROLE
      await withDutySpan({ dutyId: 'd1' }, async () => {})
      const spans = exporter.getFinishedSpans()
      expect(spans).toHaveLength(1)
      expect(spans[0].attributes['tenant.id']).toBe(DEFAULT_TENANT.id)
      expect(spans[0].attributes['tenant.name']).toBe(DEFAULT_TENANT.name)
      expect(spans[0].attributes['tenant.role']).toBe(DEFAULT_TENANT.role)
    } finally {
      if (savedId !== undefined) process.env.CC_TENANT_ID = savedId
      if (savedName !== undefined) process.env.CC_TENANT_NAME = savedName
      if (savedRole !== undefined) process.env.CC_TENANT_ROLE = savedRole
    }
  })

  test('withDutySpan honors explicit tenant over env', async () => {
    exporter.reset()
    await withDutySpan(
      {
        dutyId: 'd2',
        tenant: { id: 'acme', name: 'Acme', role: 'developer' },
      },
      async () => {},
    )
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].attributes['tenant.id']).toBe('acme')
    expect(spans[0].attributes['tenant.name']).toBe('Acme')
    expect(spans[0].attributes['tenant.role']).toBe('developer')
    // employee.duty.id still present — tenant doesn't displace duty attrs.
    expect(spans[0].attributes['employee.duty.id']).toBe('d2')
  })

  test('withAssignmentSpan stamps tenant too', async () => {
    exporter.reset()
    await withAssignmentSpan(
      {
        assignmentId: 'a1',
        tenant: { id: 'beta', name: 'Beta Corp', role: 'admin' },
      },
      async () => {},
    )
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('employee.assignment.run')
    expect(spans[0].attributes['tenant.id']).toBe('beta')
    expect(spans[0].attributes['tenant.role']).toBe('admin')
    expect(spans[0].attributes['employee.assignment.id']).toBe('a1')
  })
})
