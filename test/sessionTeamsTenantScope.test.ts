// Phase 2 item 1 (continuation) — sessionCreatedTeams is the second
// bootstrap/state singleton to get partitioned per tenant. Before this
// slice, two concurrent `/employee assign` calls on a shared daemon
// would push both of their teams into one flat `Set<string>`; on
// shutdown `cleanupSessionTeams()` would walk that shared Set and
// nothing in the public API constrained the cleanup to the tenant
// that created the team. In practice that meant tenant A's leader
// could race into the shutdown handler, pull tenant B's team name,
// and log "removed orphan team dir" for a directory it had no
// business touching.
//
// These tests pin the new per-tenant buckets and — importantly — the
// escape hatch that cleanupSessionTeams() needs because shutdown runs
// outside any AsyncLocalStorage scope. The helpers exercised here are:
//   - getSessionCreatedTeams()             — scoped to currentTenantContext()
//   - getAllSessionCreatedTeamsByTenant()  — full map, shutdown-only read
//   - clearAllSessionCreatedTeams()        — wipe, used at end of cleanup
//   - cleanupSessionTeams()                — integration: walks every bucket
//
// What these tests intentionally don't exercise: real tmux/iTerm2
// killPane or worktree removal. The cleanup helpers are idempotent on
// non-existent teams (readTeamFile returns null on ENOENT, `rm` runs
// with force:true), so we can call the real cleanup path end-to-end
// against in-memory state without reaching for mocks.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearAllSessionCreatedTeams,
  getAllSessionCreatedTeamsByTenant,
  getSessionCreatedTeams,
  resetStateForTests,
} from 'src/bootstrap/state.js'
import type { TenantContext } from 'src/services/tenant/tenantContext.js'
import {
  buildTenantScope,
  runWithTenantScope,
} from 'src/services/tenant/tenantScope.js'
import {
  cleanupSessionTeams,
  registerTeamForSessionCleanup,
  unregisterTeamForSessionCleanup,
} from 'src/utils/swarm/teamHelpers.js'

const ACME: TenantContext = { id: 'acme', name: 'Acme', role: 'developer' }
const GLOBEX: TenantContext = {
  id: 'globex',
  name: 'Globex',
  role: 'developer',
}

const originalEnv = {
  CC_TENANT_ID: process.env.CC_TENANT_ID,
  CC_TENANT_NAME: process.env.CC_TENANT_NAME,
  CC_TENANT_ROLE: process.env.CC_TENANT_ROLE,
  NODE_ENV: process.env.NODE_ENV,
}

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  delete process.env.CC_TENANT_ID
  delete process.env.CC_TENANT_NAME
  delete process.env.CC_TENANT_ROLE
  resetStateForTests()
})

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetStateForTests()
})

describe('getSessionCreatedTeams — tenant-scoped bucket', () => {
  test('outside any scope returns the DEFAULT_TENANT bucket', () => {
    const bucket = getSessionCreatedTeams()
    bucket.add('team-default')
    const perTenant = getAllSessionCreatedTeamsByTenant()
    expect(perTenant.size).toBe(1)
    expect(perTenant.get('default')).toEqual(new Set(['team-default']))
  })

  test('lazy-creates one bucket per tenant and isolates writes', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      registerTeamForSessionCleanup('team-acme-1')
      registerTeamForSessionCleanup('team-acme-2')
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      registerTeamForSessionCleanup('team-globex-1')
    })

    const perTenant = getAllSessionCreatedTeamsByTenant()
    expect(perTenant.get('acme')).toEqual(
      new Set(['team-acme-1', 'team-acme-2']),
    )
    expect(perTenant.get('globex')).toEqual(new Set(['team-globex-1']))
    // DEFAULT_TENANT bucket is absent because no one wrote to it.
    expect(perTenant.has('default')).toBe(false)
  })

  test('reads inside the same scope see only that tenant', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      registerTeamForSessionCleanup('team-acme')
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      registerTeamForSessionCleanup('team-globex')
    })

    runWithTenantScope(buildTenantScope(ACME), () => {
      expect(Array.from(getSessionCreatedTeams())).toEqual(['team-acme'])
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      expect(Array.from(getSessionCreatedTeams())).toEqual(['team-globex'])
    })
  })

  test('concurrent scopes do not cross-contaminate the bucket', async () => {
    await Promise.all([
      runWithTenantScope(buildTenantScope(ACME), async () => {
        registerTeamForSessionCleanup('team-acme-a')
        await new Promise(r => setTimeout(r, 5))
        registerTeamForSessionCleanup('team-acme-b')
      }),
      runWithTenantScope(buildTenantScope(GLOBEX), async () => {
        await new Promise(r => setTimeout(r, 1))
        registerTeamForSessionCleanup('team-globex-a')
      }),
    ])

    const perTenant = getAllSessionCreatedTeamsByTenant()
    expect(perTenant.get('acme')).toEqual(
      new Set(['team-acme-a', 'team-acme-b']),
    )
    expect(perTenant.get('globex')).toEqual(new Set(['team-globex-a']))
  })
})

