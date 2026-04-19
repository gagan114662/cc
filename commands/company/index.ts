import type { Command } from '../../commands.js'

const company = {
  type: 'local-jsx',
  name: 'company',
  description: 'Open PM Mission Control for the current company',
  load: () => import('./company.js'),
} satisfies Command

export default company
