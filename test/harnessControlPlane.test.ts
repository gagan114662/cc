import { afterEach, describe, expect, test } from 'bun:test'
import {
  __setHostedHarnessBackendOverrideForTests,
  getHostedHarnessControlPlaneInfo,
} from 'src/services/harness/controlPlane.js'

const ORIGINAL_ENV = {
  backend: process.env.CLAUDE_CODE_HARNESS_CONTROL_PLANE_BACKEND,
  postgresUrl: process.env.CLAUDE_CODE_HARNESS_POSTGRES_URL,
  redisUrl: process.env.CLAUDE_CODE_HARNESS_REDIS_URL,
  tenantId: process.env.CLAUDE_CODE_HARNESS_TENANT_ID,
}

afterEach(() => {
  process.env.CLAUDE_CODE_HARNESS_CONTROL_PLANE_BACKEND = ORIGINAL_ENV.backend
  process.env.CLAUDE_CODE_HARNESS_POSTGRES_URL = ORIGINAL_ENV.postgresUrl
  process.env.CLAUDE_CODE_HARNESS_REDIS_URL = ORIGINAL_ENV.redisUrl
  process.env.CLAUDE_CODE_HARNESS_TENANT_ID = ORIGINAL_ENV.tenantId
  __setHostedHarnessBackendOverrideForTests(null)
})

describe('harness control plane backend selection', () => {
  test('defaults to the filesystem control plane', () => {
    delete process.env.CLAUDE_CODE_HARNESS_CONTROL_PLANE_BACKEND
    delete process.env.CLAUDE_CODE_HARNESS_POSTGRES_URL
    delete process.env.CLAUDE_CODE_HARNESS_REDIS_URL
    process.env.CLAUDE_CODE_HARNESS_TENANT_ID = 'tenant-a'

    const info = getHostedHarnessControlPlaneInfo()
    expect(info.kind).toBe('filesystem')
    expect(info.tenantId).toBe('tenant-a')
    expect(info.postgresConfigured).toBe(false)
    expect(info.redisConfigured).toBe(false)
  })

  test('selects the postgres-redis backend when configured', () => {
    process.env.CLAUDE_CODE_HARNESS_CONTROL_PLANE_BACKEND = 'postgres-redis'
    process.env.CLAUDE_CODE_HARNESS_POSTGRES_URL =
      'postgres://user:pass@localhost:5432/harness'
    process.env.CLAUDE_CODE_HARNESS_REDIS_URL = 'redis://localhost:6379'
    process.env.CLAUDE_CODE_HARNESS_TENANT_ID = 'tenant-b'

    const info = getHostedHarnessControlPlaneInfo()
    expect(info.kind).toBe('postgres-redis')
    expect(info.tenantId).toBe('tenant-b')
    expect(info.postgresConfigured).toBe(true)
    expect(info.redisConfigured).toBe(true)
  })
})
