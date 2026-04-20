// Phantom stub — `fork` command is not reconstructed in this external build.
// Gated at the call-site via feature('FORK_SUBAGENT').
import type { Command } from '../../types/command.js'

const command: Command = {
  name: 'fork',
  description: 'fork: not implemented in external build',
  isEnabled: () => false,
  isHidden: true,
  type: 'local',
  userFacingName: () => 'fork',
  async call() {
    throw new Error('fork: not implemented in external build')
  },
} as unknown as Command

export default command
