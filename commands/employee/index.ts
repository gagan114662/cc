import type { Command } from '../../commands.js'

const employee = {
  type: 'local-jsx',
  name: 'employee',
  description: 'Manage the project AI employee',
  argumentHint: '[init|assign|status|duty]',
  load: () => import('./employee.js'),
} satisfies Command

export default employee
