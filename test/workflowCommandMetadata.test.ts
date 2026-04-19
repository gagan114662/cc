import { describe, expect, test } from 'bun:test'
import type { Command } from 'src/commands.js'
import { formatCommandsWithinBudget } from 'src/tools/SkillTool/prompt.js'
import { generateCommandSuggestions } from 'src/utils/suggestions/commandSuggestions.js'

function makeWorkflowCommand(): Command {
  return {
    type: 'prompt',
    name: 'browser_harness:workflow:growth:pipeline-refresh',
    description: 'Rebuild the GTM pipeline from the current public surface',
    whenToUse:
      'The user needs a refreshed plan after messaging, market, or demand changes',
    verbs: ['refresh pipeline', 'prioritize outreach'],
    inputs: ['Website and positioning', 'Current ICP assumptions'],
    outputs: ['Updated pipeline brief', 'Prioritized outreach backlog'],
    artifactKinds: ['pipeline brief', 'outreach backlog'],
    successCriteria: [
      'Calls out stale assumptions',
      'Produces the next highest-leverage actions',
    ],
    handoffFields: ['stale_assumptions', 'priority_segment'],
    workflowSteps: [
      {
        title: 'Gather evidence',
        objective: 'Review the current website and positioning',
      },
      {
        title: 'Prioritize actions',
        success: 'The next actions are ranked by leverage',
      },
    ],
    allowedTools: ['Read', 'WebFetch'],
    argNames: ['segment'],
    kind: 'workflow',
    contentLength: 42,
    progressMessage: 'running',
    source: 'mcp',
    loadedFrom: 'mcp',
    async getPromptForCommand() {
      return [{ type: 'text', text: '# Refresh the pipeline' }]
    },
    userFacingName() {
      return 'Pipeline Refresh'
    },
  }
}

describe('workflow command metadata', () => {
  test('includes structured workflow metadata in model-facing skill listings', () => {
    const rendered = formatCommandsWithinBudget([makeWorkflowCommand()])

    expect(rendered).toContain('Use when:')
    expect(rendered).toContain('Operations:')
    expect(rendered).toContain('Inputs:')
    expect(rendered).toContain('Outputs:')
    expect(rendered).toContain('Artifacts:')
    expect(rendered).toContain('Success:')
    expect(rendered).toContain('Handoff:')
    expect(rendered).toContain('Procedure:')
    expect(rendered).toContain('Tools:')
    expect(rendered).toContain('Arguments:')
  })

  test('surfaces workflow metadata in command suggestions', () => {
    const suggestions = generateCommandSuggestions('/pipeline', [
      makeWorkflowCommand(),
    ])

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.tag).toBe('workflow')
    expect(suggestions[0]?.description).toContain('Operations:')
    expect(suggestions[0]?.description).toContain('Outputs:')
    expect(suggestions[0]?.description).toContain('Updated pipeline brief')
    expect(suggestions[0]?.description).toContain('Artifacts:')
    expect(suggestions[0]?.description).toContain('Procedure:')
  })

  test('finds workflows by structured artifact and handoff fields', () => {
    const commands = [makeWorkflowCommand()]

    const artifactSuggestions = generateCommandSuggestions('/outreach', commands)
    expect(artifactSuggestions).toHaveLength(1)
    expect(artifactSuggestions[0]?.displayText).toContain('/Pipeline Refresh')

    const handoffSuggestions = generateCommandSuggestions(
      '/stale_assumptions',
      commands,
    )
    expect(handoffSuggestions).toHaveLength(1)
    expect(handoffSuggestions[0]?.tag).toBe('workflow')
  })
})
