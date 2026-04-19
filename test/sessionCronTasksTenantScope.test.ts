// Phase 2 item 1 (continuation) — sessionCronTasks is the third
// bootstrap/state singleton to get tenant-keyed. Before this slice
// every tenant on the process shared one flat `SessionCronTask[]`,
// and the scheduler's tick ran that array for every fire — meaning
//   (a) CronListTool showed tenant A a snapshot that included
//       tenant B's one-shot crons, and
//   (b) the scheduler fired a session task without any signal of
//       which tenant owned it, so the downstream prompt-handling
//       chain ran under whatever scope happened to be active (in
//       practice: nothing, i.e. DEFAULT_TENANT).
//
// This slice partitions the store into `Map<tenantId, SessionCronTask[]>`
// and stamps each task with its owning `tenantId` at add-time. The
// public API surface stays the same for tenant-facing callers, with
// two additions used exclusively by the scheduler tick and by
// test/teardown paths that run outside any AsyncLocalStorage scope:
//
//   - getAllSessionCronTasks()   — flat read across every bucket
//   - clearAllSessionCronTasks() — wipe every bucket in one call
//
// The scheduler itself (utils/cronScheduler.ts) was migrated to
// getAllSessionCronTasks() as part of this change. Tests for that
// integration are in test/cronScheduler*.test.ts (unchanged
// semantics — this slice is purely a storage partition).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  addSessionCronTask,
  clearAllSessionCronTasks,
  getAllSessionCronTasks,
  getSessionCronTasks,
  removeSessionCronTasks,
  resetStateForTests,
  type SessionCronTask,
} from 'src/bootstrap/state.js'
import type { TenantContext } from 'src/services/tenant/tenantContext.js'
import {
  buildTenantScope,
  runWithTenantScope,
} from 'src/services/tenant/tenantScope.js'

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

// Smallest shape addSessionCronTask will accept. tenantId is omitted
// so the stamping from the active scope is exercised; callers in
// utils/cronTasks.ts pass the same shape.
function taskSeed(id: string, cron = '* * * * *'): Omit<SessionCronTask, 'tenantId'> {
  return { id, cron, prompt: `run ${id}`, createdAt: Date.now() }
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

describe('addSessionCronTask — tenant stamping', () => {
  test('stamps tenantId from the active scope', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('t-1'))
    })
    const all = getAllSessionCronTasks()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('t-1')
    expect(all[0].tenantId).toBe('acme')
  })

  test('falls back to DEFAULT_TENANT when no scope is active', () => {
    addSessionCronTask(taskSeed('t-default'))
    const all = getAllSessionCronTasks()
    expect(all).toHaveLength(1)
    expect(all[0].tenantId).toBe('default')
  })

  test('explicit tenantId on input wins over the active scope', () => {
    // Daemon reload paths may want to rehydrate a task into a specific
    // tenant bucket without entering its scope first.
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask({ ...taskSeed('t-rehydrate'), tenantId: 'globex' })
    })
    const all = getAllSessionCronTasks()
    expect(all).toHaveLength(1)
    expect(all[0].tenantId).toBe('globex')
  })
})

describe('getSessionCronTasks — tenant-scoped view', () => {
  test('returns only the active tenant’s bucket', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('acme-1'))
      addSessionCronTask(taskSeed('acme-2'))
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      addSessionCronTask(taskSeed('globex-1'))
    })

    runWithTenantScope(buildTenantScope(ACME), () => {
      expect(getSessionCronTasks().map(t => t.id).sort()).toEqual([
        'acme-1',
        'acme-2',
      ])
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      expect(getSessionCronTasks().map(t => t.id)).toEqual(['globex-1'])
    })
  })

  test('no-scope read sees only the DEFAULT_TENANT bucket', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('acme-only'))
    })
    addSessionCronTask(taskSeed('default-only'))

    expect(getSessionCronTasks().map(t => t.id)).toEqual(['default-only'])
  })

  test('lazy-creates the bucket on first read without a preceding add', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      expect(getSessionCronTasks()).toEqual([])
    })
    // The read materialized an empty acme bucket; the flat view still
    // sees no tasks because every bucket is empty.
    expect(getAllSessionCronTasks()).toHaveLength(0)
  })

  test('concurrent adds across scopes do not cross-contaminate', async () => {
    await Promise.all([
      runWithTenantScope(buildTenantScope(ACME), async () => {
        addSessionCronTask(taskSeed('acme-a'))
        await new Promise(r => setTimeout(r, 5))
        addSessionCronTask(taskSeed('acme-b'))
      }),
      runWithTenantScope(buildTenantScope(GLOBEX), async () => {
        await new Promise(r => setTimeout(r, 1))
        addSessionCronTask(taskSeed('globex-a'))
      }),
    ])

    const acmeTasks = runWithTenantScope(
      buildTenantScope(ACME),
      () => getSessionCronTasks().map(t => t.id).sort(),
    ) as string[]
    const globexTasks = runWithTenantScope(
      buildTenantScope(GLOBEX),
      () => getSessionCronTasks().map(t => t.id),
    ) as string[]

    expect(acmeTasks).toEqual(['acme-a', 'acme-b'])
    expect(globexTasks).toEqual(['globex-a'])
  })
})

