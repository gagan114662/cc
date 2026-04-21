// Phantom stub — self-hosted-runner entrypoint. Not reconstructed in this
// external build. Gated at the call site via feature('SELF_HOSTED_RUNNER').

export async function selfHostedRunnerMain(
  ..._args: unknown[]
): Promise<void> {
  throw new Error('selfHostedRunnerMain: not implemented in external build')
}
