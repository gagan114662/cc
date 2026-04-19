// Pins the RBAC gate on `/employee assign`. Viewer-tier tenants must be
// rejected; developer and admin must pass; the single-operator default
// (admin) must stay unaffected so existing behavior doesn't regress.

import { describe, expect, test } from 'bun:test'
import { denyAssignIfUnauthorized } from 'src/commands/employee/employee.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'

describe('denyAssignIfUnauthorized', () => {
  test('returns null for the single-operator DEFAULT_TENANT (admin)', () => {
    expect(denyAssignIfUnauthorized(DEFAULT_TENANT)).toBeNull()
  })

  test('returns null for a developer tenant', () => {
    expect(
      denyAssignIfUnauthorized({ id: 'acme', name: 'Acme', role: 'developer' }),
    ).toBeNull()
  })

  test('returns null for an admin tenant', () => {
    expect(
      denyAssignIfUnauthorized({ id: 'acme', name: 'Acme', role: 'admin' }),
    ).toBeNull()
  })

  test('denies viewer tenants with a diagnostic message', () => {
    const msg = denyAssignIfUnauthorized({
      id: 'read-only',
      name: 'Read Only',
      role: 'viewer',
    })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('read-only')
    expect(msg!).toContain('viewer')
    expect(msg!).toContain('developer or admin')
  })
})