describe('getAllSessionCronTasks — scheduler read', () => {
  test('flattens tasks across every bucket and preserves tenantId', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('acme-1'))
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      addSessionCronTask(taskSeed('globex-1'))
      addSessionCronTask(taskSeed('globex-2'))
    })

    const all = getAllSessionCronTasks()
    expect(all).toHaveLength(3)
    const byId = new Map(all.map(t => [t.id, t.tenantId]))
    expect(byId.get('acme-1')).toBe('acme')
    expect(byId.get('globex-1')).toBe('globex')
    expect(byId.get('globex-2')).toBe('globex')
  })

  test('no active scope required — returns every bucket’s tasks', () => {
    // Simulates the cronScheduler check() tick: setInterval runs outside
    // any AsyncLocalStorage scope, so the read must not fall through to
    // DEFAULT_TENANT.
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('acme-1'))
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      addSessionCronTask(taskSeed('globex-1'))
    })

    const ids = getAllSessionCronTasks().map(t => t.id).sort()
    expect(ids).toEqual(['acme-1', 'globex-1'])
  })
})

describe('removeSessionCronTasks — cross-bucket sweep', () => {
  test('removes ids from whichever tenant bucket holds them', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('acme-keep'))
      addSessionCronTask(taskSeed('acme-drop'))
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      addSessionCronTask(taskSeed('globex-drop'))
      addSessionCronTask(taskSeed('globex-keep'))
    })

    const removed = removeSessionCronTasks(['acme-drop', 'globex-drop'])
    expect(removed).toBe(2)

    const byTenant = new Map<string, string[]>()
    for (const t of getAllSessionCronTasks()) {
      const list = byTenant.get(t.tenantId) ?? []
      list.push(t.id)
      byTenant.set(t.tenantId, list)
    }
    expect(byTenant.get('acme')).toEqual(['acme-keep'])
    expect(byTenant.get('globex')).toEqual(['globex-keep'])
  })

  test('returns 0 when no ids match and leaves buckets untouched', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('acme-1'))
    })

    const removed = removeSessionCronTasks(['nonexistent'])
    expect(removed).toBe(0)
    expect(getAllSessionCronTasks()).toHaveLength(1)
  })

  test('empty ids input is a fast no-op', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('acme-1'))
    })
    expect(removeSessionCronTasks([])).toBe(0)
    expect(getAllSessionCronTasks()).toHaveLength(1)
  })

  test('counts cover every bucket the ids hit (not just the first)', () => {
    // Defensive: if two tenants ever produced the same 8-hex id by
    // astronomical collision, the sweep should still clean both sides
    // and report the true removal count.
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('abcdef01'))
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      addSessionCronTask(taskSeed('abcdef01'))
    })

    expect(removeSessionCronTasks(['abcdef01'])).toBe(2)
    expect(getAllSessionCronTasks()).toHaveLength(0)
  })
})

describe('clearAllSessionCronTasks', () => {
  test('wipes every bucket in one call', () => {
    runWithTenantScope(buildTenantScope(ACME), () => {
      addSessionCronTask(taskSeed('acme-1'))
    })
    runWithTenantScope(buildTenantScope(GLOBEX), () => {
      addSessionCronTask(taskSeed('globex-1'))
    })
    expect(getAllSessionCronTasks()).toHaveLength(2)

    clearAllSessionCronTasks()
    expect(getAllSessionCronTasks()).toHaveLength(0)
  })
})
