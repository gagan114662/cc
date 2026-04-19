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
        retryCount: 1,
      },
      {
        title: 'Prioritize actions',
        success: 'The next actions are ranked by leverage',
        tools: ['Read', 'WebFetch'],
        requiresHandoff: ['priority_segment'],
      },
      {
        title: 'Draft publish plan',
        success: 'The publish plan is ready',
        onFailure: 'continue',
        requiresHandoff: ['publish_channel'],
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
          return JSON.stringify({
            summary: 'Pipeline refreshed with the next outreach segment',
            completionStatus: 'completed',
            outputs: [
              {
                name: 'Updated pipeline brief',
                status: 'produced',
                evidence: 'Synthesized from the evidence and prioritization steps',
              },
              {
                name: 'Prioritized outreach backlog',
                status: 'produced',
                evidence: 'Ordered by leverage for B2B SaaS',
              },
            ],
            artifacts: [
              {
                kind: 'pipeline brief',
                status: 'produced',
                evidence: 'Artifact 1',
              },
              {
                kind: 'outreach backlog',
                status: 'produced',
                evidence: 'Artifact 2',
              },
            ],
            successCriteria: [
              {
                criterion: 'Calls out stale assumptions',
                status: 'met',
                evidence: 'Homepage ICP is outdated',
              },
              {
                criterion: 'Produces the next highest-leverage actions',
                status: 'met',
                evidence: 'Priority segment set to B2B SaaS',
              },
            ],
            missingInputs: [],
            unresolvedRisks: ['Publish connector still needs setup'],
          })
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

    expect(calls.map(call => call.stageKind)).toEqual(['step', 'step', 'synthesis'])
    expect(new Set(calls.map(call => call.transcriptSubdir)).size).toBe(1)

    expect(calls[0]?.prompt).toContain('You are executing step 1 of 3')
    expect(calls[0]?.prompt).toContain('Title: Gather evidence')
    expect(calls[0]?.prompt).toContain('Workflow arguments: B2B SaaS')
    expect(calls[0]?.prompt).toContain('None yet. Establish the initial fact base')
    expect(calls[0]?.prompt).toContain('Return ONLY JSON')
    expect(calls[0]?.prompt).toContain('"stale_assumptions": "..."')
    expect(calls[0]?.prompt).toContain('Retries: 1')

    expect(calls[1]?.prompt).toContain('You are executing step 2 of 3')
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
    expect(calls[2]?.prompt).toContain('Status: completed')
    expect(calls[2]?.prompt).toContain('Summary: Completed 1')
    expect(calls[2]?.prompt).toContain('2. Prioritize actions')
    expect(calls[2]?.prompt).toContain('Summary: Completed 2')
    expect(calls[2]?.prompt).toContain(
      '3. Draft publish plan',
    )
    expect(calls[2]?.prompt).toContain('Status: skipped')
    expect(calls[2]?.prompt).toContain('Return ONLY JSON')
    expect(calls[2]?.prompt).toContain('"completionStatus": "completed | partial | blocked"')

    expect(result.data).toMatchObject({
      success: true,
      commandName: command.name,
      status: 'forked',
    })
    expect(result.data.result).toContain(
      'Pipeline refreshed with the next outreach segment',
    )
    expect(result.data.result).toContain('Completion: completed')
    expect(result.data.result).toContain('Outputs:')
    expect(result.data.result).toContain(
      '- Updated pipeline brief: produced',
    )
    expect(result.data.result).toContain('Artifacts:')
    expect(result.data.result).toContain('Success criteria:')
    expect(result.data.result).toContain(
      'Open risks: Publish connector still needs setup',
    )
  })

  test('retries structured step failures and continues past continue-on-error steps', async () => {
    const calls: Array<{
      stageKind: 'step' | 'synthesis'
      stageIndex: number
      prompt: string
    }> = []
    const command = makeWorkflowCommand()
    let stepOneAttempts = 0

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
          return JSON.stringify({
            summary: 'Recovered pipeline deliverable',
            completionStatus: 'partial',
            outputs: [
              {
                name: 'Updated pipeline brief',
                status: 'produced',
                evidence: 'Recovered after retry',
              },
              {
                name: 'Prioritized outreach backlog',
                status: 'produced',
                evidence: 'Prioritized backlog',
              },
            ],
            artifacts: [
              {
                kind: 'pipeline brief',
                status: 'produced',
                evidence: 'Evidence brief',
              },
              {
                kind: 'outreach backlog',
                status: 'produced',
                evidence: 'Prioritized backlog',
              },
            ],
            successCriteria: [
              {
                criterion: 'Calls out stale assumptions',
                status: 'met',
                evidence: 'Recovered evidence',
              },
              {
                criterion: 'Produces the next highest-leverage actions',
                status: 'met',
                evidence: 'Prioritized backlog',
              },
            ],
            missingInputs: [],
            unresolvedRisks: ['Publishing connector unavailable'],
          })
        }
        if (stage.stageIndex === 0) {
          stepOneAttempts += 1
          if (stepOneAttempts === 1) {
            return 'plain text, not structured json'
          }
          return JSON.stringify({
            summary: 'Gathered evidence after retry',
            artifacts: ['Evidence brief'],
            risks: [],
            handoff: {
              priority_segment: 'B2B SaaS',
            },
          })
        }
        if (stage.stageIndex === 1) {
          return JSON.stringify({
            summary: 'Prioritized actions',
            artifacts: ['Prioritized backlog'],
            risks: [],
            handoff: {
              priority_segment: 'B2B SaaS',
              publish_channel: 'linkedin',
            },
          })
        }
        throw new Error('Publishing connector unavailable')
      },
    })

    expect(stepOneAttempts).toBe(2)
    expect(calls.filter(call => call.stageKind === 'step')).toHaveLength(4)
    expect(calls[1]?.prompt).toContain('Attempt: 2 of 2')
    expect(calls[1]?.prompt).toContain(
      'Previous failure: Step did not return the required structured JSON handoff.',
    )
    expect(calls.at(-1)?.prompt).toContain('Status: failed')
    expect(calls.at(-1)?.prompt).toContain(
      'Summary: Step failed: Publishing connector unavailable',
    )
    expect(result.data.result).toContain('Recovered pipeline deliverable')
    expect(result.data.result).toContain('Completion: partial')
  })

  test('retries final synthesis when the artifact contract is invalid', async () => {
    const calls: Array<{
      stageKind: 'step' | 'synthesis'
      stageIndex: number
      prompt: string
    }> = []
    const command = makeWorkflowCommand()
    let synthesisAttempts = 0

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
        if (stage.stageKind === 'step') {
          return JSON.stringify({
            summary: `Completed ${stage.stageIndex + 1}`,
            artifacts: [`Artifact ${stage.stageIndex + 1}`],
            risks: [],
            handoff: {
              stale_assumptions: 'Homepage ICP is outdated',
              priority_segment: 'B2B SaaS',
              publish_channel: 'linkedin',
            },
          })
        }

        synthesisAttempts += 1
        if (synthesisAttempts === 1) {
          return JSON.stringify({
            summary: 'Looks good',
            completionStatus: 'completed',
            outputs: [],
            artifacts: [],
            successCriteria: [],
            missingInputs: [],
            unresolvedRisks: [],
          })
        }

        return JSON.stringify({
          summary: 'Validated workflow artifact contract',
          completionStatus: 'completed',
          outputs: [
            {
              name: 'Updated pipeline brief',
              status: 'produced',
              evidence: 'Evidence brief',
            },
            {
              name: 'Prioritized outreach backlog',
              status: 'produced',
              evidence: 'Backlog ready',
            },
          ],
          artifacts: [
            {
              kind: 'pipeline brief',
              status: 'produced',
              evidence: 'Evidence brief',
            },
            {
              kind: 'outreach backlog',
              status: 'produced',
              evidence: 'Backlog ready',
            },
          ],
          successCriteria: [
            {
              criterion: 'Calls out stale assumptions',
              status: 'met',
              evidence: 'Homepage ICP is outdated',
            },
            {
              criterion: 'Produces the next highest-leverage actions',
              status: 'met',
              evidence: 'Backlog ready',
            },
          ],
          missingInputs: [],
          unresolvedRisks: [],
        })
      },
    })

    expect(synthesisAttempts).toBe(2)
    expect(calls.filter(call => call.stageKind === 'synthesis')).toHaveLength(2)
    expect(calls.at(-1)?.prompt).toContain(
      'Your previous answer failed workflow artifact validation.',
    )
    expect(calls.at(-1)?.prompt).toContain(
      'Missing output: Updated pipeline brief',
    )
    expect(result.data.result).toContain('Validated workflow artifact contract')
  })
})
