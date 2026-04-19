// Span helpers for employee duty / assignment execution.
//
// These wrap a function in an OTel span with the well-known attribute
// names the SLOs in ./slos.ts query against. The point is to stop
// reinventing span naming in every caller — if a duty runs, it runs inside
// `employee.duty.tick`; if an assignment runs, it runs inside
// `employee.assignment.run`. Honeycomb queries match by those names.

import {
  context as otelContext,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

// The API package ships a noop propagator by default — so propagation.inject
// would be a silent no-op unless someone (usually the SDK) registers a real
// one. The CLI sets one up during heavier bootstrap, but the daemon path is
// small and skips that. Register once at module load so TRACEPARENT actually
// materializes in duty subprocess env vars.
let propagatorRegistered = false
export function ensureW3CPropagatorRegistered(): void {
  if (propagatorRegistered) return
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  propagatorRegistered = true
}
ensureW3CPropagatorRegistered()

export const DUTY_SPAN_NAME = 'employee.duty.tick'
export const ASSIGNMENT_SPAN_NAME = 'employee.assignment.run'
const TRACER_NAME = 'claude-code.employee'

type BaseAttrs = {
  dutyId?: string
  assignmentId?: string
  title?: string
  cron?: string
  attempt?: number
}

function attrs(base: BaseAttrs, extra?: Attributes): Attributes {
  const out: Attributes = { ...(extra ?? {}) }
  if (base.dutyId) out['employee.duty.id'] = base.dutyId
  if (base.assignmentId) out['employee.assignment.id'] = base.assignmentId
  if (base.title) out['employee.title'] = base.title
  if (base.cron) out['employee.cron'] = base.cron
  if (typeof base.attempt === 'number') out['employee.attempt'] = base.attempt
  return out
}

async function runInSpan<T>(
  name: string,
  base: BaseAttrs,
  fn: (span: Span) => Promise<T>,
  extra?: Attributes,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME)
  return tracer.startActiveSpan(name, { attributes: attrs(base, extra) }, async span => {
    try {
      const result = await fn(span)
      span.setAttribute('employee.duty.status', 'ok')
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.setAttribute('employee.duty.status', 'error')
      span.recordException(err as Error)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      span.end()
    }
  })
}

export function withDutySpan<T>(
  base: Required<Pick<BaseAttrs, 'dutyId'>> & BaseAttrs,
  fn: (span: Span) => Promise<T>,
  extra?: Attributes,
): Promise<T> {
  return runInSpan(DUTY_SPAN_NAME, base, fn, extra)
}

export function withAssignmentSpan<T>(
  base: Required<Pick<BaseAttrs, 'assignmentId'>> & BaseAttrs,
  fn: (span: Span) => Promise<T>,
  extra?: Attributes,
): Promise<T> {
  return runInSpan(ASSIGNMENT_SPAN_NAME, base, fn, extra)
}

// Stamp `employee.duty.id` / `employee.assignment.id` onto whichever span
// is currently active, if any. Used from deep stack frames (API call,
// tool call) that don't know they're running inside a duty.
export function stampEmployeeAttrs(base: BaseAttrs): void {
  const span = trace.getSpan(otelContext.active())
  if (!span) return
  const next = attrs(base)
  for (const [k, v] of Object.entries(next)) {
    if (v !== undefined) span.setAttribute(k, v as string | number | boolean)
  }
}

// Emit the W3C trace context for `span` (or the active span, if any) as env
// vars suitable for subprocess inheritance. OTel SDKs auto-ingest
// TRACEPARENT / TRACESTATE so the child's first span becomes a child of the
// daemon's duty span — that stitches duty → CLI invocation together in
// Honeycomb. Returns {} when no span context is available.
//
// `span` is accepted explicitly because the daemon does not register an
// async-hooks ContextManager (keeps boot light), so otelContext.active()
// alone won't surface the currently-running span. Callers inside
// withDutySpan should pass the span argument they already receive.
export function traceEnvForActiveContext(span?: Span): Record<string, string> {
  const ctx = span
    ? trace.setSpan(otelContext.active(), span)
    : otelContext.active()
  const carrier: Record<string, string> = {}
  propagation.inject(ctx, carrier)
  const out: Record<string, string> = {}
  if (carrier.traceparent) out.TRACEPARENT = carrier.traceparent
  if (carrier.tracestate) out.TRACESTATE = carrier.tracestate
  return out
}

// Import side of traceEnvForActiveContext. The daemon spawns the CLI
// with TRACEPARENT / TRACESTATE set; without this the child starts a
// fresh trace and Honeycomb shows daemon and CLI as unrelated roots.
// Returns a Context with the remote SpanContext as the active span, so
// callers can pass it to tracer.startSpan(name, opts, ctx) and the
// child's first span inherits the daemon's trace-id.
//
// Returns undefined if env has no valid traceparent (normal interactive
// CLI invocations) — callers should treat that as "start a new trace".
export function adoptParentTraceContextFromEnv(
  env: Record<string, string | undefined> = process.env,
): Context | undefined {
  const traceparent = env.TRACEPARENT
  const tracestate = env.TRACESTATE
  if (!traceparent) return undefined
  const carrier: Record<string, string> = { traceparent }
  if (tracestate) carrier.tracestate = tracestate
  const ctx = propagation.extract(otelContext.active(), carrier)
  const spanCtx = trace.getSpanContext(ctx)
  // Reject invalid traceparents (bad format, all-zeroes ids) — extract
  // returns the base context silently in that case.
  if (!spanCtx || !spanCtx.traceId || spanCtx.traceId === '0'.repeat(32)) {
    return undefined
  }
  return ctx
}

// Cached version for the CLI hot path — extract-once, share with every
// startSpan call. First invocation reads env; subsequent calls are free.
let cachedAdoptedContext: Context | undefined | null = null
export function getInheritedParentContext(): Context | undefined {
  if (cachedAdoptedContext === null) {
    cachedAdoptedContext = adoptParentTraceContextFromEnv()
  }
  return cachedAdoptedContext
}

// Test-only: re-read env on the next getInheritedParentContext() call.
export function _resetInheritedParentContextCache(): void {
  cachedAdoptedContext = null
}
