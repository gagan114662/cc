// Phantom stub — event-loop stall detector. Not reconstructed in this
// external build. Gated at the call site behind `('external' as string) === 'ant'`.

export function startEventLoopStallDetector(..._args: unknown[]): void {
  throw new Error(
    'startEventLoopStallDetector: not implemented in external build',
  )
}
