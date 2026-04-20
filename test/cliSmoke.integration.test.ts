// CLI boot smoke integration test.
//
// Spawns the actual CLI entrypoint as a child process and
// asserts:
//   (1) exit code is 0 for --version (fast-path)
//   (2) stdout contains the expected version string
//   (3) stderr is empty (no silent startup warnings leaking)
//   (4) the process exits within a reasonable window (no hang
//       from some leaked timer or open handle)
//
// This catches a whole class of regressions that unit tests
// cannot: broken top-level imports, ESM/CJS interop breakage,
// bundler config drift, missing runtime env, hung background
// services that keep the process alive, missing shebang/bin
// permissions, etc.
//
// The --version path is the cheapest possible real boot; see
// entrypoints/cli.tsx which short-circuits before any heavy
// module loading.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dir, '..')
const ENTRYPOINT = path.join(REPO_ROOT, 'entrypoints', 'cli.tsx')
const BOOT_BUDGET_MS = 15_000

type SpawnResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
}

function runCli(args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    // Use `bun run` with the TSX entrypoint so we hit the exact
    // path a developer hits locally. Not the compiled dist/ bundle
    // — that's covered by smoke:bundle.
    const child = spawn('bun', ['run', ENTRYPOINT, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // Disable noisy telemetry and auto-update probes during the
        // smoke test so stderr stays clean. These envs are honored
        // by the CLI startup path.
        DISABLE_TELEMETRY: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(
          `CLI --version did not exit within ${BOOT_BUDGET_MS}ms; ` +
            `likely a leaked timer or background service keeping the ` +
            `event loop alive. stdout so far:\n${stdout}\n` +
            `stderr so far:\n${stderr}`,
        ),
      )
    }, BOOT_BUDGET_MS)

    child.on('error', err => {
      clearTimeout(killTimer)
      reject(err)
    })

    child.on('exit', (code, signal) => {
      clearTimeout(killTimer)
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      })
    })
  })
}

describe('CLI smoke — --version fast path', () => {
  test('exits 0 and prints version within budget', async () => {
    const result = await runCli(['--version'])
    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
    // Accept either the MACRO-injected version or the fallback.
    // The fast-path prints `<version> (Claude Code)`.
    expect(result.stdout).toMatch(/\S+\s+\(Claude Code\)/)
    // If startup leaks a warning to stderr, the team wants to know
    // now, not after launch. If this assertion becomes noisy, track
    // down the leak rather than loosening the check.
    expect(result.stderr).toBe('')
    expect(result.durationMs).toBeLessThan(BOOT_BUDGET_MS)
  }, BOOT_BUDGET_MS + 5_000)

  test('-v short flag works identically', async () => {
    const result = await runCli(['-v'])
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/\S+\s+\(Claude Code\)/)
  }, BOOT_BUDGET_MS + 5_000)
})
