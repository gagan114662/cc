// Tenant attribute helper for telemetry surfaces.
//
// Why this file exists: Phase 2 item 1b — the OTel cost/token counters
// (bootstrap/state.ts) and the duty/assignment spans all emit without
// a tenant attribute today, so a "cost by tenant" query on Honeycomb
// always folds into DEFAULT_TENANT. When the HTTP API from PR #15
// accepts concurrent assignments from different tenants, their cost
// and tokens should be distinguishable downstream.
//
// This is NOT a storage partition. The counters stay global; OTel
// attributes are the right partition mechanism for telemetry. If/when
// we need a per-tenant cost accumulator for billing, that belongs on
// top of item 2's tenant-keyed storage, not here.

import { currentTenantContext } from './tenantScope.js'

// The attribute key stays a dotted OTel-style name so it joins the
// existing `duty.id`, `assignment.id`, `employee.duty.success` naming
// on spans and counters. Honeycomb queries group-by this key without
// any schema migration.
export const TENANT_ID_ATTR = 'tenant.id'

// Returns the attribute bag a telemetry call site should spread onto
// its existing attrs. Separate function (rather than a one-liner at
// each call site) so future additions (tenant.name, tenant.role, a
// derived billing key) land in one place.
export function tenantAttributesForTelemetry(): Record<string, string> {
  const tenant = currentTenantContext()
  return { [TENANT_ID_ATTR]: tenant.id }
}
