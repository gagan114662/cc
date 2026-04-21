// Phantom stub — `peers` command is not reconstructed in this external build.
// Gated at the call-site via feature('UDS_INBOX').
import type { Command } from '../../types/command.js'

const command: Command = {
  name: 'peers',
  description: 'peers: not implemented in external build',
  isEnabled: () => false,
  isHidden: true,
  type: 'local',
  userFacingName: () => 'peers',
  async call() {
    throw new Error('peers: not implemented in external build')
  },
} as unknown as Command

export default command
