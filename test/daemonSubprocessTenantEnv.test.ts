// Pins that the daemon propagates its resolved tenant into every duty
// subprocess via CC_TENANT_*. Without this, a multi-tenant daemon would
// invoke the child CLI as DEFAULT_TENANT regardless of which tenant
// owned the duty — making per-tenant spans, audit entries, and
// bypassPermissionsMode gates all collapse to "default" on the child.

import { describe, expect, test } from 'bun:test'
import { buildDutySubprocessEnv } from 'src/entrypoints/daemon.js'
import {
  DEFAULT_TENANT,
  type TenantContext,
} from 'src/services/tenant/tenantContext.js'

describe('buildDutySubprocessEnv', () => {
  test('sets CC_DUTY_ID / CC_DUTY_TITLE / CLAUDE_CODE_REMOTE', () => {
    const env = buildDutySubprocessEnv(
      { tenant: DEFAULT_TENANT },
      { id: 'duty-1', title: 'morning sweep' },
      undefined,
      {},
    )
    expect(env.CC_DUTY_ID).toBe('duty-1')
    expect(env.CC_DUTY_TITLE).toBe('morning sweep')
    expect(env.CLAUDE_CODE_REMOTE).toBe('true')
  })

  test('DEFAULT_TENANT daemon omits CC_TENANT_* (child defaults locally)', () => {
    const env = buildDutySubprocessEnv(
      { tenant: DEFAULT_TENANT },
      { id: 'duty-1', title: 't' },
      undefined,
      {},
    )
    expect(env.CC_TENANT_ID).toBeUndefined()
    expect(env.CC_TENANT_NAME).toBeUndefined()
    expect(env.CC_TENANT_ROLE).toBeUndefined()
  })

  test('non-default tenant propagates the full triple', () => {
    const tenant: TenantContext = {
      id: 'acme',
      name: 'Acme Robotics',
      role: 'developer',
    }
    const env = buildDutySubprocessEnv(
      { tenant },
      { id: 'duty-1', title: 't' },
      undefined,
      {},
    )
    expect(env.CC_TENANT_ID).toBe('acme')
    expect(env.CC_TENANT_NAME).toBe('Acme Robotics')
    expect(env.CC_TENANT_ROLE).toBe('developer')
  })

  test('daemon tenant overrides a stale CC_TENANT_ID inherited from base env', () => {
    // The daemon process may have been spawned by a shell that already
    // exported CC_TENANT_ID. resolveTenantContext() ran at boot against
    // that env and produced state.tenant. We must not let the raw
    // inherited env re-override the resolved one.
    const tenant: TenantContext = {
      id: 'resolved',
      name: 'Resolved',
      role: 'admin',
    }
    const env = buildDutySubprocessEnv(
      { tenant },
      { id: 'duty-1', title: 't' },
      undefined,
      { CC_TENANT_ID: 'stale-from-shell', CC_TENANT_ROLE: 'viewer' },
    )
    expect(env.CC_TENANT_ID).toBe('resolved')
    expect(env.CC_TENANT_ROLE).toBe('admin')
  })

  test('tokenBudget / costCap flow through as CC_DUTY_* env vars', () => {
    // Regression pin: the query loop reads CC_DUTY_TOKEN_BUDGET /
    // CC_DUTY_COST_CAP_USD to enforce the hard stop. If these drop out
    // of the subprocess env (as happened on the pre-rebase stack),
    // duties silently exceed their configured caps.
    const env = buildDutySubprocessEnv(
      { tenant: DEFAULT_TENANT },
      { id: 'duty-1', title: 't', tokenBudget: 8000, costCap: 0.5 },
      undefined,
      {},
    )
    expect(env.CC_DUTY_TOKEN_BUDGET).toBe('8000')
    expect(env.CC_DUTY_COST_CAP_USD).toBe('0.5')
  })

  test('omits CC_DUTY_* budget env when duty has no caps configured', () => {
    const env = buildDutySubprocessEnv(
      { tenant: DEFAULT_TENANT },
      { id: 'duty-1', title: 't' },
      undefined,
      {},
    )
    expect(env.CC_DUTY_TOKEN_BUDGET).toBeUndefined()
    expect(env.CC_DUTY_COST_CAP_USD).toBeUndefined()
  })

  test('zero/negative caps are treated as "no cap" (guards division-by-zero downstream)', () => {
    const env = buildDutySubprocessEnv(
      { tenant: DEFAULT_TENANT },
      { id: 'duty-1', title: 't', tokenBudget: 0, costCap: -1 },
      undefined,
      {},
    )
    expect(env.CC_DUTY_TOKEN_BUDGET).toBeUndefined()
    expect(env.CC_DUTY_COST_CAP_USD).toBeUndefined()
  })
})
