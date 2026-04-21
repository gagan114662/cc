// Phantom stub — UDS (unix domain socket) client. Not reconstructed in
// this external build. Gated at call sites via feature('BG_SESSIONS') /
// feature('UDS_INBOX').

export async function sendToUdsSocket(..._args: unknown[]): Promise<void> {
  throw new Error('sendToUdsSocket: not implemented in external build')
}

export async function listAllLiveSessions(
  ..._args: unknown[]
): Promise<Array<{ kind?: string; sessionId?: string }>> {
  return []
}

export async function connectToUdsSocket(
  ..._args: unknown[]
): Promise<unknown> {
  throw new Error('connectToUdsSocket: not implemented in external build')
}
