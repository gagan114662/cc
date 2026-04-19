import os from 'node:os'
import path from 'node:path'
import { execFileNoThrowWithCwd } from 'src/utils/execFileNoThrow.js'

export type ShellCommandResult = {
  stdout: string
  stderr: string
  code: number
  error?: string
}

export type ShellCommandOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  stdin?: 'ignore' | 'inherit' | 'pipe'
  timeout?: number
  shell?: boolean | string
}

export type ShellCommandRunner = (
  file: string,
  args: string[],
  options?: ShellCommandOptions,
) => Promise<ShellCommandResult>

export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000

function dedupePathEntries(entries: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function buildHarnessCommandEnv(
  envOverrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    ...envOverrides,
  }

  const bunInstallRoot = env.BUN_INSTALL || process.env.BUN_INSTALL
  const pathEntries = dedupePathEntries([
    path.dirname(process.execPath),
    bunInstallRoot ? path.join(bunInstallRoot, 'bin') : '',
    path.join(os.homedir(), '.bun', 'bin'),
    env.PATH ?? '',
  ])

  env.PATH = pathEntries.join(path.delimiter)
  return env
}

export function createDefaultCommandRunner(
  repoRoot: string,
): ShellCommandRunner {
  return (file, args, options = {}) =>
    execFileNoThrowWithCwd(file, args, {
      cwd: options.cwd ?? repoRoot,
      env: buildHarnessCommandEnv(options.env),
      input: options.input,
      stdin: options.stdin,
      timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
      shell: options.shell,
    })
}