describe('register / unregister round-trip within a scope', () => {
  test('unregister removes only from the active tenant bucket', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      registerTeamForSessionCleanup('shared-name')
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      registerTeamForSessionCleanup('shared-name')
    })

    runWithTenantScope(buildTenantScope(ACME), () => {
      unregisterTeamForSessionCleanup('shared-name')
    })

    const perTenant = getAllSessionCreatedTeamsByTenant()
    expect(perTenant.get('acme')?.size ?? 0).toBe(0)
    expect(perTenant.get('globex')).toEqual(new Set(['shared-name']))
  })

  test('unregister in a foreign scope is a no-op for the real owner', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      registerTeamForSessionCleanup('team-acme')
    })
    // Globex tries to unregister a team it doesn't own — this should
    // create (then leave) a Globex bucket and leave Acme's bucket
    // untouched.
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      unregisterTeamForSessionCleanup('team-acme')
    })

    const perTenant = getAllSessionCreatedTeamsByTenant()
    expect(perTenant.get('acme')).toEqual(new Set(['team-acme']))
    expect(perTenant.get('globex')?.size ?? 0).toBe(0)
  })
})

describe('clearAllSessionCreatedTeams', () => {
  test('wipes every tenant bucket in one call', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      registerTeamForSessionCleanup('team-acme')
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      registerTeamForSessionCleanup('team-globex-1')
      registerTeamForSessionCleanup('team-globex-2')
    })
    expect(getAllSessionCreatedTeamsByTenant().size).toBe(2)

    clearAllSessionCreatedTeams()

    expect(getAllSessionCreatedTeamsByTenant().size).toBe(0)
  })
})

describe('cleanupSessionTeams — shutdown path', () => {
  test('walks every tenant bucket without an active scope', async () => {
    // Teams registered across two named tenants plus the default.
    runWithTenantScope(buildTenantScope(ACME), () => {
      registerTeamForSessionCleanup('sh-team-acme-1')
      registerTeamForSessionCleanup('sh-team-acme-2')
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      registerTeamForSessionCleanup('sh-team-globex-1')
    })
    registerTeamForSessionCleanup('sh-team-default-1') // outside any scope

    // Sanity: three buckets populated before cleanup.
    expect(getAllSessionCreatedTeamsByTenant().size).toBe(3)

    // Run cleanup outside every scope (simulates the gracefulShutdown
    // handler in entrypoints/init.ts, which runs after the request
    // context has already unwound). No mocking needed: the fake team
    // names have no team files on disk so readTeamFile returns null
    // and cleanupTeamDirectories rm's with force:true.
    await cleanupSessionTeams()

    // All buckets cleared after cleanup (clearAllSessionCreatedTeams
    // invocation at the end of the handler).
    expect(getAllSessionCreatedTeamsByTenant().size).toBe(0)
  })

  test('is a fast no-op when every bucket is empty', async () => {
    // Not a single register call across any scope — cleanup should
    // exit before the logForDebugging line.
    await cleanupSessionTeams()
    expect(getAllSessionCreatedTeamsByTenant().size).toBe(0)
  })

  test('dedupes a team name registered under multiple tenants', async () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      registerTeamForSessionCleanup('shared-team-name')
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      registerTeamForSessionCleanup('shared-team-name')
    })
    // Pre-cleanup both buckets carry the name independently.
    expect(getAllSessionCreatedTeamsByTenant().get('acme')?.size).toBe(1)
    expect(getAllSessionCreatedTeamsByTenant().get('globex')?.size).toBe(1)

    // The cleanup walker dedupes via a local Set before invoking the
    // fs helpers. We can't observe the dedupe directly from outside
    // the function, but we can confirm cleanup succeeds and leaves
    // every bucket empty.
    await cleanupSessionTeams()
    expect(getAllSessionCreatedTeamsByTenant().size).toBe(0)
  })
})
