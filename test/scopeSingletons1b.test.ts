// Phase 2 item 1b — finish the singleton rip-out for the two paths the
// HTTP API (PR #15) now exposes directly: costCounter attribution and
// inMemoryErrorLog partitioning.
//
// The bug class these tests catch:
//   - Two concurrent `POST /v1/employee/assign` requests would call
//     addToTotalSessionCost with different tenants active. Before this
//     slice, the OTel counter emitted without a tenant attribute, so a
//     downstream "cost by tenant" query would always return 100% →
//     DEFAULT_TENANT. That is the right attribute split (OTel), not a
//     storage partition — cost-tracker.ts already owns the per-process
//     accumulator.
//   - getInMemoryErrors() returned the flat 100-entry ring buffer. A
//     feedback dialog in tenant A's session would show errors from
//     tenant B's session that happened to land in the same process.
//     Per-tenant buckets close that leak.
//
// What this slice does NOT do: it does NOT partition cost-tracker.ts's
// per-process accumulator (still a global totalCost counter — that's
// item 2/3's concern when storage gets tenant-keyed). It only fixes the
// two surfaces the HTTP API reads/writes: telemetry attribution and the
// error ring buffer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { TenantContext } from 'src/services/tenant/tenantContext.js'
import {
  buildTenantScope,
  runWithTenantScope,
} from 'src/services/tenant/tenantScope.js'
import {
  _resetErrorLogForTesting,
  getInMemoryErrors,
  logError,
} from 'src/utils/log.js'
import { tenantAttributesForTelemetry } from 'src/services/tenant/telemetryAttrs.js'

const originalEnv = {
  CC_TENANT_ID: process.env.CC_TENANT_ID,
  CC_TENANT_NAME: process.env.CC_TENANT_NAME,
  CC_TENANT_ROLE: process.env.CC_TENANT_ROLE,
}

const ACME: TenantContext = { id: 'acme', name: 'Acme', role: 'developer' }
const GLOBEX: TenantContext = {
  id: 'globex',
  name: 'Globex',
  role: 'developer',
}

beforeEach(() => {
  delete process.env.CC_TENANT_ID
  delete process.env.CC_TENANT_NAME
  delete process.env.CC_TENANT_ROLE
  _resetErrorLogForTesting()
})

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetErrorLogForTesting()
})

describe('tenantAttributesForTelemetry', () => {
  test('returns tenant id from the active scope', () => {
    const scope = buildTenantScope(ACME, 'corr-1')
    let captured: Record<string, string> = {}
    runWithTenantScope(scope, () => {
      captured = tenantAttributesForTelemetry()
    })
    expect(captured).toEqual({ 'tenant.id': 'acme' })
  })

  test('falls back to DEFAULT_TENANT id when no scope is active', () => {
    expect(tenantAttributesForTelemetry()).toEqual({ 'tenant.id': 'default' })
  })

  test('merges on top of caller-provided attrs without clobbering', () => {
    const scope = buildTenantScope(GLOBEX)
    let merged: Record<string, unknown> = {}
    runWithTenantScope(scope, () => {
      merged = { model: 'claude-opus-4-7', ...tenantAttributesForTelemetry() }
    })
    expect(merged).toEqual({ model: 'claude-opus-4-7', 'tenant.id': 'globex' })
  })

  test('concurrent scopes do not cross-contaminate the attribute', async () => {
    const [a, b] = await Promise.all([
      runWithTenantScope(buildTenantScope(ACME), async () => {
        await new Promise(r => setTimeout(r, 5))
        return tenantAttributesForTelemetry()
      }),
      runWithTenantScope(buildTenantScope(GLOBEX), async () => {
        await new Promise(r => setTimeout(r, 1))
        return tenantAttributesForTelemetry()
      }),
    ])
    expect(a).toEqual({ 'tenant.id': 'acme' })
    expect(b).toEqual({ 'tenant.id': 'globex' })
  })
})

describe('inMemoryErrorLog partitioning by tenant', () => {
  test('getInMemoryErrors returns only the active scope tenant bucket', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      logError(new Error('acme-boom'))
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      logError(new Error('globex-boom'))
    })

    const acmeEntries = runWithTenantScope(buildTenantScope(ACME), () =>
      getInMemoryErrors(),
    )
    const globexEntries = runWithTenantScope(buildTenantScope(GLOBEX), () =>
      getInMemoryErrors(),
    )

    const acmeMessages = acmeEntries.map(e => e.error)
    const globexMessages = globexEntries.map(e => e.error)
    expect(acmeMessages.some(m => m.includes('acme-boom'))).toBe(true)
    expect(acmeMessages.some(m => m.includes('globex-boom'))).toBe(false)
    expect(globexMessages.some(m => m.includes('globex-boom'))).toBe(true)
    expect(globexMessages.some(m => m.includes('acme-boom'))).toBe(false)
  })

  test('no-scope reads fall back to DEFAULT_TENANT bucket (legacy CLI path)', () => {
    logError(new Error('cli-without-scope'))
    const entries = getInMemoryErrors()
    expect(entries.some(e => e.error.includes('cli-without-scope'))).toBe(true)
  })

  test("DEFAULT_TENANT bucket does not leak errors from a named tenant's bucket", () => {
    logError(new Error('default-one'))
    runWithTenantScope(buildTenantScope(ACME), () => {
      logError(new Error('acme-one'))
    })
    const defaultEntries = getInMemoryErrors()
    expect(defaultEntries.some(e => e.error.includes('default-one'))).toBe(true)
    expect(defaultEntries.some(e => e.error.includes('acme-one'))).toBe(false)
  })

  test('per-tenant ring buffer: each bucket caps at 100 without spilling', () => {
    // Push 105 errors for ACME; bucket should cap at 100 with the oldest
    // 5 evicted. Globex stays at 0 regardless of how noisy ACME is — the
    // central bug this scoping closes.
    runWithTenantScope(buildTenantScope(ACME), () => {
      for (let i = 0; i < 105; i++) logError(new Error(`acme-${i}`))
    })
    const acmeEntries = runWithTenantScope(buildTenantScope(ACME), () =>
      getInMemoryErrors(),
    )
    const globexEntries = runWithTenantScope(buildTenantScope(GLOBEX), () =>
      getInMemoryErrors(),
    )
    expect(acmeEntries.length).toBe(100)
    // Oldest surviving error should be index 5 (0..4 evicted)
    expect(acmeEntries[0]!.error).toContain('acme-5')
    expect(acmeEntries.at(-1)!.error).toContain('acme-104')
    expect(globexEntries.length).toBe(0)
  })

  test('QueryEngine-style watermark + lastIndexOf still works within one scope', () => {
    // Reproduces QueryEngine.ts:1117 — errors[] is turn-scoped via a
    // reference watermark. Same turn = same scope, so the watermark
    // entry stays in the scope's bucket and lastIndexOf matches.
    runWithTenantScope(buildTenantScope(ACME), () => {
      logError(new Error('before-turn'))
      const watermark = getInMemoryErrors().at(-1)
      logError(new Error('during-turn-1'))
      logError(new Error('during-turn-2'))

      const all = getInMemoryErrors()
      const start = watermark ? all.lastIndexOf(watermark) + 1 : 0
      const turnErrors = all.slice(start).map(e => e.error)
      expect(turnErrors).toHaveLength(2)
      expect(turnErrors[0]).toContain('during-turn-1')
      expect(turnErrors[1]).toContain('during-turn-2')
    })
  })
})
