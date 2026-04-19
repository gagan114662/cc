// Tenant scope — AsyncLocalStorage-backed request context.
//
// Why this file exists: Phase 2 item 1 is "eliminate module-scope
// singletons so tenant context isn't global". bootstrap/state.ts owns
// ~200 properties of process-wide state, and ripping it all out in
// one PR is not reviewable. This file takes the pragmatic first slice
// — the paths Phase 2 actually depends on (duty tick, assignment
// run, audit entry, span stamping) — and gives them an explicit
// per-invocation context carrier that isn't a module global.
//
// How it works: runWithTenantScope() pushes a Scope onto an
// AsyncLocalStorage stack for the duration of a callback. Any code
// in the async subtree that calls currentTenantScope() gets the
// active scope back, including through awaits, setImmediate, and
// OTel span callbacks. Nothing leaks across concurrent fires — that
// was the whole point of item 1.
//
// What isn't here (intentional): a TenantRegistry, a Postgres lookup,
// per-tenant cost accumulators, or a cache of scopes. Those belong
// in items 2–3. This file is the seam only; the state it carries is
// exactly what duty/assignment code paths need today.

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  DEFAULT_TENANT,
  resolveTenantContext,
  type TenantContext,
} from './tenantContext.js'

export type TenantScope = {
  tenant: TenantContext
  // Correlation id for the unit of work (duty tick, assignment run).
  // Surfaces on spans and audit entries so a single trace can be
  // chased end-to-end even when the scope nests.
  correlationId?: string
}

const storage = new AsyncLocalStorage<TenantScope>()

// Run a callback with an active tenant scope. The scope is observable
// via currentTenantScope() from any awaited descendant until the
// callback's returned promise settles. Nested runWithTenantScope
// calls stack — the inner scope wins for the inner subtree, and the
// outer scope resumes when the inner callback resolves.
export function runWithTenantScope<T>(
  scope: TenantScope,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run(scope, fn)
}

// Read the active scope, or undefined if none is active. Prefer
// currentTenantContext() when you only need the TenantContext — it
// transparently falls back to env resolution so legacy call sites
// don't need to branch.
export function currentTenantScope(): TenantScope | undefined {
  return storage.getStore()
}

// The tenant-only accessor the duty/audit/span paths should read.
// Explicit arg wins (callers that already have a context continue
// to pass it), then the active scope, then env resolution (legacy
// single-operator path). DEFAULT_TENANT remains the terminal
// fallback via resolveTenantContext — so zero env + zero scope is
// still a valid admin-tenant invocation.
export function currentTenantContext(
  explicit?: TenantContext,
): TenantContext {
  if (explicit) return explicit
  const scope = storage.getStore()
  if (scope) return scope.tenant
  return resolveTenantContext()
}

// Helper for call sites that want a scope object from a tenant +
// correlation id in one step, without constructing the record
// inline at every caller.
export function buildTenantScope(
  tenant: TenantContext = DEFAULT_TENANT,
  correlationId?: string,
): TenantScope {
  return correlationId === undefined
    ? { tenant }
    : { tenant, correlationId }
}
