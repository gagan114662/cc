import { describe, expect, test } from 'bun:test'
import type { WorkflowCommand } from 'src/utils/workflowCommands.js'
import { executeForkedWorkflow } from 'src/tools/SkillTool/workflowExecution.js'

function makeWorkflowCommand(): WorkflowCommand {
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
        success: 'A current fact base exists',
        tools: ['Read'],
      },
      {
        title: 'Prioritize actions',
        success: 'The next actions are ranked by leverage',
        tools: ['Read', 'WebFetch'],
      },
    ],
    allowedTools: ['Read', 'WebFetch'],
    argNames: ['segment'],
    kind: 'workflow',
    context: 'fork',
    contentLength: 42,
    progressMessage: 'running workflow',
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

describe('executeForkedWorkflow', () => {
  test('runs declared steps sequentially before final synthesis', async () => {
    const calls: Array<{
      stageKind: 'step' | 'synthesis'
      stageIndex: number
      prompt: string
      transcriptSubdir: string
    }> = []
    const command = makeWorkflowCommand()

    const result = await executeForkedWorkflow({
      command,
      commandName: command.name,
      args: 'B2B SaaS',
      context: { options: { tools: [] } } as any,
      canUseTool: (() => ({ behavior: 'allow' })) as any,
      parentMessage: { message: { id: 'parent' } } as any,
      modifiedGetAppState: (() => ({})) as any,
      agentDefinition: { agentType: 'general-purpose' } as any,
      skillContent: '# Refresh the pipeline',
      stageRunner: async stage => {
        calls.push(stage)
        if (stage.stageKind === 'synthesis') {
          return 'Final workflow deliverable'
        }
        return JSON.stringify({
          summary: `Completed ${stage.stageIndex + 1}`,
          artifacts: [`Artifact ${stage.stageIndex + 1}`],
          risks:
            stage.stageIndex === 0 ? ['Homepage messaging may be stale'] : [],
          handoff:
            stage.stageIndex === 0
              ? {
                  stale_assumptions: 'Homepage ICP is outdated',
                  priority_segment: 'B2B SaaS',
                }
              : {
                  stale_assumptions: 'Resolved',
                },
        })
      },
    })

    expect(calls.map(call => call.stageKind)).toEqual([
      'step',
      'step',
      'synthesis',
    ])
    expect(new Set(calls.map(call => call.transcriptSubdir)).size).toBe(1)

    expect(calls[0]?.prompt).toContain('You are executing step 1 of 2')
    expect(calls[0]?.prompt).toContain('Title: Gather evidence')
    expect(calls[0]?.prompt).toContain('Workflow arguments: B2B SaaS')
    expect(calls[0]?.prompt).toContain('None yet. Establish the initial fact base')
    expect(calls[0]?.prompt).toContain('Return ONLY JSON')
    expect(calls[0]?.prompt).toContain('"stale_assumptions": "..."')

    expect(calls[1]?.prompt).toContain('You are executing step 2 of 2')
    expect(calls[1]?.prompt).toContain('Title: Prioritize actions')
    expect(calls[1]?.prompt).toContain('Completed steps so far:')
    expect(calls[1]?.prompt).toContain('1. Gather evidence')
    expect(calls[1]?.prompt).toContain('Summary: Completed 1')
    expect(calls[1]?.prompt).toContain('Artifacts: Artifact 1')
    expect(calls[1]?.prompt).toContain(
      'Handoff: stale_assumptions=Homepage ICP is outdated; priority_segment=B2B SaaS',
    )

    expect(calls[2]?.prompt).toContain('Synthesize the step outputs')
    expect(calls[2]?.prompt).toContain('Step outcomes:')
    expect(calls[2]?.prompt).toContain('1. Gather evidence')
    expect(calls[2]?.prompt).toContain('Summary: Completed 1')
    expect(calls[2]?.prompt).toContain('2. Prioritize actions')
    expect(calls[2]?.prompt).toContain('Summary: Completed 2')

    expect(result.data).toMatchObject({
      success: true,
      commandName: command.name,
      status: 'forked',
      result: 'Final workflow deliverable',
    })
  })
})
