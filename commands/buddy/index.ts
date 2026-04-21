// Phantom stub — `buddy` command is not reconstructed in this external build.
// Gated at the call-site via feature('BUDDY').
import type { Command } from '../../types/command.js'

const command: Command = {
  name: 'buddy',
  description: 'buddy: not implemented in external build',
  isEnabled: () => false,
  isHidden: true,
  type: 'local',
  userFacingName: () => 'buddy',
  async call() {
    throw new Error('buddy: not implemented in external build')
  },
} as unknown as Command

export default command
