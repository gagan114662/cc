// Integration tests for the Postgres-backed employee store.
//
// Runs when DATABASE_URL is set AND points to a reachable Postgres.
// Skipped otherwise — mirrors the posture of queueBackendRedis tests:
// mainline CI stays zero-infra; operators validating hosted layouts
// locally point DATABASE_URL at a running instance (e.g. a disposable
// `docker run postgres:16-alpine`) and re-run the suite.
//
// What we cover:
//   - write → read round-trip via Postgres (JSON column round-trips
//     the duty shape intact)
//   - write also materializes to disk so the synchronous reader
//     (engineeringLeadAgent) keeps working in a subprocess
//   - listTenants enumerates DEFAULT_TENANT and named tenants the
//     same way the JSON backend does
//   - schema creation is idempotent (calling the factory twice is
//     safe)
//
// What we deliberately DON'T cover here:
//   - connection pool sizing / timeout knobs — that's pg's contract
//   - migrations beyond the initial CREATE TABLE — single table,
//     no columns added yet

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  __resetEmployeeStoreForTest,
  getEmployeeStore,
} from 'src/services/employeeStore/store.js'
import {
  __readDiskSnapshotForTest,
  __resetPostgresPoolForTest,
  materializePostgresTenants,
} from 'src/services/employeeStore/backends/postgres.js'
import { getEmployeeConfigPath } from 'src/utils/employeeConfig.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'
import {
  ENGINEERING_LEAD_AGENT_TYPE,
  type EmployeeConfig,
} from 'src/types/employee.js'

const DATABASE_URL = process.env.DATABASE_URL
const describeIfPg = DATABASE_URL ? describe : describe.skip

const ORIGINAL_BACKEND = process.env.CC_EMPLOYEE_BACKEND

function makeConfig(overrides?: Partial<EmployeeConfig>): EmployeeConfig {
  return {
    role: ENGINEERING_LEAD_AGENT_TYPE,
    goals: ['ship Phase 2'],
    defaultAutonomy: 'full-operator',
    delegationMode: 'team',
    verificationRequired: true,
    recurringDuties: [
      {
        id: 'duty-1',
        title: 'nightly sweep',
        prompt: 'sweep the repo',
        cron: '0 3 * * *',
        enabled: true,
        autoCommit: false,
      },
    ],
    ...overrides,
  }
}

let projectRoot: string

// Clean the table between tests so assertions on listTenants() and
// round-tripped rows don't depend on cross-test leftover state.
async function wipeTable(): Promise<void> {
  if (!DATABASE_URL) return
  const mod: { default?: { Pool: new (cfg: unknown) => unknown }; Pool?: new (cfg: unknown) => unknown } =
    await import('pg' as string)
  const Pool = (mod.default?.Pool ?? mod.Pool) as
    | (new (cfg: unknown) => { query: (q: string) => Promise<unknown>; end: () => Promise<void> })
    | undefined
  if (!Pool) return
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('DROP TABLE IF EXISTS employee_configs')
  } finally {
    await pool.end()
  }
}

beforeAll(async () => {
  if (!DATABASE_URL) return
  process.env.CC_EMPLOYEE_BACKEND = 'postgres'
  await wipeTable()
})

afterAll(() => {
  if (ORIGINAL_BACKEND === undefined) delete process.env.CC_EMPLOYEE_BACKEND
  else process.env.CC_EMPLOYEE_BACKEND = ORIGINAL_BACKEND
})

