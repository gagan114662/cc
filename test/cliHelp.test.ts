import { describe, expect, test } from 'bun:test'
import { execFileNoThrowWithCwd } from 'src/utils/execFileNoThrow.js'

describe('cli help smoke', () => {
  test('renders help without requiring sandbox-runtime to be installed', async () => {
    const result = await execFileNoThrowWithCwd(
      process.execPath,
      ['./entrypoints/cli.tsx', '--help'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY:
            process.env.ANTHROPIC_API_KEY ?? 'sk-ant-test-dummy-key-for-ci',
        },
      },
    )

    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain(
      "@anthropic-ai/sandbox-runtime",
    )
    expect(result.stdout).toContain('Usage:')
  })
})
