// Span helpers for employee duty / assignment execution.
//
// These wrap a function in an OTel span with the well-known attribute
// names the SLOs in ./slos.ts query against. The point is to stop
// reinventing span naming in every caller — if a duty runs, it runs inside
// `employee.duty.tick`; if an assignment runs, it runs inside
// `employee.assignment.run`. Honeycomb queries match by those names.

import {
  context as otelContext,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api'

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
