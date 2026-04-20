// Phantom stub — `workflows` command is not reconstructed in this external
// build. Gated at the call-site via feature('WORKFLOW_SCRIPTS').
import type { Command } from '../../types/command.js'

const command: Command = {
  name: 'workflows',
  description: 'workflows: not implemented in external build',
  isEnabled: () => false,
  isHidden: true,
  type: 'local',
  userFacingName: () => 'workflows',
  async call() {
    throw new Error('workflows: not implemented in external build')
  },
} as unknown as Command

export default command
