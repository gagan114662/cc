// JSON-file-backed employee store (the default, zero-infra implementation).
//
// Preserves the on-disk layout the single-operator path has always
// used:
//   - DEFAULT_TENANT → `.claude/employee.json`
//   - Named tenants  → `.claude/tenants/<id>/employee.json`
//
// The path math is delegated to `utils/employeeConfig.ts` (which has
// the tenant-aware `getEmployeeConfigPath` the rest of the code reads
// directly, e.g. `summarizeEmployeeConfig` display paths). That keeps
// one source of truth for the filesystem layout even as the abstract
// EmployeeStore interface grows.

import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

const EMPLOYEE_FILE_NAME = 'employee.json'
const TENANTS_DIR_NAME = 'tenants'

export function createJsonEmployeeStore(): EmployeeStore {
  return {
    kind: 'json',
    async read(ctx) {
      try {
        const raw = await readFile(
          getEmployeeConfigPath(ctx.projectRoot, ctx.tenantId),
          'utf-8',
        )
        return parseEmployeeConfigRaw(raw)
      } catch {
        return null
      }
    },
    async write(config, ctx) {
      const filePath = getEmployeeConfigPath(ctx.projectRoot, ctx.tenantId)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(
        filePath,
        jsonStringify(config, null, 2) + '\n',
        'utf-8',
      )
    },
    async listTenants(projectRoot) {
      const tenants: TenantContext[] = []

      try {
        await readFile(join(projectRoot, '.claude', EMPLOYEE_FILE_NAME), 'utf-8')
        tenants.push(DEFAULT_TENANT)
      } catch {
        // No default employee.json — that's fine, the project may
        // only have named tenants.
      }

      const tenantsDir = join(projectRoot, '.claude', TENANTS_DIR_NAME)
      let entries: string[] = []
      try {
        entries = await readdir(tenantsDir)
      } catch {
        return tenants
      }

      for (const entry of entries) {
        const configPath = join(tenantsDir, entry, EMPLOYEE_FILE_NAME)
        try {
          await readFile(configPath, 'utf-8')
        } catch {
          continue
        }
        tenants.push({ id: entry, name: entry, role: 'developer' })
      }

      return tenants
    },
    async close() {
      // Nothing to release — JSON owns no long-lived resources.
    },
  }
}
