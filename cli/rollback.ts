/**
 * Phantom stub — `claude rollback [target]` subcommand (ant-only).
 *
 * Callsite (main.tsx:4405):
 *   const { rollback } = await import('src/cli/rollback.js')
 *   await rollback(target, options)
 *
 * Options derived from the commander flags registered at main.tsx:4398
 * (`--list`, `--dry-run`, `--safe`).
 */

export type RollbackOptions = {
  list?: boolean
  dryRun?: boolean
  safe?: boolean
}

export async function rollback(
  _target?: string,
  _options?: RollbackOptions,
): Promise<void> {
  throw new Error('not implemented')
}
