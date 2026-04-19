// Authorization gate for assignment-class actions.
//
// Shared by two call sites:
//   - /employee assign (CLI)       → commands/employee/employee.tsx
//   - POST /v1/employee/assign     → services/http/employeeAssignRoute.ts
//
// The gate lives here (not in the command module) so the daemon's HTTP
// handler doesn't have to transitively pull Ink/React into its bundle.
// The rule is intentionally trivial: developer or admin is allowed,
// viewer is denied. Keeping the logic in one place means future edits
// (e.g. a per-tenant allow-list, a ticket-system check) happen once.

import {
  hasRole,
  resolveTenantContext,
  type TenantContext,
} from './tenantContext.js'

// Returns null when the tenant may assign, or a human-readable denial
// reason otherwise. Null-or-string lets the two call sites render the
// message however they render other denials (Ink system message vs
// HTTP 403 JSON body) without plumbing a typed error.
export function denyAssignIfUnauthorized(
  tenant: TenantContext = resolveTenantContext(),
): string | null {
  if (hasRole(tenant, 'developer')) return null
  return `Tenant "${tenant.id}" has role "${tenant.role}" — assign requires developer or admin. Ask an operator to upgrade the tenant role via CC_TENANT_ROLE.`
}
