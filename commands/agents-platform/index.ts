import type { Command } from '../../commands.js'

const agentsPlatform = {
  type: 'local-jsx',
  name: 'agents-platform',
  description: 'Inspect agents platform status and recovery limitations',
  isEnabled: () => process.env.USER_TYPE === 'ant',
  load: () => import('./agents-platform.js'),
} satisfies Command

export default agentsPlatform
