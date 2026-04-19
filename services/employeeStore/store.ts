// Employee store backend contract (Phase 2 item 2b closure).
//
// Two backends live behind this interface:
//   - 'json': the default, on-disk store used by single-operator
//     deployments. Writes `.claude/employee.json` (or
//     `.claude/tenants/<id>/employee.json` for named tenants), reads
//     the same. Zero infra; survives process restarts because the
//     file system is the source of truth.
//   - 'postgres': an opt-in durable store keyed on (project_root,
//     tenant_id). Backed by a pg connection pool configured from
//     DATABASE_URL. The Postgres backend also writes a snapshot to
//     disk on every write so the synchronous reader in
//     tools/AgentTool/built-in/engineeringLeadAgent.ts (which cannot
//     `await`) keeps working.
//
// Which backend is active is decided once at process boot by reading
// CC_EMPLOYEE_BACKEND. Callers never branch on the backend — they go
// through `getEmployeeStore()`, which returns the singleton for this
// process.
//
// Why an adapter (not a shared substrate): the JSON backend's
// semantics are file-per-tenant; the Postgres backend's semantics are
// row-per-(project_root, tenant_id). The call sites we need to serve
// (CLI `/employee`, daemon boot, harness effective-config loader,
// smoke tests) are the right seam for the abstraction — the internals
// below do not share code, and the Postgres backend needs connection
// lifecycle management the JSON backend does not.

import type { EmployeeConfig } from '../../types/employee.js'
import type { TenantContext } from '../tenant/tenantContext.js'

export type EmployeeBackendKind = 'json' | 'postgres'

export type EmployeeStoreContext = {
  // Absolute repo root. Both backends treat this as part of the
  // identity of a config: the same tenant on two different project
  // roots is two distinct configs (a single hosted Postgres can hold
  // many projects).
  projectRoot: string
  // Tenant id (DEFAULT_TENANT_ID for the legacy single-operator path).
  tenantId: string
}

export type EmployeeStore = {
  readonly kind: EmployeeBackendKind
  read(ctx: EmployeeStoreContext): Promise<EmployeeConfig | null>
  write(
    config: EmployeeConfig,
    ctx: EmployeeStoreContext,
  ): Promise<void>
  // Enumerate tenants that have a persisted config under this project
  // root. Mirrors the shape returned by the legacy file-scan path:
  // DEFAULT_TENANT (if present) + every named tenant (role 'developer'
  // by default — hosted deployments must opt a tenant up to admin via
  // their own registry, identical semantics to the JSON scan).
  listTenants(projectRoot: string): Promise<TenantContext[]>
  // Release long-lived resources (Postgres pool). JSON has none.
  close(): Promise<void>
}

let active: EmployeeStore | null = null

// Called by tests to clear the singleton between setups. Production
// code never touches this — the singleton lives for the daemon
// process lifetime.
export function __resetEmployeeStoreForTest(): void {
  active = null
}

export function getEmployeeBackendKind(): EmployeeBackendKind {
  const raw = process.env.CC_EMPLOYEE_BACKEND?.toLowerCase()
  if (raw === 'postgres') return 'postgres'
  return 'json'
}

// Lazy import of the concrete backend so a single-operator deployment
// without Postgres never loads pg or opens a connection pool.
export async function getEmployeeStore(): Promise<EmployeeStore> {
  if (active) return active
  const kind = getEmployeeBackendKind()
  if (kind === 'postgres') {
    const mod = await import('./backends/postgres.js')
    active = mod.createPostgresEmployeeStore()
  } else {
    const mod = await import('./backends/json.js')
    active = mod.createJsonEmployeeStore()
  }
  return active
}
