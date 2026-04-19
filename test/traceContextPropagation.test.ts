// Pins that duty subprocesses inherit W3C trace context from the parent
// span. Without this, Honeycomb traces break at the subprocess boundary and
// duty → CLI invocation spans show up as two orphan trees instead of a
// single stitched trace.

import { describe, expect, test } from 'bun:test'
import { trace } from '@opentelemetry/api'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import {
  traceEnvForActiveContext,
  withDutySpan,
} from 'src/services/observability/dutySpans.js'

const provider = new BasicTracerProvider()
trace.setGlobalTracerProvider(provider)

describe('traceEnvForActiveContext', () => {
  test('returns empty env when no span is active', () => {
    const env = traceEnvForActiveContext()
    expect(env.TRACEPARENT).toBeUndefined()
  })

  test('emits a W3C TRACEPARENT when given a live span', async () => {
    await withDutySpan({ dutyId: 'trace-test' }, async span => {
      const env = traceEnvForActiveContext(span)
      expect(env.TRACEPARENT).toBeDefined()
      // W3C traceparent: 00-<32 hex trace>-<16 hex span>-<2 hex flags>
      expect(env.TRACEPARENT).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
      )
    })
  })

  test('the TRACEPARENT trace-id matches the given span trace-id', async () => {
    await withDutySpan({ dutyId: 'trace-id-check' }, async span => {
      const env = traceEnvForActiveContext(span)
      const traceIdFromEnv = env.TRACEPARENT?.split('-')[1]
      expect(traceIdFromEnv).toBe(span.spanContext().traceId)
    })
  })
})
