// Phantom stub — claude server pid-lockfile helpers. Not reconstructed in
// this external build.

export function writeServerLock(..._args: unknown[]): void {
  throw new Error('writeServerLock: not implemented in external build')
}

export function removeServerLock(..._args: unknown[]): void {
  throw new Error('removeServerLock: not implemented in external build')
}

export async function probeRunningServer(
  ..._args: unknown[]
): Promise<{ pid: number; httpUrl: string } | null> {
  return null
}
