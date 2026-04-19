// Authorization gate for bypassPermissionsMode / --dangerously-skip-permissions.
//
// The existing `setup.ts` bypass block already covers the host-side
// concerns (no root, sandboxed, no internet). That's necessary but not
// sufficient for a multi-tenant deployment: on a hosted daemon every
// tenant inherits the same host sandbox, so host checks alone would
// let any tenant flip safety off. The tenant-role gate closes Phase 2
// item 4b by making "turn off permission prompts" an admin-only action.
//
// Rule is intentionally stricter than `denyAssignIfUnauthorized`:
// assign requires developer or admin; bypass requires admin only.
// Disabling every downstream permission prompt has a much larger blast
// radius than accepting an assignment — it deletes the safety net that
// developer-role tenants still expect to exist around their sessions.
//
// Single-operator deployments are unaffected: DEFAULT_TENANT has role
// 'admin', so every existing CLI invocation continues to work with no
// env changes.

import {
  hasRole,
  resolveTenantContext,
  type TenantContext,
} from './tenantContext.js'

// Returns null when the tenant may enable bypass, or a human-readable
// denial reason otherwise. Null-or-string mirrors `denyAssignIfUnauthorized`
// so the call sites render messages the way they render other denials.
export function denyBypassIfUnauthorized(
  tenant: TenantContext = resolveTenantContext(),
): string | null {
  if (hasRole(tenant, 'admin')) return null
  return `Tenant "${tenant.id}" has role "${tenant.role}" — bypassPermissionsMode requires admin. Ask an operator to upgrade the tenant role via CC_TENANT_ROLE=admin, or run without --dangerously-skip-permissions.`
}