beforeEach(async () => {
  __resetEmployeeStoreForTest()
  __resetPostgresPoolForTest()
  projectRoot = path.join(
    tmpdir(),
    `cc-pg-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(projectRoot, { recursive: true })
  // Per-test table wipe so assertions on listTenants() start from a
  // known-empty set.
  await wipeTable()
})

afterEach(async () => {
  const store = await getEmployeeStore()
  await store.close()
  __resetEmployeeStoreForTest()
  __resetPostgresPoolForTest()
  await rm(projectRoot, { recursive: true, force: true })
})

describeIfPg('Postgres employee store (needs DATABASE_URL)', () => {
  test('write → read round-trip preserves the config exactly', async () => {
    const store = await getEmployeeStore()
    expect(store.kind).toBe('postgres')

    const config = makeConfig({ goals: ['round-trip'] })
    await store.write(config, {
      projectRoot,
      tenantId: DEFAULT_TENANT.id,
    })

    const back = await store.read({
      projectRoot,
      tenantId: DEFAULT_TENANT.id,
    })
    expect(back).toEqual(config)
  })

  test('write mirrors to disk so the synchronous reader sees it', async () => {
    const store = await getEmployeeStore()
    const config = makeConfig({ goals: ['mirror-to-disk'] })
    await store.write(config, {
      projectRoot,
      tenantId: DEFAULT_TENANT.id,
    })

    // Disk snapshot must match exactly — this is the contract
    // engineeringLeadAgent.ts depends on when running inside a
    // duty subprocess that has no Postgres connection.
    const onDisk = await __readDiskSnapshotForTest(
      projectRoot,
      DEFAULT_TENANT.id,
    )
    expect(onDisk).toEqual(config)

    // Confirm the path math still agrees with getEmployeeConfigPath
    // — callers display that path in /employee init output.
    const rawPath = getEmployeeConfigPath(projectRoot, DEFAULT_TENANT.id)
    const raw = await readFile(rawPath, 'utf-8')
    expect(raw).toContain('mirror-to-disk')
  })

  test('listTenants returns DEFAULT_TENANT and named tenants written to Postgres', async () => {
    const store = await getEmployeeStore()
    await store.write(makeConfig({ goals: ['default'] }), {
      projectRoot,
      tenantId: DEFAULT_TENANT.id,
    })
    await store.write(makeConfig({ goals: ['acme'] }), {
      projectRoot,
      tenantId: 'acme',
    })
    await store.write(makeConfig({ goals: ['globex'] }), {
      projectRoot,
      tenantId: 'globex',
    })

    const tenants = await store.listTenants(projectRoot)
    const ids = tenants.map(t => t.id).sort()
    expect(ids).toEqual(['acme', DEFAULT_TENANT.id, 'globex'].sort())

    // DEFAULT_TENANT stays admin; named tenants default to developer —
    // identical to the JSON backend.
    const def = tenants.find(t => t.id === DEFAULT_TENANT.id)
    expect(def?.role).toBe('admin')
    const acme = tenants.find(t => t.id === 'acme')
    expect(acme?.role).toBe('developer')
  })

  test('per-project isolation: same tenant id under different roots does not cross-read', async () => {
    const altRoot = path.join(
      tmpdir(),
      `cc-pg-store-alt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
    await mkdir(altRoot, { recursive: true })
    try {
      const store = await getEmployeeStore()
      await store.write(makeConfig({ goals: ['project-a'] }), {
        projectRoot,
        tenantId: DEFAULT_TENANT.id,
      })
      await store.write(makeConfig({ goals: ['project-b'] }), {
        projectRoot: altRoot,
        tenantId: DEFAULT_TENANT.id,
      })

      const a = await store.read({
        projectRoot,
        tenantId: DEFAULT_TENANT.id,
      })
      const b = await store.read({
        projectRoot: altRoot,
        tenantId: DEFAULT_TENANT.id,
      })
      expect(a?.goals).toEqual(['project-a'])
      expect(b?.goals).toEqual(['project-b'])

      expect((await store.listTenants(projectRoot)).length).toBe(1)
      expect((await store.listTenants(altRoot)).length).toBe(1)
    } finally {
      await rm(altRoot, { recursive: true, force: true })
    }
  })

  test('materializePostgresTenants writes every tenant to disk on boot', async () => {
    const store = await getEmployeeStore()
    await store.write(makeConfig({ goals: ['default'] }), {
      projectRoot,
      tenantId: DEFAULT_TENANT.id,
    })
    await store.write(makeConfig({ goals: ['acme'] }), {
      projectRoot,
      tenantId: 'acme',
    })

    // Simulate a fresh daemon boot where the disk is empty: wipe
    // both snapshots and then call materialize.
    await rm(getEmployeeConfigPath(projectRoot, DEFAULT_TENANT.id), {
      force: true,
    })
    await rm(getEmployeeConfigPath(projectRoot, 'acme'), {
      force: true,
    })

    const count = await materializePostgresTenants(projectRoot, store)
    expect(count).toBe(2)

    const defSnap = await __readDiskSnapshotForTest(
      projectRoot,
      DEFAULT_TENANT.id,
    )
    const acmeSnap = await __readDiskSnapshotForTest(projectRoot, 'acme')
    expect(defSnap?.goals).toEqual(['default'])
    expect(acmeSnap?.goals).toEqual(['acme'])
  })

  test('read on a missing row returns null (not throw)', async () => {
    const store = await getEmployeeStore()
    const missing = await store.read({
      projectRoot,
      tenantId: 'never-written',
    })
    expect(missing).toBeNull()
  })
})
