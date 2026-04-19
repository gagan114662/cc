import { describe, expect, test } from 'bun:test'
import type { Command } from 'src/commands.js'
import {
  commandBelongsToServer,
  filterMcpPromptsByServer,
  filterMcpSkillsByServer,
  filterMcpWorkflowsByServer,
} from 'src/services/mcp/utils.js'

function makePromptCommand(
  overrides: Partial<Command> & Pick<Command, 'name'>,
): Command {
  return {
    type: 'prompt',
    name: overrides.name,
    description: '',
    hasUserSpecifiedDescription: false,
    contentLength: 0,
    source: 'mcp',
    progressMessage: 'running',
    async getPromptForCommand() {
      return [{ type: 'text', text: '' }]
    },
    ...overrides,
  } as Command
}

describe('MCP command classification', () => {
  test('commandBelongsToServer matches prompts, skills, and workflows', () => {
    expect(
      commandBelongsToServer(
        makePromptCommand({ name: 'mcp__browser_harness__triage' }),
        'browser harness',
      ),
    ).toBe(true)
    expect(
      commandBelongsToServer(
        makePromptCommand({
          name: 'browser_harness:growth:outbound-audit',
          loadedFrom: 'mcp',
        }),
        'browser harness',
      ),
    ).toBe(true)
    expect(
      commandBelongsToServer(
        makePromptCommand({
          name: 'browser_harness:workflow:growth:pipeline-refresh',
          loadedFrom: 'mcp',
          kind: 'workflow',
        }),
        'browser harness',
      ),
    ).toBe(true)
  })

  test('server filters separate prompts from resource-delivered skills/workflows', () => {
    const commands: Command[] = [
      makePromptCommand({
        name: 'mcp__browser_harness__triage',
        isMcp: true,
      }),
      makePromptCommand({
        name: 'browser_harness:growth:outbound-audit',
        loadedFrom: 'mcp',
      }),
      makePromptCommand({
        name: 'browser_harness:workflow:growth:pipeline-refresh',
        loadedFrom: 'mcp',
        kind: 'workflow',
      }),
      makePromptCommand({
        name: 'browser_harness:workflow:ops:broken',
        loadedFrom: 'mcp',
        kind: 'workflow',
        disableModelInvocation: true,
      }),
      makePromptCommand({
        name: 'mcp__other_server__triage',
        isMcp: true,
      }),
    ]

    expect(filterMcpPromptsByServer(commands, 'browser harness')).toEqual([
      commands[0],
    ])
    expect(filterMcpSkillsByServer(commands, 'browser harness')).toEqual([
      commands[1],
    ])
    expect(filterMcpWorkflowsByServer(commands, 'browser harness')).toEqual([
      commands[2],
      commands[3],
    ])
  })
})
