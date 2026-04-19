// Postgres-backed employee store (Phase 2 item 2b closure).
//
// Opt-in backend activated by CC_EMPLOYEE_BACKEND=postgres. Keyed on
// (project_root, tenant_id) so a single hosted Postgres can hold
// employee configs for many projects and many tenants without any
// collision concern. The schema is created idempotently on first
// use so single-binary deployments don't need a separate migration
// step.
//
// Dual-write to disk: every `write` also snapshots the config to
// the filesystem path `utils/employeeConfig.ts#getEmployeeConfigPath`
// returns. This keeps the synchronous reader
// (tools/AgentTool/built-in/engineeringLeadAgent.ts) working unchanged
// — that call path lives inside a subprocess that has no pg
// connection and cannot await. The disk snapshot is a cache; Postgres
// remains authoritative. Operators who need the in-subprocess view
// to match Postgres updates made outside the daemon must either
// restart the daemon (re-materializes on boot via
// `materializePostgresTenants`) or touch the file directly.
//
// pg is a lazy import — single-operator deployments that never set
// CC_EMPLOYEE_BACKEND=postgres never load the driver.

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DEFAULT_TENANT,
  type TenantContext,
} from '../../tenant/tenantContext.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import {
  getEmployeeConfigPath,
  parseEmployeeConfigRaw,
} from '../../../utils/employeeConfig.js'
import type { EmployeeConfig } from '../../../types/employee.js'
import type { EmployeeStore } from '../store.js'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS employee_configs (
  project_root TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  config       JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_root, tenant_id)
);
`

type PgPool = {
  query<T = unknown>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>
  end(): Promise<void>
}

// Resolved to a pg Pool on first call. The pool is process-scoped
// because pg's connection pool is thread-safe and cheap to share —
// one pool per process mirrors how the rest of cc-rebuilt treats
// long-lived clients (see ioredis in the Redis queue backend).
let pool: PgPool | null = null
let schemaInitialized = false

async function getPool(): Promise<PgPool> {
  if (pool) return pool
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'CC_EMPLOYEE_BACKEND=postgres requires DATABASE_URL to be set',
    )
  }
  // Lazy import via dynamic string so TypeScript doesn't require pg's
  // types at build time on deployments that never install it. The
  // returned Pool implements our minimal PgPool contract.
  const mod: { default?: { Pool: new (cfg: unknown) => PgPool }; Pool?: new (cfg: unknown) => PgPool } =
    await import('pg' as string)
  const Pool = mod.default?.Pool ?? mod.Pool
  if (!Pool) {
    throw new Error('pg module did not expose Pool — check installed version')
  }
  pool = new Pool({ connectionString: databaseUrl })
  return pool
}

async function ensureSchema(p: PgPool): Promise<void> {
  if (schemaInitialized) return
  await p.query(SCHEMA_SQL)
  schemaInitialized = true
}

async function writeDiskSnapshot(
  projectRoot: string,
  tenantId: string,
  config: EmployeeConfig,
): Promise<void> {
  const filePath = getEmployeeConfigPath(projectRoot, tenantId)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    jsonStringify(config, null, 2) + '\n',
    'utf-8',
  )
}

// Exported for the daemon boot path: on boot under the Postgres
// backend we materialize every tenant's config to disk so subprocess
// readers see a non-stale snapshot immediately. Called from
// entrypoints/daemon.ts when the backend kind is 'postgres'.
export async function materializePostgresTenants(
  projectRoot: string,
  store: EmployeeStore,
): Promise<number> {
  if (store.kind !== 'postgres') return 0
  const tenants = await store.listTenants(projectRoot)
  let count = 0
  for (const tenant of tenants) {
    const config = await store.read({ projectRoot, tenantId: tenant.id })
    if (!config) continue
    await writeDiskSnapshot(projectRoot, tenant.id, config)
    count += 1
  }
  return count
}

// Re-parse a row's config JSON through the shared validator so the
// Postgres backend rejects the same malformed shapes the JSON backend
// does (partial writes, shape drift from older cc-rebuilt versions).
// Parsing failures return null — identical to the JSON backend's
// behavior when disk contents don't validate.
function parseRowConfig(raw: unknown): EmployeeConfig | null {
  if (raw == null) return null
  const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return parseEmployeeConfigRaw(serialized)
}

export function createPostgresEmployeeStore(): EmployeeStore {
  return {
    kind: 'postgres',
    async read(ctx) {
      const p = await getPool()
      await ensureSchema(p)
      const { rows } = await p.query<{ config: unknown }>(
        'SELECT config FROM employee_configs WHERE project_root = $1 AND tenant_id = $2 LIMIT 1',
        [ctx.projectRoot, ctx.tenantId],
      )
      if (rows.length === 0) return null
      return parseRowConfig(rows[0]?.config)
    },
    async write(config, ctx) {
      const p = await getPool()
      await ensureSchema(p)
      await p.query(
        `INSERT INTO employee_configs (project_root, tenant_id, config, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (project_root, tenant_id) DO UPDATE
         SET config = EXCLUDED.config, updated_at = NOW()`,
        [ctx.projectRoot, ctx.tenantId, jsonStringify(config)],
      )
      // Mirror to disk so the synchronous reader in
      // engineeringLeadAgent.ts sees the same bytes.
      await writeDiskSnapshot(ctx.projectRoot, ctx.tenantId, config)
    },
    async listTenants(projectRoot) {
      const p = await getPool()
      await ensureSchema(p)
      const { rows } = await p.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM employee_configs WHERE project_root = $1 ORDER BY tenant_id',
        [projectRoot],
      )
      const out: TenantContext[] = []
      for (const { tenant_id } of rows) {
        if (tenant_id === DEFAULT_TENANT.id) {
          out.push(DEFAULT_TENANT)
          continue
        }
        // Non-default tenants default to 'developer'. Hosted
        // deployments that need admin-role tenants attach role
        // metadata via their registry (out of scope for this store
        // — identical to the JSON backend's behavior).
        out.push({ id: tenant_id, name: tenant_id, role: 'developer' })
      }
      return out
    },
    async close() {
      if (!pool) return
      const p = pool
      pool = null
      schemaInitialized = false
      await p.end()
    },
  }
}

// Tests only: reach in and wipe the module-scoped pool without going
// through close(). Used when a test bundle reuses the same module
// across test suites and needs a fresh pool per describe block.
export function __resetPostgresPoolForTest(): void {
  pool = null
  schemaInitialized = false
}

// Also tests only: read the current pool without lazy-initialising.
// Intentionally unexported from the barrel — only the test file
// imports this file directly.
export function __peekPostgresPoolForTest(): PgPool | null {
  return pool
}

// Marker helper for tests that want to check whether a disk snapshot
// was written without importing fs helpers themselves.
export async function __readDiskSnapshotForTest(
  projectRoot: string,
  tenantId: string,
): Promise<EmployeeConfig | null> {
  try {
    const raw = await readFile(
      getEmployeeConfigPath(projectRoot, tenantId),
      'utf-8',
    )
    return parseEmployeeConfigRaw(raw)
  } catch {
    return null
  }
}
