import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { execFileNoThrowWithCwd } from 'src/utils/execFileNoThrow.js'

const CLI_STATUS_TIMEOUT_MS = 30_000

function buildCliSmokeEnv(): NodeJS.ProcessEnv {
  const codexHome = mkdtempSync(path.join(tmpdir(), 'cc-cli-smoke-'))
  return {
    ...process.env,
    CI: '1',
    CLAUDE_CODE_SIMPLE: '1',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_UNIX_SOCKET: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
    CLAUDE_CONFIG_DIR: codexHome,
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
    { timeout: CLI_STATUS_TIMEOUT_MS },
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

  test(
    'renders daemon status in non-interactive mode without auth',
    { timeout: CLI_STATUS_TIMEOUT_MS },
    async () => {
      const result = await execFileNoThrowWithCwd(
        process.execPath,
        ['./entrypoints/cli.tsx', 'daemon', 'status'],
        {
          cwd: process.cwd(),
          env: buildCliSmokeEnv(),
        },
      )

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('control plane')
    },
  )
})
