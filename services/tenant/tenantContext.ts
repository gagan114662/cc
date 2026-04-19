// Tenant context for multi-tenant boundaries.
//
// cc-rebuilt today is effectively single-tenant: one project, one
// operator, global module-scope state in bootstrap/state.ts. This file
// introduces the vocabulary the rest of Phase 2 will hang off of, and
// it does so without breaking the single-operator path — resolve()
// falls back to a DEFAULT_TENANT (admin role) when nothing else is
// configured, so every existing caller keeps working.
//
// What "tenant" means here: a namespace that scopes employees, duties,
// audit entries, and span attribution. On a hosted deployment this
// will map 1:1 to a customer / workspace. Locally it maps to a single
// "default" tenant. Phase 2 follow-ups (Postgres-backed employees,
// Redis queue keyed by tenant, per-tenant cost attribution) all read
// from the same resolution path established here.
//
// What "role" means here: a three-tier permission ladder used to gate
// operator-side actions — `/employee assign`, bypassPermissionsMode,
// and the future HTTP /v1/assignments endpoint. Modeled after the
// same admin/developer/viewer shape most teams already think in, so
// it doesn't need a doc to explain.

export type TenantRole = 'admin' | 'developer' | 'viewer'

export type TenantContext = {
  id: string
  name: string
  role: TenantRole
}

// Admin is strictest; viewer is most restricted. Using an ordered
// lookup (not "admin implies everything") keeps requireRole cheap to
// read and prevents accidental privilege grants when someone adds a
// new role later — the table has to be updated explicitly.
const ROLE_RANK: Record<TenantRole, number> = {
  viewer: 0,
  developer: 1,
  admin: 2,
}

export const DEFAULT_TENANT_ID = 'default'

// Sole tenant for single-operator local usage. The `name` is
// deliberately human-readable because it shows up in audit entries
// and span attributes — operators read these, not machines.
export const DEFAULT_TENANT: TenantContext = {
  id: DEFAULT_TENANT_ID,
  name: 'Default Tenant',
  role: 'admin',
}

export class TenantRoleDeniedError extends Error {
  readonly tenantId: string
  readonly required: TenantRole
  readonly actual: TenantRole
  constructor(tenantId: string, required: TenantRole, actual: TenantRole) {
    super(
      `Tenant "${tenantId}" has role "${actual}" but this action requires "${required}".`,
    )
    this.name = 'TenantRoleDeniedError'
    this.tenantId = tenantId
    this.required = required
    this.actual = actual
  }
}

function sanitizeId(raw: string): string {
  // Tenants flow into file paths (audit log dir), span attributes, and
  // queue keys. Keep the vocabulary narrow so nothing downstream has
  // to escape anything: alphanumerics, dash, underscore.
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || DEFAULT_TENANT_ID
}

function parseRole(raw: string | undefined): TenantRole | undefined {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'admin' || normalized === 'developer' || normalized === 'viewer') {
    return normalized
  }
  return undefined
}

// Resolve the current tenant from env, falling back to DEFAULT_TENANT
// so every existing single-operator call site keeps working unchanged.
// CC_TENANT_ID / _NAME / _ROLE are the minimal env surface; Phase 2
// follow-ups will replace env lookup with a registry that reads from
// Postgres, but the shape of the returned context stays the same.
export function resolveTenantContext(
  env: Record<string, string | undefined> = process.env,
): TenantContext {
  const rawId = env.CC_TENANT_ID
  if (!rawId) return DEFAULT_TENANT
  const id = sanitizeId(rawId)
  const name = env.CC_TENANT_NAME?.trim() || id
  const role = parseRole(env.CC_TENANT_ROLE) ?? 'developer'
  return { id, name, role }
}

// Throws TenantRoleDeniedError when the context's role doesn't meet
// the minimum. `required` is the *minimum* rank — "admin" means admin
// only; "developer" means developer or admin; "viewer" accepts any.
export function requireRole(ctx: TenantContext, required: TenantRole): void {
  if (ROLE_RANK[ctx.role] < ROLE_RANK[required]) {
    throw new TenantRoleDeniedError(ctx.id, required, ctx.role)
  }
}

// Non-throwing predicate — useful for UI (grey-out vs hide) and for
// composite checks where you want to collect multiple denial reasons.
export function hasRole(ctx: TenantContext, required: TenantRole): boolean {
  return ROLE_RANK[ctx.role] >= ROLE_RANK[required]
}

// Env vars to propagate into any subprocess we spawn, so the child
// resolves the same tenant. Returns {} for DEFAULT_TENANT (no env
// override needed — the child defaults to the same).
export function tenantEnv(ctx: TenantContext): Record<string, string> {
  if (ctx.id === DEFAULT_TENANT_ID && ctx.role === 'admin' && ctx.name === DEFAULT_TENANT.name) {
    return {}
  }
  return {
    CC_TENANT_ID: ctx.id,
    CC_TENANT_NAME: ctx.name,
    CC_TENANT_ROLE: ctx.role,
  }
}

// Span attribute keys — stable names so every producer (duty span,
// assignment span, API-call span) agrees, and every consumer
// (Honeycomb dashboards, SLI derived columns) can filter by tenant.
export const TENANT_ATTR_KEYS = {
  id: 'tenant.id',
  name: 'tenant.name',
  role: 'tenant.role',
} as const

export function tenantSpanAttributes(
  ctx: TenantContext,
): Record<string, string> {
  return {
    [TENANT_ATTR_KEYS.id]: ctx.id,
    [TENANT_ATTR_KEYS.name]: ctx.name,
    [TENANT_ATTR_KEYS.role]: ctx.role,
  }
}
