// Assignment queue drainer (Phase 2 item 3).
//
// Consumes pending entries from the tenant-scoped queue, runs the
// caller-supplied runner, and persists state transitions. The runner
// is pluggable so the daemon can pass in the real executor (subprocess
// fire) while tests use a synchronous fake to assert state machine
// behavior without spawning processes.
//
// Tenant semantics: every runner call is wrapped in runWithTenantScope
// for the drain target's tenant. Deep code paths (audit log, spans,
// cost counters) read from that scope — without it, two tenants
// draining concurrently would stamp every downstream event with the
// same process-default tenant.
//
// What this file is NOT: a polling loop, a supervisor, a retry policy.
// Those belong in the daemon integration layer. drainOnce runs through
// the currently pending set once and returns. The daemon calls it on
// a timer; tests drive it directly for deterministic assertions.

import {
  appendAssignmentStateRecord,
  loadAssignmentQueue,
  type AssignmentRecord,
} from './storage.js'
import { type TenantContext } from '../tenant/tenantContext.js'
import { runWithTenantScope } from '../tenant/tenantScope.js'

export type AssignmentRunner = (input: {
  id: string
  assignment: string
  tenant: TenantContext
}) => Promise<void>

export type DrainOptions = {
  projectRoot: string
  tenant: TenantContext
  runner: AssignmentRunner
  // Optional correlation-id shaper — defaults to the assignment id
  // itself, which matches the HTTP API's contract (the id returned
  // by /v1/employee/assign IS the correlation id).
  correlationIdFor?: (rec: AssignmentRecord) => string
}

export async function drainOnce(opts: DrainOptions): Promise<void> {
  const records = await loadAssignmentQueue(opts.projectRoot, opts.tenant.id)
  const pending = records.filter(r => r.state === 'pending')
  const correlationIdFor = opts.correlationIdFor ?? (r => r.id)

  for (const rec of pending) {
    await appendAssignmentStateRecord(
      { id: rec.id, state: 'running' },
      { projectRoot: opts.projectRoot, tenantId: opts.tenant.id },
    )
    try {
      await runWithTenantScope(
        { tenant: opts.tenant, correlationId: correlationIdFor(rec) },
        () =>
          opts.runner({
            id: rec.id,
            assignment: rec.assignment,
            tenant: opts.tenant,
          }),
      )
      await appendAssignmentStateRecord(
        { id: rec.id, state: 'done' },
        { projectRoot: opts.projectRoot, tenantId: opts.tenant.id },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await appendAssignmentStateRecord(
        { id: rec.id, state: 'failed', lastError: msg },
        { projectRoot: opts.projectRoot, tenantId: opts.tenant.id },
      )
    }
  }
}
