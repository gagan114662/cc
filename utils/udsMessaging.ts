// Phantom stub — UDS (unix domain socket) messaging server. Not
// reconstructed in this external build. Gated at call sites via
// feature('UDS_INBOX').

export async function startUdsMessaging(
  ..._args: unknown[]
): Promise<void> {
  throw new Error('startUdsMessaging: not implemented in external build')
}

export function getDefaultUdsSocketPath(): string {
  throw new Error(
    'getDefaultUdsSocketPath: not implemented in external build',
  )
}

export function stopUdsMessaging(..._args: unknown[]): void {
  throw new Error('stopUdsMessaging: not implemented in external build')
}
