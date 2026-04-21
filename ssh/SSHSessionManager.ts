// Phantom stub — SSHSessionManager. Not reconstructed in this external
// build. Consumers reference it only as a type.

export class SSHSessionManager {
  constructor(..._args: unknown[]) {
    throw new Error('SSHSessionManager: not implemented in external build')
  }
  sendMessage(..._args: unknown[]): Promise<boolean> {
    throw new Error('SSHSessionManager: not implemented in external build')
  }
  cancelRequest(..._args: unknown[]): void {
    throw new Error('SSHSessionManager: not implemented in external build')
  }
  disconnect(..._args: unknown[]): void {
    throw new Error('SSHSessionManager: not implemented in external build')
  }
  // Used by useSSHSession to reply to forwarded permission prompts.
  respondToPermissionRequest(..._args: unknown[]): void {
    throw new Error('SSHSessionManager: not implemented in external build')
  }
  // Starts the SSH session lifecycle (spawn child + handshake).
  connect(..._args: unknown[]): void {
    throw new Error('SSHSessionManager: not implemented in external build')
  }
  // Sends an interrupt (Ctrl-C equivalent) to the remote session.
  sendInterrupt(..._args: unknown[]): void {
    throw new Error('SSHSessionManager: not implemented in external build')
  }
}
