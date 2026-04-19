// Per-tenant employee.json namespace (Phase 2 item 2).
//
// Contract:
//   - DEFAULT_TENANT keeps reading/writing `.claude/employee.json` so
//     single-operator installs migrate with zero work.
//   - Named tenants live under `.claude/tenants/<id>/employee.json`.
//   - readEmployeeConfig / writeEmployeeConfig resolve the active tenant
//     from AsyncLocalStorage (runWithTenantScope) when the caller hasn't
//     passed one in — the same pattern used by audit entries and spans.
//   - listConfiguredTenants enumerates DEFAULT_TENANT (if its file
//     exists) plus every subdir of `.claude/tenants/`. The daemon uses
//     this to schedule duties across all tenants on boot.
//
// These assertions prove a real behavior change — they fail against the
// pre-item-2 single-path implementation because:
//   - the named-tenant path isn't a thing yet
//   - scope isn't consulted
//   - listConfiguredTenants doesn't exist

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  getEmployeeConfigPath,
  listConfiguredTenants,
  readEmployeeConfig,
  readEmployeeConfigSync,
  upsertEmployeeConfig,
  writeEmployeeConfig,
} from 'src/utils/employeeConfig.js'
import { DEFAULT_TENANT, type TenantContext } from 'src/services/tenant/tenantContext.js'
import { runWithTenantScope } from 'src/services/tenant/tenantScope.js'
import type { EmployeeConfig } from 'src/types/employee.js'

let projectRoot: string

const ACME: TenantContext = { id: 'acme', name: 'Acme Co', role: 'developer' }
const GLOBEX: TenantContext = { id: 'globex', name: 'Globex', role: 'developer' }

function makeConfig(overrides?: Partial<EmployeeConfig>): EmployeeConfig {
  return {
    role: 'engineering-lead',
    goals: ['stay alive'],
    defaultAutonomy: 'full-operator',
    delegationMode: 'team',
    verificationRequired: true,
    recurringDuties: [],
    ...overrides,
  }
}

