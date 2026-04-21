// Phantom stub — job classifier. Not reconstructed in this external build.
// Gated at call sites via feature('TEMPLATES').

export function classifyJob(..._args: unknown[]): unknown {
  throw new Error('classifyJob: not implemented in external build')
}

export function getJobClassification(..._args: unknown[]): unknown {
  throw new Error('getJobClassification: not implemented in external build')
}

export async function runClassifier(..._args: unknown[]): Promise<unknown> {
  throw new Error('runClassifier: not implemented in external build')
}

// Used by query/stopHooks.ts to write per-turn classification state to
// process.env.CLAUDE_JOB_DIR. Phantom stub — real impl runs the classifier
// then persists the result.
export async function classifyAndWriteState(
  ..._args: unknown[]
): Promise<unknown> {
  throw new Error('classifyAndWriteState: not implemented in external build')
}
