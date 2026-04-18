import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { execFileNoThrowWithCwd } from 'src/utils/execFileNoThrow.js'

function buildCliSmokeEnv(): NodeJS.ProcessEnv {
  const codexHome = mkdtempSync(path.join(tmpdir(), 'cc-cli-smoke-'))
  return {
    ...process.env,
    ANTHROPIC_API_KEY:
      process.env.ANTHROPIC_API_KEY ?? 'sk-ant-test-dummy-key-for-ci',
    CLAUDE_CONFIG_HOME: codexHome,
    CLAUDE_CODE_HARNESS_CONTROL_PLANE_BACKEND: 'filesystem',
    CLAUDE_CODE_HARNESS_POSTGRES_URL: '',
    CLAUDE_CODE_HARNESS_REDIS_URL: '',
    CLAUDE_CODE_HARNESS_TENANT_ID: 'cli-smoke',
  }
}

describe('cli help smoke', () => {
  test('renders help without requiring sandbox-runtime to be installed', async () => {
    const result = await execFileNoThrowWithCwd(
      process.execPath,
      ['./entrypoints/cli.tsx', '--help'],
      {
        cwd: process.cwd(),
        env: buildCliSmokeEnv(),
      },
    )

    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain(
      "@anthropic-ai/sandbox-runtime",
    )
    expect(result.stdout).toContain('Usage:')
    expect(result.stdout).toContain('daemon')
    expect(result.stdout).toContain('harness')
  })

  test(
    'renders harness status in non-interactive mode',
    { timeout: 15_000 },
    async () => {
      const result = await execFileNoThrowWithCwd(
        process.execPath,
        ['./entrypoints/cli.tsx', 'harness', 'status'],
        {
          cwd: process.cwd(),
          env: buildCliSmokeEnv(),
        },
      )

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('jobs configured')
    },
  )
})