beforeEach(async () => {
  projectRoot = path.join(
    tmpdir(),
    `cc-ns-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(projectRoot, { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('getEmployeeConfigPath', () => {
  test('DEFAULT_TENANT resolves to legacy .claude/employee.json (zero migration)', () => {
    const p = getEmployeeConfigPath(projectRoot, DEFAULT_TENANT.id)
    expect(p).toBe(path.join(projectRoot, '.claude', 'employee.json'))
  })

  test('named tenant resolves under .claude/tenants/<id>/employee.json', () => {
    const p = getEmployeeConfigPath(projectRoot, ACME.id)
    expect(p).toBe(path.join(projectRoot, '.claude', 'tenants', 'acme', 'employee.json'))
  })

  test('active tenant scope wins when tenantId arg is omitted', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => {
      const p = getEmployeeConfigPath(projectRoot)
      expect(p).toBe(path.join(projectRoot, '.claude', 'tenants', 'acme', 'employee.json'))
    })
  })

  test('no scope + no arg falls back to DEFAULT_TENANT legacy path', () => {
    const p = getEmployeeConfigPath(projectRoot)
    expect(p).toBe(path.join(projectRoot, '.claude', 'employee.json'))
  })
})

describe('writeEmployeeConfig / readEmployeeConfig round-trip', () => {
  test('DEFAULT_TENANT writes to legacy path and reads back', async () => {
    const cfg = makeConfig({ goals: ['default goal'] })
    await writeEmployeeConfig(cfg, projectRoot)

    expect(
      existsSync(path.join(projectRoot, '.claude', 'employee.json')),
    ).toBe(true)
    expect(
      existsSync(path.join(projectRoot, '.claude', 'tenants')),
    ).toBe(false)

    const read = await readEmployeeConfig(projectRoot)
    expect(read?.goals).toEqual(['default goal'])
  })

  test('named tenant writes under tenants/<id>/ and creates the dir', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => {
      const cfg = makeConfig({ goals: ['acme goal'] })
      await writeEmployeeConfig(cfg, projectRoot)

      expect(
        existsSync(path.join(projectRoot, '.claude', 'tenants', 'acme', 'employee.json')),
      ).toBe(true)
      // The legacy file is NOT created as a side effect.
      expect(
        existsSync(path.join(projectRoot, '.claude', 'employee.json')),
      ).toBe(false)

      const read = await readEmployeeConfig(projectRoot)
      expect(read?.goals).toEqual(['acme goal'])
    })
  })

  test('two tenants have fully isolated duties', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => {
      await writeEmployeeConfig(
        makeConfig({
          recurringDuties: [
            {
              id: 'acme-duty',
              title: 'acme-duty',
              prompt: 'noop',
              cron: '0 * * * *',
              enabled: true,
              autoCommit: false,
            },
          ],
        }),
        projectRoot,
      )
    })

    await runWithTenantScope({ tenant: GLOBEX }, async () => {
      await writeEmployeeConfig(
        makeConfig({
          recurringDuties: [
            {
              id: 'globex-duty',
              title: 'globex-duty',
              prompt: 'noop',
              cron: '0 * * * *',
              enabled: true,
              autoCommit: false,
            },
          ],
        }),
        projectRoot,
      )
    })

    const acmeRead = await runWithTenantScope({ tenant: ACME }, () =>
      readEmployeeConfig(projectRoot),
    )
    const globexRead = await runWithTenantScope({ tenant: GLOBEX }, () =>
      readEmployeeConfig(projectRoot),
    )

    expect(acmeRead?.recurringDuties.map(d => d.id)).toEqual(['acme-duty'])
    expect(globexRead?.recurringDuties.map(d => d.id)).toEqual(['globex-duty'])
  })

  test('DEFAULT_TENANT does not see a named tenant’s config', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => {
      await writeEmployeeConfig(makeConfig({ goals: ['only-acme'] }), projectRoot)
    })

    // No scope → DEFAULT_TENANT → legacy path, which was never written.
    const read = await readEmployeeConfig(projectRoot)
    expect(read).toBeNull()
  })

  test('upsertEmployeeConfig stays tenant-scoped', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => {
      await upsertEmployeeConfig(
        existing => existing ?? makeConfig({ goals: ['acme-seed'] }),
        projectRoot,
      )
      const read = await readEmployeeConfig(projectRoot)
      expect(read?.goals).toEqual(['acme-seed'])
    })

    // Round-trips to the tenant directory — verify path on disk directly,
    // not via the reader, so we catch the case where read happens to be
    // hitting the wrong file.
    const raw = await readFile(
      path.join(projectRoot, '.claude', 'tenants', 'acme', 'employee.json'),
      'utf-8',
    )
    expect(JSON.parse(raw).goals).toEqual(['acme-seed'])
  })

  test('readEmployeeConfigSync honors active tenant scope', async () => {
    await runWithTenantScope({ tenant: ACME }, async () => {
      await writeEmployeeConfig(makeConfig({ goals: ['sync-acme'] }), projectRoot)
    })

    // Same scope on read → tenant file.
    const acme = await runWithTenantScope({ tenant: ACME }, () =>
      readEmployeeConfigSync(projectRoot),
    )
    expect(acme?.goals).toEqual(['sync-acme'])

    // No scope → legacy path → null.
    expect(readEmployeeConfigSync(projectRoot)).toBeNull()
  })
})

describe('listConfiguredTenants', () => {
  test('returns empty array when no configs exist', async () => {
    const tenants = await listConfiguredTenants(projectRoot)
    expect(tenants).toEqual([])
  })

  test('includes DEFAULT_TENANT when the legacy file exists', async () => {
    await writeEmployeeConfig(makeConfig(), projectRoot)
    const tenants = await listConfiguredTenants(projectRoot)
    expect(tenants.map(t => t.id)).toEqual([DEFAULT_TENANT.id])
  })

  test('enumerates every subdir of .claude/tenants/ with an employee.json', async () => {
    await mkdir(path.join(projectRoot, '.claude', 'tenants', 'acme'), { recursive: true })
    await writeFile(
      path.join(projectRoot, '.claude', 'tenants', 'acme', 'employee.json'),
      JSON.stringify(makeConfig({ goals: ['acme'] })),
    )
    await mkdir(path.join(projectRoot, '.claude', 'tenants', 'globex'), { recursive: true })
    await writeFile(
      path.join(projectRoot, '.claude', 'tenants', 'globex', 'employee.json'),
      JSON.stringify(makeConfig({ goals: ['globex'] })),
    )
    // A directory without a config must NOT be reported — it's
    // plausibly leftover from a migration.
    await mkdir(path.join(projectRoot, '.claude', 'tenants', 'empty'), { recursive: true })

    const tenants = await listConfiguredTenants(projectRoot)
    const ids = tenants.map(t => t.id).sort()
    expect(ids).toEqual(['acme', 'globex'])
  })

  test('combines DEFAULT_TENANT with named tenants', async () => {
    await writeEmployeeConfig(makeConfig({ goals: ['default'] }), projectRoot)
    await mkdir(path.join(projectRoot, '.claude', 'tenants', 'acme'), { recursive: true })
    await writeFile(
      path.join(projectRoot, '.claude', 'tenants', 'acme', 'employee.json'),
      JSON.stringify(makeConfig()),
    )

    const tenants = await listConfiguredTenants(projectRoot)
    const ids = tenants.map(t => t.id).sort()
    expect(ids).toEqual(['acme', DEFAULT_TENANT.id].sort())
  })
})
