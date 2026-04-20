// Phantom stub — reactive-compact service. Not reconstructed in this external
// build. Gated at call sites via feature('REACTIVE_COMPACT').

export function isReactiveCompactEnabled(..._args: unknown[]): boolean {
  return false
}

export function isWithheldPromptTooLong(..._args: unknown[]): boolean {
  return false
}

export function isWithheldMediaSizeError(..._args: unknown[]): boolean {
  return false
}

export async function tryReactiveCompact(
  ..._args: unknown[]
): Promise<unknown> {
  throw new Error('tryReactiveCompact: not implemented in external build')
}

export function buildReactiveCompactMessages(..._args: unknown[]): unknown {
  throw new Error(
    'buildReactiveCompactMessages: not implemented in external build',
  )
}
