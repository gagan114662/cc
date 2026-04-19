import { describe, expect, test } from 'bun:test'
import { getCommands } from 'src/commands.js'

describe('company command', () => {
  test('registers /company as a local-jsx command', async () => {
    const commands = await getCommands(process.cwd())
    const company = commands.find(command => command.name === 'company')

    expect(company).toBeDefined()
    expect(company?.type).toBe('local-jsx')
    expect(company?.description).toContain('Mission Control')
  })
})
