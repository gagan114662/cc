// Tenant-role admin gate for bypassPermissions mode.
//
// These tests pin three invariants:
//
//  1. Helper-level: hasRole('admin') is what gates the mode — a plain
//     unit check of isBypassPermissionsAllowedByTenant so Phase 2 can
//     reuse the helper from /v1/assignments or the future web UI
//     without re-deriving the rule.
//
//  2. Backwards compat: with no CC_TENANT_ROLE set (DEFAULT_TENANT is
//     admin), every pre-Phase-2 call site still reaches
//     bypassPermissions — local-yolo default, -d/--dangerously flag,
//     --permission-mode bypassPermissions. Single-operator users must
//     not regress.
//
//  3. Denial path: CC_TENANT_ROLE=developer / viewer actually routes
//     every entry through the existing "unavailable" fallback
//     (mode=default + notification) rather than silently letting the
//     mode through.
//
// The isBypassPermissionsModeAvailable context flag (read by shift-tab
// and the ExitPlanMode dialog) is covered by the helper unit tests —
// initializeToolPermissionContext is an async settings/GrowthBook/fs
// operation so exercising its full path here would add flake for no
// extra signal; the helper is the single source of truth.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setIsRemoteMode } from 'src/bootstrap/state.js'
import {
  isBypassPermissionsAllowedByTenant,
  initialPermissionModeFromCLI,
  tenantBypassDeniedNotification,
} from 'src/utils/permissions/permissionSetup.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'

const originalEnv = {
  CLAUDE_CODE_REMOTE: process.env.CLAUDE_CODE_REMOTE,
  CLAUDE_CODE_LOCAL_YOLO_ACTIVE: process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE,
  CC_TENANT_ID: process.env.CC_TENANT_ID,
  CC_TENANT_NAME: process.env.CC_TENANT_NAME,
  CC_TENANT_ROLE: process.env.CC_TENANT_ROLE,
}

function clearTenantEnv(): void {
  delete process.env.CC_TENANT_ID
  delete process.env.CC_TENANT_NAME
  delete process.env.CC_TENANT_ROLE
}

beforeEach(() => {
  setIsRemoteMode(false)
  delete process.env.CLAUDE_CODE_REMOTE
  delete process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE
  clearTenantEnv()
})

afterEach(() => {
  setIsRemoteMode(false)
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('isBypassPermissionsAllowedByTenant', () => {
  test('admin role is allowed', () => {
    expect(
      isBypassPermissionsAllowedByTenant({
        id: 'acme',
        name: 'Acme',
        role: 'admin',
      }),
    ).toBe(true)
  })

  test('developer role is denied', () => {
    expect(
      isBypassPermissionsAllowedByTenant({
        id: 'acme',
        name: 'Acme',
        role: 'developer',
      }),
    ).toBe(false)
  })

  test('viewer role is denied', () => {
    expect(
      isBypassPermissionsAllowedByTenant({
        id: 'acme',
        name: 'Acme',
        role: 'viewer',
      }),
    ).toBe(false)
  })

  test('DEFAULT_TENANT (no env) is allowed — preserves single-operator path', () => {
    expect(isBypassPermissionsAllowedByTenant(DEFAULT_TENANT)).toBe(true)
  })

  test('resolves from process.env by default', () => {
    process.env.CC_TENANT_ID = 'acme'
    process.env.CC_TENANT_ROLE = 'viewer'
    expect(isBypassPermissionsAllowedByTenant()).toBe(false)
  })
})

describe('tenantBypassDeniedNotification', () => {
  test('mentions the tenant id, the actual role, and the required role', () => {
    const msg = tenantBypassDeniedNotification({
      id: 'acme',
      name: 'Acme',
      role: 'developer',
    })
    expect(msg).toContain('acme')
    expect(msg).toContain('developer')
    expect(msg).toContain('admin')
  })
})

describe('initialPermissionModeFromCLI — tenant gate', () => {
  test('DEFAULT_TENANT still reaches bypassPermissions via -d flag', () => {
    const result = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: true,
    })
    expect(result.mode).toBe('bypassPermissions')
    expect(result.notification).toBeUndefined()
  })

  test('DEFAULT_TENANT still reaches bypassPermissions via local-yolo default', () => {
    const result = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: undefined,
    })
    expect(result.mode).toBe('bypassPermissions')
    expect(result.notification).toBeUndefined()
  })

  test('DEFAULT_TENANT reaches bypassPermissions via --permission-mode', () => {
    const result = initialPermissionModeFromCLI({
      permissionModeCli: 'bypassPermissions',
      dangerouslySkipPermissions: undefined,
    })
    expect(result.mode).toBe('bypassPermissions')
    expect(result.notification).toBeUndefined()
  })

  test('developer tenant is denied via -d flag — falls back to default with notification', () => {
    process.env.CC_TENANT_ID = 'acme'
    process.env.CC_TENANT_ROLE = 'developer'

    const result = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: true,
    })
    expect(result.mode).toBe('default')
    expect(result.notification).toBeDefined()
    expect(result.notification).toContain('admin')
    expect(result.notification).toContain('acme')
  })

  test('viewer tenant is denied via local-yolo default', () => {
    process.env.CC_TENANT_ID = 'acme'
    process.env.CC_TENANT_ROLE = 'viewer'

    const result = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: undefined,
    })
    expect(result.mode).toBe('default')
    expect(result.notification).toContain('admin')
  })

  test('developer tenant is denied via --permission-mode bypassPermissions', () => {
    process.env.CC_TENANT_ID = 'acme'
    process.env.CC_TENANT_ROLE = 'developer'

    const result = initialPermissionModeFromCLI({
      permissionModeCli: 'bypassPermissions',
      dangerouslySkipPermissions: undefined,
    })
    expect(result.mode).toBe('default')
    expect(result.notification).toContain('admin')
  })

  test('developer tenant with --permission-mode default is unaffected', () => {
    process.env.CC_TENANT_ID = 'acme'
    process.env.CC_TENANT_ROLE = 'developer'

    const result = initialPermissionModeFromCLI({
      permissionModeCli: 'default',
      dangerouslySkipPermissions: undefined,
    })
    expect(result.mode).toBe('default')
    // Not a denial — the user asked for default explicitly.
    expect(result.notification).toBeUndefined()
  })
})
