// Pins that duty subprocesses inherit W3C trace context from the parent
// span. Without this, Honeycomb traces break at the subprocess boundary and
// duty → CLI invocation spans show up as two orphan trees instead of a
// single stitched trace.

import { describe, expect, test } from 'bun:test'
import { trace } from '@opentelemetry/api'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import {
  _resetInheritedParentContextCache,
  adoptParentTraceContextFromEnv,
  getInheritedParentContext,
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

describe('adoptParentTraceContextFromEnv', () => {
  test('returns undefined when env has no TRACEPARENT', () => {
    expect(adoptParentTraceContextFromEnv({})).toBeUndefined()
  })

  test('returns undefined for a malformed TRACEPARENT', () => {
    expect(
      adoptParentTraceContextFromEnv({ TRACEPARENT: 'not-a-traceparent' }),
    ).toBeUndefined()
  })

  test('round-trips parent trace-id from env into a child span', async () => {
    // Capture the parent span's traceparent into an env-shaped object —
    // this is exactly what entrypoints/daemon.ts hands the subprocess.
    let parentEnv: Record<string, string> = {}
    let parentTraceId = ''
    let parentSpanId = ''
    await withDutySpan({ dutyId: 'parent' }, async span => {
      parentEnv = traceEnvForActiveContext(span)
      parentTraceId = span.spanContext().traceId
      parentSpanId = span.spanContext().spanId
    })

    // Now simulate the child process: extract the context and start a
    // span with it as parent. The trace-id must match; the span-id must
    // differ (it's a new span); the parent span-id link is carried by
    // the Context itself.
    const parentCtx = adoptParentTraceContextFromEnv(parentEnv)
    expect(parentCtx).toBeDefined()
    const tracer = trace.getTracer('test')
    const child = tracer.startSpan('child-span', {}, parentCtx)
    try {
      expect(child.spanContext().traceId).toBe(parentTraceId)
      expect(child.spanContext().spanId).not.toBe(parentSpanId)
    } finally {
      child.end()
    }
  })

  test('getInheritedParentContext caches the first env read', () => {
    // Test harness may already have TRACEPARENT set (Claude Code injects
    // it when spawning subprocesses). Temporarily strip it so we can
    // prove caching: first call with env clean → undefined, subsequent
    // calls must return the same cached undefined even if env changes.
    const saved = process.env.TRACEPARENT
    try {
      delete process.env.TRACEPARENT
      _resetInheritedParentContextCache()

      const first = getInheritedParentContext()
      expect(first).toBeUndefined()

      process.env.TRACEPARENT =
        '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'
      const second = getInheritedParentContext()
      expect(second).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.TRACEPARENT
      else process.env.TRACEPARENT = saved
      _resetInheritedParentContextCache()
    }
  })
})
