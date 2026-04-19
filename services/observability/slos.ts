// Declarative SLO registry for the employee daemon.
//
// This file is not a query runner — it defines the three starter SLOs that
// the Honeycomb dashboards and burn-rate alerts read, so the thresholds
// live in code (and diff in PRs) instead of in a GUI. Keep the shape
// stable; alerting will match by `id`.

export type SLODefinition = {
  id: string
  name: string
  description: string
  // Predicate over spans, expressed as a human-readable Honeycomb query. The
  // runtime doesn't execute this; the dashboard does.
  query: string
  // Target as a fraction of the good-event ratio (e.g. 0.99 = 99%).
  target: number
  // Rolling window the target is evaluated over.
  windowDays: 7 | 14 | 28 | 30
  // Fast/slow burn rates (Google SRE workbook defaults).
  burnAlerts: { fast: number; slow: number }
}

export const EMPLOYEE_DUTY_SUCCESS_RATE: SLODefinition = {
  id: 'employee-duty-success-rate',
  name: 'Employee duty success rate',
  description:
    'Share of recurring-duty ticks that completed without throwing or hitting the hard-stop.',
  query: 'SELECT rate_of(employee.duty.status = "ok") WHERE name = "employee.duty.tick"',
  target: 0.98,
  windowDays: 28,
  burnAlerts: { fast: 14.4, slow: 6 },
}

export const ASSIGNMENT_LATENCY_P95: SLODefinition = {
  id: 'employee-assignment-latency-p95',
  name: 'Assignment latency p95',
  description:
    'p95 wall time of /employee assign end-to-end spans. Catches runaway assignments before they pile up in the queue.',
  query: 'SELECT HEATMAP(duration_ms) WHERE name = "employee.assignment.run"',
  target: 0.95,
  windowDays: 14,
  burnAlerts: { fast: 14.4, slow: 6 },
}

export const API_ERROR_RATE: SLODefinition = {
  id: 'api-error-rate',
  name: 'Anthropic API error rate',
  description:
    'Share of API calls (post-withRetry) that did not return a successful response. Complements the per-turn nudge signal.',
  query:
    'SELECT rate_of(http.response.status_code < 400) WHERE name = "anthropic.api.request"',
  target: 0.995,
  windowDays: 7,
  burnAlerts: { fast: 14.4, slow: 6 },
}

export const STARTER_SLOS: readonly SLODefinition[] = [
  EMPLOYEE_DUTY_SUCCESS_RATE,
  ASSIGNMENT_LATENCY_P95,
  API_ERROR_RATE,
] as const

export function findSLO(id: string): SLODefinition | undefined {
  return STARTER_SLOS.find(slo => slo.id === id)
}
