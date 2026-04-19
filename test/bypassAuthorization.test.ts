// Phase 2 item 4b — tenant-role gate for bypassPermissionsMode.
//
// These tests pin the contract `setup.ts` depends on: admin may turn
// off permission prompts; developer and viewer may not. The gate is
// deliberately stricter than `denyAssignIfUnauthorized` (developer+)
// because the blast radius of "disable every permission prompt" is
// much larger than "submit an assignment".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { denyBypassIfUnauthorized } from 'src/services/tenant/bypassAuthorization.js'
import {
  DEFAULT_TENANT,
  type TenantContext,
} from 'src/services/tenant/tenantContext.js'

const ORIGINAL_TENANT_ID = process.env.CC_TENANT_ID
const ORIGINAL_TENANT_NAME = process.env.CC_TENANT_NAME
const ORIGINAL_TENANT_ROLE = process.env.CC_TENANT_ROLE

beforeEach(() => {
  delete process.env.CC_TENANT_ID
  delete process.env.CC_TENANT_NAME
  delete process.env.CC_TENANT_ROLE
})

afterEach(() => {
  if (ORIGINAL_TENANT_ID === undefined) delete process.env.CC_TENANT_ID
  else process.env.CC_TENANT_ID = ORIGINAL_TENANT_ID
  if (ORIGINAL_TENANT_NAME === undefined) delete process.env.CC_TENANT_NAME
  else process.env.CC_TENANT_NAME = ORIGINAL_TENANT_NAME
  if (ORIGINAL_TENANT_ROLE === undefined) delete process.env.CC_TENANT_ROLE
  else process.env.CC_TENANT_ROLE = ORIGINAL_TENANT_ROLE
})

function tenantWithRole(role: TenantContext['role']): TenantContext {
  return { id: 'acme', name: 'Acme', role }
}

describe('denyBypassIfUnauthorized', () => {
  test('DEFAULT_TENANT (admin) is allowed — single-operator path unchanged', () => {
    expect(denyBypassIfUnauthorized(DEFAULT_TENANT)).toBeNull()
  })

  test('explicit admin tenant is allowed', () => {
    expect(denyBypassIfUnauthorized(tenantWithRole('admin'))).toBeNull()
  })

  test('developer tenant is denied', () => {
    const reason = denyBypassIfUnauthorized(tenantWithRole('developer'))
    expect(reason).not.toBeNull()
    // Message has to name both the tenant and the current role so the
    // operator can correlate it with the process env at a glance.
    expect(reason).toContain('acme')
    expect(reason).toContain('developer')
    expect(reason).toContain('admin')
  })

  test('viewer tenant is denied', () => {
    const reason = denyBypassIfUnauthorized(tenantWithRole('viewer'))
    expect(reason).not.toBeNull()
    expect(reason).toContain('viewer')
  })

  test('defaults to resolved tenant context when no arg passed (env-driven)', () => {
    // No env set → DEFAULT_TENANT → admin → allowed. Pins the
    // implicit-argument path setup.ts uses.
    expect(denyBypassIfUnauthorized()).toBeNull()
  })

  test('env-driven developer tenant is denied through the default argument', () => {
    process.env.CC_TENANT_ID = 'acme'
    process.env.CC_TENANT_ROLE = 'developer'
    const reason = denyBypassIfUnauthorized()
    expect(reason).not.toBeNull()
    expect(reason).toContain('developer')
  })

  test('denial reason is actionable — names the env var to flip', () => {
    const reason = denyBypassIfUnauthorized(tenantWithRole('developer'))
    expect(reason).toContain('CC_TENANT_ROLE')
  })
})
