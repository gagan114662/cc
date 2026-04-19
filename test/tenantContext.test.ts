// Pins the tenant-context foundation: env resolution, role hierarchy,
// sanitization, and the span/env marshalling surface. These helpers
// are the vocabulary every Phase-2 caller (Postgres employee store,
// Redis job queue, HTTP /v1/assignments) will hang off, so pinning
// the shape now prevents drift across follow-up slices.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TENANT,
  DEFAULT_TENANT_ID,
  hasRole,
  requireRole,
  resolveTenantContext,
  TENANT_ATTR_KEYS,
  tenantEnv,
  tenantSpanAttributes,
  TenantRoleDeniedError,
} from 'src/services/tenant/tenantContext.js'

describe('resolveTenantContext', () => {
  test('falls back to DEFAULT_TENANT when CC_TENANT_ID is unset', () => {
    const ctx = resolveTenantContext({})
    expect(ctx).toEqual(DEFAULT_TENANT)
    expect(ctx.role).toBe('admin')
    expect(ctx.id).toBe(DEFAULT_TENANT_ID)
  })

  test('reads id / name / role from env', () => {
    const ctx = resolveTenantContext({
      CC_TENANT_ID: 'acme',
      CC_TENANT_NAME: 'Acme Robotics',
      CC_TENANT_ROLE: 'developer',
    })
    expect(ctx).toEqual({
      id: 'acme',
      name: 'Acme Robotics',
      role: 'developer',
    })
  })

  test('defaults role to developer when CC_TENANT_ID is set but CC_TENANT_ROLE is not', () => {
    // Rationale: a configured tenant that hasn't declared a role
    // should not silently be admin — default to developer so the
    // principle-of-least-privilege holds until an operator opts in.
    const ctx = resolveTenantContext({ CC_TENANT_ID: 'acme' })
    expect(ctx.role).toBe('developer')
    expect(ctx.id).toBe('acme')
    expect(ctx.name).toBe('acme') // name falls back to id
  })

  test('rejects unknown role values and falls back to developer', () => {
    const ctx = resolveTenantContext({
      CC_TENANT_ID: 'x',
      CC_TENANT_ROLE: 'superuser',
    })
    expect(ctx.role).toBe('developer')
  })

  test('normalizes role casing', () => {
    const ctx = resolveTenantContext({
      CC_TENANT_ID: 'x',
      CC_TENANT_ROLE: 'ADMIN',
    })
    expect(ctx.role).toBe('admin')
  })

  test('sanitizes id to alphanumeric + dash + underscore', () => {
    const ctx = resolveTenantContext({
      CC_TENANT_ID: 'acme; DROP TABLE employees;--',
    })
    // Characters outside the safe set are stripped — nothing escaped
    // or URL-encoded; the id must stay filesystem- and queue-safe.
    expect(ctx.id).toBe('acmeDROPTABLEemployees--')
  })

  test('clamps long ids to 64 chars', () => {
    const ctx = resolveTenantContext({ CC_TENANT_ID: 'a'.repeat(200) })
    expect(ctx.id).toHaveLength(64)
  })

  test('empty-after-sanitize id → falls back to DEFAULT_TENANT_ID string', () => {
    const ctx = resolveTenantContext({ CC_TENANT_ID: '!!!' })
    expect(ctx.id).toBe(DEFAULT_TENANT_ID)
  })
})

describe('role hierarchy', () => {
  test('admin can do admin / developer / viewer work', () => {
    const admin: ReturnType<typeof resolveTenantContext> = {
      id: 'x',
      name: 'x',
      role: 'admin',
    }
    expect(hasRole(admin, 'admin')).toBe(true)
    expect(hasRole(admin, 'developer')).toBe(true)
    expect(hasRole(admin, 'viewer')).toBe(true)
  })

  test('developer can do developer / viewer work but not admin', () => {
    const dev = { id: 'x', name: 'x', role: 'developer' as const }
    expect(hasRole(dev, 'admin')).toBe(false)
    expect(hasRole(dev, 'developer')).toBe(true)
    expect(hasRole(dev, 'viewer')).toBe(true)
  })

  test('viewer can only do viewer work', () => {
    const viewer = { id: 'x', name: 'x', role: 'viewer' as const }
    expect(hasRole(viewer, 'admin')).toBe(false)
    expect(hasRole(viewer, 'developer')).toBe(false)
    expect(hasRole(viewer, 'viewer')).toBe(true)
  })

  test('requireRole throws TenantRoleDeniedError with the diagnosis', () => {
    const viewer = { id: 'stranger', name: 'x', role: 'viewer' as const }
    let caught: unknown
    try {
      requireRole(viewer, 'developer')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TenantRoleDeniedError)
    const typed = caught as TenantRoleDeniedError
    expect(typed.tenantId).toBe('stranger')
    expect(typed.required).toBe('developer')
    expect(typed.actual).toBe('viewer')
  })

  test('requireRole is a no-op when the role is sufficient', () => {
    const admin = { id: 'x', name: 'x', role: 'admin' as const }
    expect(() => requireRole(admin, 'developer')).not.toThrow()
    expect(() => requireRole(admin, 'admin')).not.toThrow()
  })
})

describe('tenantEnv', () => {
  test('returns empty env for DEFAULT_TENANT (subprocess inherits defaults)', () => {
    expect(tenantEnv(DEFAULT_TENANT)).toEqual({})
  })

  test('returns the full triple for any non-default tenant', () => {
    const env = tenantEnv({ id: 'acme', name: 'Acme', role: 'developer' })
    expect(env).toEqual({
      CC_TENANT_ID: 'acme',
      CC_TENANT_NAME: 'Acme',
      CC_TENANT_ROLE: 'developer',
    })
  })

  test('round-trips through resolveTenantContext', () => {
    const original = { id: 'acme', name: 'Acme Robotics', role: 'admin' as const }
    const env = tenantEnv(original)
    const roundTrip = resolveTenantContext(env)
    expect(roundTrip).toEqual(original)
  })
})

describe('tenantSpanAttributes', () => {
  test('emits the canonical tenant.* attribute triple', () => {
    const attrs = tenantSpanAttributes({
      id: 'acme',
      name: 'Acme',
      role: 'developer',
    })
    expect(attrs[TENANT_ATTR_KEYS.id]).toBe('acme')
    expect(attrs[TENANT_ATTR_KEYS.name]).toBe('Acme')
    expect(attrs[TENANT_ATTR_KEYS.role]).toBe('developer')
  })

  test('attribute keys are stable strings (producers + consumers agree)', () => {
    expect(TENANT_ATTR_KEYS.id).toBe('tenant.id')
    expect(TENANT_ATTR_KEYS.name).toBe('tenant.name')
    expect(TENANT_ATTR_KEYS.role).toBe('tenant.role')
  })
})
