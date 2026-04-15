import type { Command } from '../../commands.js'

const assistant = {
  type: 'local-jsx',
  name: 'assistant',
  description: 'Install or attach to assistant mode components',
  load: () => import('./assistant.js'),
} satisfies Command

export default assistant
