// Phantom stub — background-task summary generator. Not reconstructed in
// this external build. Gated at call sites via feature('BG_SESSIONS').

export function shouldGenerateTaskSummary(..._args: unknown[]): boolean {
  return false
}

export async function maybeGenerateTaskSummary(
  ..._args: unknown[]
): Promise<unknown> {
  throw new Error(
    'maybeGenerateTaskSummary: not implemented in external build',
  )
}
