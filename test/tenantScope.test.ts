// AsyncLocalStorage tenant scope — the seam Phase 2 items 2/3/5 hang off of.
//
// The thing these tests exist to prove: two concurrent duty fires with
// different tenants CANNOT cross-contaminate each other's scope. This is
// exactly the class of bug that module-scope globals in bootstrap/state.ts
// would create — scope isolation is the entire point of this slice.
//
// Also covered: the explicit-arg precedence (callers passing a tenant
// still win), the env-fallback backwards-compat path (legacy single-
// operator usage unchanged), and the audit-log integration (the first
// real consumer stamps the scope's tenant on durable entries).

import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_TENANT,
  type TenantContext,
} from 'src/services/tenant/tenantContext.js'
import {
  buildTenantScope,
  currentTenantContext,
  currentTenantScope,
  runWithTenantScope,
} from 'src/services/tenant/tenantScope.js'
import { writeAuditEntry } from 'src/services/audit/durableAuditLog.js'

const originalEnv = {
  CC_TENANT_ID: process.env.CC_TENANT_ID,
  CC_TENANT_NAME: process.env.CC_TENANT_NAME,
  CC_TENANT_ROLE: process.env.CC_TENANT_ROLE,
}

beforeEach(() => {
  delete process.env.CC_TENANT_ID
  delete process.env.CC_TENANT_NAME
  delete process.env.CC_TENANT_ROLE
})

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const ACME: TenantContext = { id: 'acme', name: 'Acme', role: 'developer' }
const GLOBEX: TenantContext = { id: 'globex', name: 'Globex', role: 'viewer' }

describe('runWithTenantScope / currentTenantScope', () => {
  test('no active scope returns undefined', () => {
    expect(currentTenantScope()).toBeUndefined()
  })

  test('active scope is visible synchronously inside the callback', () => {
    const scope = buildTenantScope(ACME, 'corr-1')
    runWithTenantScope(scope, () => {
      expect(currentTenantScope()).toEqual(scope)
    })
  })

  test('scope survives awaits inside the callback', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => {
      await new Promise(resolve => setImmediate(resolve))
      expect(currentTenantScope()?.tenant.id).toBe('acme')
      await Promise.resolve()
      expect(currentTenantScope()?.tenant.id).toBe('acme')
    })
  })

  test('scope is torn down when the callback resolves', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => undefined)
    expect(currentTenantScope()).toBeUndefined()
  })

  test('nested scopes stack — inner wins, outer resumes', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => {
      expect(currentTenantScope()?.tenant.id).toBe('acme')
      await runWithTenantScope({ tenant: GLOBEX }, async () => {
        expect(currentTenantScope()?.tenant.id).toBe('globex')
      })
      expect(currentTenantScope()?.tenant.id).toBe('acme')
    })
  })

  test('concurrent scopes do NOT cross-contaminate', async () => {
    // The exact bug item 1 is designed to prevent: two fires happening
    // at the same time, each reading from a module global, racing.
    // AsyncLocalStorage pins storage to the async subtree, so each
    // promise chain sees only its own scope.
    const seen: string[] = []
    const hold = (id: string, delayMs: number) =>
      runWithTenantScope(
        { tenant: { id, name: id, role: 'developer' } },
        async () => {
          await new Promise(resolve => setTimeout(resolve, delayMs))
          seen.push(`${id}=${currentTenantScope()?.tenant.id}`)
        },
      )
    await Promise.all([hold('a', 20), hold('b', 5), hold('c', 10)])
    // Every entry must read its own tenant regardless of resolve order.
    expect(seen.sort()).toEqual(['a=a', 'b=b', 'c=c'])
  })
})

