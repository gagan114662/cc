// Phantom stub — inter-Claude peer session bridge. Not reconstructed in
// this external build.

export async function postInterClaudeMessage(
  ..._args: unknown[]
): Promise<{ ok: boolean; error?: string }> {
  throw new Error('postInterClaudeMessage: not implemented in external build')
}

export function listPeerSessions(..._args: unknown[]): unknown[] {
  throw new Error('listPeerSessions: not implemented in external build')
}