describe('currentTenantContext precedence', () => {
  test('explicit arg wins over scope and env', () => {
    process.env.CC_TENANT_ID = 'env-tenant'
    runWithTenantScope({ tenant: ACME }, () => {
      expect(currentTenantContext(GLOBEX)).toEqual(GLOBEX)
    })
  })

  test('scope wins over env when no explicit arg', () => {
    process.env.CC_TENANT_ID = 'env-tenant'
    process.env.CC_TENANT_ROLE = 'viewer'
    runWithTenantScope({ tenant: ACME }, () => {
      const got = currentTenantContext()
      expect(got.id).toBe('acme')
      expect(got.role).toBe('developer')
    })
  })

  test('env fallback when no scope and no arg', () => {
    process.env.CC_TENANT_ID = 'env-tenant'
    process.env.CC_TENANT_ROLE = 'developer'
    const got = currentTenantContext()
    expect(got.id).toBe('env-tenant')
    expect(got.role).toBe('developer')
  })

  test('DEFAULT_TENANT terminal fallback with nothing set', () => {
    const got = currentTenantContext()
    expect(got).toEqual(DEFAULT_TENANT)
  })
})

describe('audit log picks up the active scope', () => {
  let auditDir: string

  beforeEach(() => {
    auditDir = mkdtempSync(path.join(tmpdir(), 'cc-audit-scope-'))
  })

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true })
  })

  function readAllEntries() {
    const file = path.join(
      auditDir,
      `${new Date().toISOString().slice(0, 10)}.jsonl`,
    )
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
  }

  test('entry written inside a scope stamps the scope tenant', () => {
    runWithTenantScope({ tenant: ACME }, () => {
      writeAuditEntry({ ts: '2026-04-19T00:00:00Z', kind: 't' }, { dir: auditDir })
    })
    const entries = readAllEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].tenant).toEqual({
      id: 'acme',
      name: 'Acme',
      role: 'developer',
    })
  })

  test('entry written outside any scope falls back to DEFAULT_TENANT', () => {
    writeAuditEntry({ ts: '2026-04-19T00:00:00Z', kind: 't' }, { dir: auditDir })
    const entries = readAllEntries()
    expect(entries[0].tenant).toEqual({
      id: DEFAULT_TENANT.id,
      name: DEFAULT_TENANT.name,
      role: DEFAULT_TENANT.role,
    })
  })

  test('explicit opts.tenant still beats the active scope', () => {
    runWithTenantScope({ tenant: ACME }, () => {
      writeAuditEntry(
        { ts: '2026-04-19T00:00:00Z', kind: 't' },
        { dir: auditDir, tenant: GLOBEX },
      )
    })
    const entries = readAllEntries()
    expect(entries[0].tenant).toEqual({
      id: 'globex',
      name: 'Globex',
      role: 'viewer',
    })
  })

  test('concurrent scoped writes land with the correct tenant on each entry', async () => {
    await Promise.all([
      runWithTenantScope({ tenant: ACME }, async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        writeAuditEntry(
          { ts: '2026-04-19T00:00:00Z', kind: 't', who: 'acme-worker' },
          { dir: auditDir },
        )
      }),
      runWithTenantScope({ tenant: GLOBEX }, async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        writeAuditEntry(
          { ts: '2026-04-19T00:00:00Z', kind: 't', who: 'globex-worker' },
          { dir: auditDir },
        )
      }),
    ])
    const entries = readAllEntries()
    const byWho = Object.fromEntries(entries.map(e => [e.who, e.tenant.id]))
    expect(byWho).toEqual({
      'acme-worker': 'acme',
      'globex-worker': 'globex',
    })
  })
})

describe('buildTenantScope helper', () => {
  test('returns a scope with just a tenant by default', () => {
    expect(buildTenantScope()).toEqual({ tenant: DEFAULT_TENANT })
  })

  test('includes correlationId when provided', () => {
    const scope = buildTenantScope(ACME, 'corr-42')
    expect(scope).toEqual({ tenant: ACME, correlationId: 'corr-42' })
  })

  test('omits correlationId when undefined — keeps the object shape minimal', () => {
    const scope = buildTenantScope(ACME)
    expect(scope).toEqual({ tenant: ACME })
    expect('correlationId' in scope).toBe(false)
  })
})
