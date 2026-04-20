import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
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

function makeCodeModeContext(extraCommands: Array<Record<string, unknown>> = []) {
  const browserWorkflow = {
    type: 'prompt',
    name: 'browser-funnel-audit',
    description: 'Audit a live browser funnel and recommend fixes',
    kind: 'workflow',
    verbs: ['audit funnel'],
    outputs: ['Funnel audit summary'],
    artifactKinds: ['funnel audit'],
    loadedFrom: 'bundled',
    userFacingName: () => 'Browser Funnel Audit',
  }

  const mcpWorkflow = {
    type: 'prompt',
    name: 'browser_harness:workflow:growth:funnel-refresh',
    description: 'Refresh the browser-backed funnel workflow',
    kind: 'workflow',
    verbs: ['refresh funnel'],
    outputs: ['Funnel refresh brief'],
    artifactKinds: ['funnel brief'],
    loadedFrom: 'mcp',
    userFacingName: () => 'Funnel Refresh',
  }

  const mcpSkill = {
    type: 'prompt',
    name: 'browser_harness:growth:outbound-audit',
    description: 'Audit outbound motion',
    loadedFrom: 'mcp',
    userFacingName: () => 'Outbound Audit',
  }

  return {
    options: {
      tools: [{ name: 'Read' }, { name: 'WebFetch' }, { name: 'Bash' }],
      commands: [browserWorkflow, ...extraCommands],
    },
    getAppState: () => ({
      mcp: {
        commands: [mcpWorkflow, mcpSkill],
        clients: [{ name: 'browser_harness', type: 'connected' }],
        resources: { browser_harness: [{ uri: 'workflow://growth/funnel-refresh' }] },
      },
    }),
  } as any
}

function makeGitHubDocsCapabilities(): Array<Record<string, unknown>> {
  return [
    {
      type: 'prompt',
      name: 'github:workflow:review-pr',
      description: 'Review a pull request and summarize the next changes',
      kind: 'workflow',
      verbs: ['review pull request'],
      outputs: ['PR review brief'],
      artifactKinds: ['review brief'],
      loadedFrom: 'plugin',
      source: 'plugin',
      userFacingName: () => 'PR Review',
    },
    {
      type: 'prompt',
      name: 'github:gh-fix-ci',
      description: 'Debug failing GitHub Actions checks for the current PR',
      verbs: ['fix ci'],
      outputs: ['CI fix plan'],
      loadedFrom: 'plugin',
      source: 'plugin',
      userFacingName: () => 'GitHub CI Fix',
    },
    {
      type: 'prompt',
      name: 'google-drive:workflow:publish-draft',
      description: 'Prepare a Google Doc for publishing and summarize the next edits',
      kind: 'workflow',
      verbs: ['publish draft'],
      outputs: ['Publishing brief'],
      artifactKinds: ['publishing brief'],
      loadedFrom: 'plugin',
      source: 'plugin',
      userFacingName: () => 'Publish Draft',
    },
    {
      type: 'prompt',
      name: 'google-drive:google-docs',
      description: 'Inspect and edit Google Docs documents with range precision',
      verbs: ['rewrite document'],
      outputs: ['Document update plan'],
      loadedFrom: 'plugin',
      source: 'plugin',
      userFacingName: () => 'Google Docs',
    },
  ]
}

describe('executeForkedWorkflow', () => {
  test('runs declared steps sequentially before final synthesis', async () => {
    const calls: Array<{
      stageKind: 'codegen' | 'step' | 'synthesis'
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
      stageKind: 'codegen' | 'step' | 'synthesis'
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
      stageKind: 'codegen' | 'step' | 'synthesis'
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

  test('retries final synthesis when a workflow-specific artifact validator rejects the output', async () => {
    const calls: Array<{
      stageKind: 'codegen' | 'step' | 'synthesis'
      stageIndex: number
      prompt: string
    }> = []
    const command = {
      ...makeWorkflowCommand(),
      outputs: ['Publishing brief', 'Edit checklist'],
      artifactKinds: ['publishing brief', 'edit checklist'],
      successCriteria: [
        'Adapts the draft to the intended channel',
        'Calls out the biggest edits still needed',
      ],
      handoffFields: ['target_channel', 'primary_edit_gap'],
      workflowArtifactValidator: 'publish-draft' as const,
    }
    let synthesisAttempts = 0

    const result = await executeForkedWorkflow({
      command,
      commandName: command.name,
      args: 'LinkedIn launch note',
      context: { options: { tools: [] } } as any,
      canUseTool: (() => ({ behavior: 'allow' })) as any,
      parentMessage: { message: { id: 'parent' } } as any,
      modifiedGetAppState: (() => ({})) as any,
      agentDefinition: { agentType: 'general-purpose' } as any,
      skillContent: '# Publish the draft',
      stageRunner: async stage => {
        calls.push(stage)
        if (stage.stageKind === 'step') {
          return JSON.stringify({
            summary: `Completed ${stage.stageIndex + 1}`,
            artifacts: [`Artifact ${stage.stageIndex + 1}`],
            risks: [],
            handoff: {
              target_channel: 'LinkedIn',
              primary_edit_gap: 'CTA needs tightening',
            },
          })
        }

        synthesisAttempts += 1
        if (synthesisAttempts === 1) {
          return JSON.stringify({
            summary: 'Prepared the final draft package',
            completionStatus: 'completed',
            outputs: [
              {
                name: 'Publishing brief',
                status: 'produced',
                evidence: 'Final draft package ready',
              },
              {
                name: 'Edit checklist',
                status: 'produced',
                evidence: 'Final checks complete',
              },
            ],
            artifacts: [
              {
                kind: 'publishing brief',
                status: 'produced',
                evidence: 'Final draft package ready',
              },
              {
                kind: 'edit checklist',
                status: 'produced',
                evidence: 'Final checks complete',
              },
            ],
            successCriteria: [
              {
                criterion: 'Adapts the draft to the intended channel',
                status: 'met',
                evidence: 'Package prepared',
              },
              {
                criterion: 'Calls out the biggest edits still needed',
                status: 'met',
                evidence: 'Checklist ready',
              },
            ],
            missingInputs: [],
            unresolvedRisks: [],
          })
        }

        return JSON.stringify({
          summary: 'Prepared the LinkedIn publishing brief and edit checklist',
          completionStatus: 'completed',
          outputs: [
            {
              name: 'Publishing brief',
              status: 'produced',
              evidence: 'LinkedIn publishing brief for the launch audience and release plan',
            },
            {
              name: 'Edit checklist',
              status: 'produced',
              evidence: 'Edit checklist calls out the CTA rewrite and approval blocker',
            },
          ],
          artifacts: [
            {
              kind: 'publishing brief',
              status: 'produced',
              evidence: 'LinkedIn publishing brief for the launch audience and release plan',
            },
            {
              kind: 'edit checklist',
              status: 'produced',
              evidence: 'Edit checklist calls out the CTA rewrite and approval blocker',
            },
          ],
          successCriteria: [
            {
              criterion: 'Adapts the draft to the intended channel',
              status: 'met',
              evidence: 'LinkedIn channel is explicit',
            },
            {
              criterion: 'Calls out the biggest edits still needed',
              status: 'met',
              evidence: 'CTA rewrite is the main edit gap',
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
      'Publish-draft validator requires the publishing brief evidence to mention the target channel or release plan explicitly.',
    )
    expect(result.data.result).toContain(
      'Prepared the LinkedIn publishing brief and edit checklist',
    )
  })

  test('runs code-mode workflows through generated orchestration before synthesis', async () => {
    const calls: Array<{
      stageKind: 'codegen' | 'step' | 'synthesis'
      stageIndex: number
      prompt: string
    }> = []
    const command = {
      ...makeWorkflowCommand(),
      workflowRuntime: 'code' as const,
    }

    const stateDir = await mkdtemp(join(tmpdir(), 'cc-code-mode-'))
    const statePath = join(stateDir, 'code-mode-state.json')

    try {
      const result = await executeForkedWorkflow({
        command,
        commandName: command.name,
        args: 'mid-market SaaS',
        context: makeCodeModeContext(),
        canUseTool: (() => ({ behavior: 'allow' })) as any,
        parentMessage: { message: { id: 'parent' } } as any,
        modifiedGetAppState: (() => ({})) as any,
        agentDefinition: { agentType: 'general-purpose' } as any,
        skillContent: '# Refresh the pipeline',
        codeModeStatePath: statePath,
        stageRunner: async stage => {
          calls.push(stage)
          if (stage.stageKind === 'codegen') {
            return `\`\`\`js
async ({ workflow, state, browser, cli, mcp, workspace, discovery }) => {
  const browserStatus = browser.status()
  const workspaceInfo = workspace.info()
  const browserMatches = discovery.searchByFamily('workflow', 'audit the live signup funnel and capture friction', 2)
  await state.set('browserInstalled', browserStatus.installed)
  await state.set('toolNames', cli.listTools().map(tool => tool.name).join(','))
  await state.set('mcpWorkflowCount', mcp.listWorkflows().length)
  await state.set('browserWorkflowAvailable', browser.hasWorkflow('Browser Funnel Audit'))
  await state.set('mcpServerSeen', mcp.hasServer('browser_harness'))
  await state.set('workspaceStatePath', workspace.statePath())
  await state.set('workspaceSharedStatePath', workspace.sharedStatePath())
  await state.set('workspaceTranscriptSubdir', workspace.transcriptSubdir())
  await state.set('workspaceRoot', workspace.root())
  await state.set('workspaceInfoSessionId', workspaceInfo.sessionId)
  await state.set('topDiscovery', browserMatches[0]?.name ?? null)
  await state.set('discoveryFamilies', discovery.listFamilies().join(','))

  await workflow.runStep(0)

  if (workflow.getHandoff().priority_segment) {
    await workflow.runStep(1)
  }

  await workflow.skipStep(2, 'Publish channel was not established')
}
\`\`\``
          }

          if (stage.stageKind === 'synthesis') {
            return JSON.stringify({
              summary: 'Code mode refreshed the pipeline',
              completionStatus: 'completed',
              outputs: [
                {
                  name: 'Updated pipeline brief',
                  status: 'produced',
                  evidence: 'Derived from code-mode evidence and prioritization',
                },
                {
                  name: 'Prioritized outreach backlog',
                  status: 'produced',
                  evidence: 'Ranked for mid-market SaaS',
                },
              ],
              artifacts: [
                {
                  kind: 'pipeline brief',
                  status: 'produced',
                  evidence: 'Pipeline brief ready',
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
                  evidence: 'Homepage ICP is stale',
                },
                {
                  criterion: 'Produces the next highest-leverage actions',
                  status: 'met',
                  evidence: 'Priority segment selected and backlog rebuilt',
                },
              ],
              missingInputs: [],
              unresolvedRisks: ['Publish channel still needs to be chosen'],
            })
          }

          if (stage.stageIndex === 0) {
            return JSON.stringify({
              summary: 'Gathered live evidence',
              artifacts: ['Evidence brief'],
              risks: ['Homepage messaging may be stale'],
              handoff: {
                stale_assumptions: 'Homepage ICP is stale',
                priority_segment: 'mid-market SaaS',
              },
            })
          }

          if (stage.stageIndex === 1) {
            return JSON.stringify({
              summary: 'Prioritized the backlog',
              artifacts: ['Prioritized backlog'],
              risks: [],
              handoff: {
                priority_segment: 'mid-market SaaS',
              },
            })
          }

          throw new Error(`Unexpected code-mode stage ${stage.stageKind}:${stage.stageIndex}`)
        },
      })

      expect(calls.map(call => call.stageKind)).toEqual([
        'codegen',
        'step',
        'step',
        'synthesis',
      ])
      expect(calls[0]?.prompt).toContain('Return ONLY JavaScript')
      expect(calls[0]?.prompt).toContain('Use code to decide sequencing, branching, looping, and state instead of explaining the workflow in prose')
      expect(calls[0]?.prompt).toContain('state`: persistent workflow state with `get(key)`, `set(key, value)`')
      expect(calls[0]?.prompt).toContain('browser`: typed browser capability helpers')
      expect(calls[0]?.prompt).toContain('cli`: typed CLI capability helpers')
      expect(calls[0]?.prompt).toContain('mcp`: typed MCP capability helpers')
      expect(calls[0]?.prompt).toContain('workspace`: typed workspace/session helpers')
      expect(calls[0]?.prompt).toContain('sharedStatePath()')
      expect(calls[0]?.prompt).toContain('discovery`: typed capability discovery helpers')
      expect(calls[1]?.prompt).toContain('Title: Gather evidence')
      expect(calls[2]?.prompt).toContain('Title: Prioritize actions')
      expect(calls[3]?.prompt).toContain('3. Draft publish plan')
      expect(calls[3]?.prompt).toContain('Status: skipped')
      expect(calls[3]?.prompt).toContain(
        'Summary: Skipped: Publish channel was not established',
      )
      expect(result.data.result).toContain('Code mode refreshed the pipeline')
      expect(result.data.result).toContain('Open risks: Publish channel still needs to be chosen')

      const persisted = JSON.parse(await readFile(statePath, 'utf-8')) as Record<
        string,
        any
      >
      expect(persisted.phase).toBe('completed')
      expect(persisted.programSource).toContain('browser.status()')
      expect(typeof persisted.userState.browserInstalled).toBe('boolean')
      expect(persisted.userState.toolNames).toBe('Read,WebFetch,Bash')
      expect(persisted.userState.mcpWorkflowCount).toBe(2)
      expect(persisted.userState.browserWorkflowAvailable).toBe(true)
      expect(persisted.userState.mcpServerSeen).toBe(true)
      expect(persisted.userState.workspaceStatePath).toBe(statePath)
      expect(persisted.userState.workspaceSharedStatePath).toBe(
        persisted.capabilities.workspace.sharedStatePath,
      )
      expect(persisted.userState.workspaceTranscriptSubdir).toBe(
        persisted.capabilities.workspace.transcriptSubdir,
      )
      expect(typeof persisted.userState.workspaceRoot).toBe('string')
      expect(persisted.userState.workspaceInfoSessionId).toBe(
        persisted.capabilities.workspace.sessionId,
      )
      expect(persisted.userState.topDiscovery).toBe('browser-funnel-audit')
      expect(String(persisted.userState.discoveryFamilies)).toContain('browser')
      expect(persisted.capabilities.discovery).toMatchObject({
        capabilityCount: 4,
      })
      expect(persisted.capabilities.cli.allowedTools).toEqual([
        'Read',
        'WebFetch',
      ])
      expect(persisted.capabilities.workspace.statePath).toBe(statePath)
      expect(typeof persisted.capabilities.workspace.sharedStatePath).toBe(
        'string',
      )
      expect(persisted.capabilities.mcp.servers[0]).toMatchObject({
        name: 'browser_harness',
        connected: true,
        workflowCount: 2,
        skillCount: 1,
      })
      expect(persisted.stepOutcomes).toHaveLength(3)
      expect(persisted.finalState.summary).toBe('Code mode refreshed the pipeline')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('locks code-mode execution away from Node globals and persists the failure', async () => {
    const command = {
      ...makeWorkflowCommand(),
      workflowRuntime: 'code' as const,
    }
    const stateDir = await mkdtemp(join(tmpdir(), 'cc-code-mode-fail-'))
    const statePath = join(stateDir, 'code-mode-state.json')

    try {
      await expect(
        executeForkedWorkflow({
          command,
          commandName: command.name,
          args: 'mid-market SaaS',
          context: makeCodeModeContext(),
          canUseTool: (() => ({ behavior: 'allow' })) as any,
          parentMessage: { message: { id: 'parent' } } as any,
          modifiedGetAppState: (() => ({})) as any,
          agentDefinition: { agentType: 'general-purpose' } as any,
          skillContent: '# Refresh the pipeline',
          codeModeStatePath: statePath,
          stageRunner: async stage => {
            if (stage.stageKind === 'codegen') {
              return 'async () => process.cwd()'
            }
            throw new Error('synthesis should not run when code mode fails')
          },
        }),
      ).rejects.toThrow(/process is not defined/)

      const persisted = JSON.parse(await readFile(statePath, 'utf-8')) as Record<
        string,
        any
      >
      expect(persisted.phase).toBe('failed')
      expect(String(persisted.error)).toContain('process is not defined')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('exposes typed github and docs capability metadata inside code mode', async () => {
    const calls: Array<{
      stageKind: 'codegen' | 'step' | 'synthesis'
      stageIndex: number
      prompt: string
    }> = []
    const command = {
      ...makeWorkflowCommand(),
      workflowRuntime: 'code' as const,
    }
    const stateDir = await mkdtemp(join(tmpdir(), 'cc-code-mode-gh-docs-'))
    const statePath = join(stateDir, 'code-mode-state.json')

    try {
      const result = await executeForkedWorkflow({
        command,
        commandName: command.name,
        args: 'refresh supporting materials',
        context: makeCodeModeContext(makeGitHubDocsCapabilities()),
        canUseTool: (() => ({ behavior: 'allow' })) as any,
        parentMessage: { message: { id: 'parent' } } as any,
        modifiedGetAppState: (() => ({})) as any,
        agentDefinition: { agentType: 'general-purpose' } as any,
        skillContent: '# Refresh the pipeline',
        codeModeStatePath: statePath,
        stageRunner: async stage => {
          calls.push(stage)
          if (stage.stageKind === 'codegen') {
            return `\`\`\`js
async ({ workflow, state, github, docs }) => {
  await state.set('githubWorkflowCount', github.listWorkflows().length)
  await state.set('githubHasReviewWorkflow', github.hasWorkflow('PR Review'))
  await state.set('githubFirstCapability', github.listRepoCapabilities()[0]?.name ?? null)
  await state.set('docsWorkflowCount', docs.listWorkflows().length)
  await state.set('docsHasPublishWorkflow', docs.hasWorkflow('Publish Draft'))
  await state.set('docsFirstCapability', docs.listDocCapabilities()[0]?.name ?? null)

  await workflow.runStep(0)
  await workflow.skipStep(1, 'Typed capability smoke only')
  await workflow.skipStep(2, 'Typed capability smoke only')
}
\`\`\``
          }

          if (stage.stageKind === 'synthesis') {
            return JSON.stringify({
              summary: 'Validated typed GitHub and Docs capabilities',
              completionStatus: 'completed',
              outputs: [
                {
                  name: 'Updated pipeline brief',
                  status: 'produced',
                  evidence: 'Typed capability metadata was available during orchestration',
                },
                {
                  name: 'Prioritized outreach backlog',
                  status: 'produced',
                  evidence: 'Workflow still completed the first structured step',
                },
              ],
              artifacts: [
                {
                  kind: 'pipeline brief',
                  status: 'produced',
                  evidence: 'Capability smoke artifact',
                },
                {
                  kind: 'outreach backlog',
                  status: 'produced',
                  evidence: 'Capability smoke backlog',
                },
              ],
              successCriteria: [
                {
                  criterion: 'Calls out stale assumptions',
                  status: 'met',
                  evidence: 'Typed capability smoke path completed',
                },
                {
                  criterion: 'Produces the next highest-leverage actions',
                  status: 'met',
                  evidence: 'Capability discovery completed inside code mode',
                },
              ],
              missingInputs: [],
              unresolvedRisks: [],
            })
          }

          return JSON.stringify({
            summary: 'Gathered evidence for typed capability smoke',
            artifacts: ['Capability evidence'],
            risks: [],
            handoff: {
              stale_assumptions: 'Smoke only',
              priority_segment: 'refresh supporting materials',
            },
          })
        },
      })

      expect(calls[0]?.prompt).toContain('github`: typed GitHub capability helpers')
      expect(calls[0]?.prompt).toContain('docs`: typed document capability helpers')
      expect(result.data.result).toContain(
        'Validated typed GitHub and Docs capabilities',
      )

      const persisted = JSON.parse(await readFile(statePath, 'utf-8')) as Record<
        string,
        any
      >
      expect(persisted.userState.githubWorkflowCount).toBe(1)
      expect(persisted.userState.githubHasReviewWorkflow).toBe(true)
      expect(persisted.userState.githubFirstCapability).toBe('github:gh-fix-ci')
      expect(persisted.userState.docsWorkflowCount).toBe(1)
      expect(persisted.userState.docsHasPublishWorkflow).toBe(true)
      expect(persisted.userState.docsFirstCapability).toBe(
        'google-drive:google-docs',
      )
      expect(persisted.capabilities.github.workflows).toHaveLength(1)
      expect(persisted.capabilities.github.repoCapabilities).toHaveLength(1)
      expect(persisted.capabilities.docs.workflows).toHaveLength(1)
      expect(persisted.capabilities.docs.docCapabilities).toHaveLength(1)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('hides ungranted code-mode capability APIs from browser-only workflows', async () => {
    const calls: Array<{
      stageKind: 'codegen' | 'step' | 'synthesis'
      stageIndex: number
      prompt: string
    }> = []
    const command = {
      ...makeWorkflowCommand(),
      workflowRuntime: 'code' as const,
      capabilityGrants: ['browser'] as const,
    }
    const stateDir = await mkdtemp(join(tmpdir(), 'cc-code-mode-grants-'))
    const statePath = join(stateDir, 'code-mode-state.json')

    try {
      const result = await executeForkedWorkflow({
        command,
        commandName: command.name,
        args: 'browser-only audit',
        context: makeCodeModeContext(makeGitHubDocsCapabilities()),
        canUseTool: (() => ({ behavior: 'allow' })) as any,
        parentMessage: { message: { id: 'parent' } } as any,
        modifiedGetAppState: (() => ({})) as any,
        agentDefinition: { agentType: 'general-purpose' } as any,
        skillContent: '# Refresh the pipeline',
        codeModeStatePath: statePath,
        stageRunner: async stage => {
          calls.push(stage)
          if (stage.stageKind === 'codegen') {
            return `\`\`\`js
async ({ workflow, state, browser, github, docs, discovery }) => {
  await state.set('hasBrowserApi', Boolean(browser))
  await state.set('hasGitHubApi', Boolean(github))
  await state.set('hasDocsApi', Boolean(docs))
  await state.set('hasDiscoveryApi', Boolean(discovery))
  await state.set('browserWorkflowCount', browser?.listWorkflows().length ?? 0)

  await workflow.runStep(0)
  await workflow.skipStep(1, 'Capability grant smoke only')
  await workflow.skipStep(2, 'Capability grant smoke only')
}
\`\`\``
          }

          if (stage.stageKind === 'synthesis') {
            return JSON.stringify({
              summary: 'Validated browser-only capability grants',
              completionStatus: 'completed',
              outputs: [
                {
                  name: 'Updated pipeline brief',
                  status: 'produced',
                  evidence: 'Browser-only code-mode path completed',
                },
                {
                  name: 'Prioritized outreach backlog',
                  status: 'produced',
                  evidence: 'Workflow still completed the first step',
                },
              ],
              artifacts: [
                {
                  kind: 'pipeline brief',
                  status: 'produced',
                  evidence: 'Browser-only smoke artifact',
                },
                {
                  kind: 'outreach backlog',
                  status: 'produced',
                  evidence: 'Browser-only smoke backlog',
                },
              ],
              successCriteria: [
                {
                  criterion: 'Calls out stale assumptions',
                  status: 'met',
                  evidence: 'Capability grant validation completed',
                },
                {
                  criterion: 'Produces the next highest-leverage actions',
                  status: 'met',
                  evidence: 'Workflow still produced the first step result',
                },
              ],
              missingInputs: [],
              unresolvedRisks: [],
            })
          }

          return JSON.stringify({
            summary: 'Gathered evidence for browser-only capability smoke',
            artifacts: ['Capability evidence'],
            risks: [],
            handoff: {
              stale_assumptions: 'Browser-only smoke',
              priority_segment: 'browser-only audit',
            },
          })
        },
      })

      expect(calls[0]?.prompt).toContain(
        'Capability grants: browser',
      )
      expect(calls[0]?.prompt).toContain(
        '`browser`: typed browser capability helpers',
      )
      expect(calls[0]?.prompt).not.toContain(
        '`github`: typed GitHub capability helpers',
      )
      expect(calls[0]?.prompt).not.toContain(
        '`docs`: typed document capability helpers',
      )
      expect(calls[0]?.prompt).not.toContain(
        '`discovery`: typed capability discovery helpers',
      )
      expect(result.data.result).toContain(
        'Validated browser-only capability grants',
      )

      const persisted = JSON.parse(await readFile(statePath, 'utf-8')) as Record<
        string,
        any
      >
      expect(persisted.workflow.capabilityGrants).toEqual(['browser'])
      expect(persisted.userState.hasBrowserApi).toBe(true)
      expect(persisted.userState.hasGitHubApi).toBe(false)
      expect(persisted.userState.hasDocsApi).toBe(false)
      expect(persisted.userState.hasDiscoveryApi).toBe(false)
      expect(persisted.userState.browserWorkflowCount).toBeGreaterThan(0)
      expect(persisted.capabilities.github.workflows).toHaveLength(0)
      expect(persisted.capabilities.github.repoCapabilities).toHaveLength(0)
      expect(persisted.capabilities.docs.workflows).toHaveLength(0)
      expect(persisted.capabilities.docs.docCapabilities).toHaveLength(0)
      expect(persisted.capabilities.browser.workflows.length).toBeGreaterThan(0)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('restores shared workflow state across later runs in the same project', async () => {
    const command = {
      ...makeWorkflowCommand(),
      workflowRuntime: 'code' as const,
      capabilityGrants: ['workspace'] as const,
    }
    const stateDir = await mkdtemp(join(tmpdir(), 'cc-code-mode-shared-'))
    const firstStatePath = join(stateDir, 'first-run.json')
    const secondStatePath = join(stateDir, 'second-run.json')
    const sharedStatePath = join(stateDir, 'shared-workflow-state.json')

    const makeSynthesisResult = (summary: string) =>
      JSON.stringify({
        summary,
        completionStatus: 'completed',
        outputs: [
          {
            name: 'Updated pipeline brief',
            status: 'produced',
            evidence: 'Shared workflow state persisted successfully',
          },
          {
            name: 'Prioritized outreach backlog',
            status: 'produced',
            evidence: 'Step execution still completed under the shared-state path',
          },
        ],
        artifacts: [
          {
            kind: 'pipeline brief',
            status: 'produced',
            evidence: 'Shared-state pipeline artifact',
          },
          {
            kind: 'outreach backlog',
            status: 'produced',
            evidence: 'Shared-state backlog artifact',
          },
        ],
        successCriteria: [
          {
            criterion: 'Calls out stale assumptions',
            status: 'met',
            evidence: 'The shared workflow state was available during execution',
          },
          {
            criterion: 'Produces the next highest-leverage actions',
            status: 'met',
            evidence: 'The workflow still completed with durable memory',
          },
        ],
        missingInputs: [],
        unresolvedRisks: [],
      })

    try {
      await executeForkedWorkflow({
        command,
        commandName: command.name,
        args: 'segment-one',
        context: makeCodeModeContext(),
        canUseTool: (() => ({ behavior: 'allow' })) as any,
        parentMessage: { message: { id: 'parent-1' } } as any,
        modifiedGetAppState: (() => ({})) as any,
        agentDefinition: { agentType: 'general-purpose' } as any,
        skillContent: '# Refresh the pipeline',
        codeModeStatePath: firstStatePath,
        codeModeSharedStatePath: sharedStatePath,
        stageRunner: async stage => {
          if (stage.stageKind === 'codegen') {
            return `\`\`\`js
async ({ args, state, workflow, workspace }) => {
  await state.set('lastSegment', args)
  await state.set('sharedPathSeen', workspace.sharedStatePath())
  await workflow.runStep(0)
  await workflow.skipStep(1, 'Shared-state smoke only')
  await workflow.skipStep(2, 'Shared-state smoke only')
}
\`\`\``
          }

          if (stage.stageKind === 'synthesis') {
            return makeSynthesisResult('Stored shared workflow state')
          }

          return JSON.stringify({
            summary: 'Gathered evidence for shared-state smoke',
            artifacts: ['Shared-state evidence'],
            risks: [],
            handoff: {
              stale_assumptions: 'Shared-state smoke',
              priority_segment: 'segment-one',
            },
          })
        },
      })

      const firstSharedPersisted = JSON.parse(
        await readFile(sharedStatePath, 'utf-8'),
      ) as Record<string, any>
      expect(firstSharedPersisted.userState.lastSegment).toBe('segment-one')
      expect(firstSharedPersisted.userState.sharedPathSeen).toBe(sharedStatePath)

      await executeForkedWorkflow({
        command,
        commandName: command.name,
        args: 'segment-two',
        context: makeCodeModeContext(),
        canUseTool: (() => ({ behavior: 'allow' })) as any,
        parentMessage: { message: { id: 'parent-2' } } as any,
        modifiedGetAppState: (() => ({})) as any,
        agentDefinition: { agentType: 'general-purpose' } as any,
        skillContent: '# Refresh the pipeline',
        codeModeStatePath: secondStatePath,
        codeModeSharedStatePath: sharedStatePath,
        stageRunner: async stage => {
          if (stage.stageKind === 'codegen') {
            return `\`\`\`js
async ({ args, state, workflow, workspace }) => {
  await state.set('previousSegment', state.get('lastSegment') ?? null)
  await state.set('lastSegment', args)
  await state.set('sharedPathSeenAgain', workspace.info().sharedStatePath)
  await workflow.runStep(0)
  await workflow.skipStep(1, 'Shared-state smoke only')
  await workflow.skipStep(2, 'Shared-state smoke only')
}
\`\`\``
          }

          if (stage.stageKind === 'synthesis') {
            return makeSynthesisResult('Restored shared workflow state')
          }

          return JSON.stringify({
            summary: 'Gathered evidence for shared-state resume',
            artifacts: ['Shared-state evidence'],
            risks: [],
            handoff: {
              stale_assumptions: 'Shared-state resume',
              priority_segment: 'segment-two',
            },
          })
        },
      })

      const secondPersisted = JSON.parse(
        await readFile(secondStatePath, 'utf-8'),
      ) as Record<string, any>
      expect(secondPersisted.userState.previousSegment).toBe('segment-one')
      expect(secondPersisted.userState.lastSegment).toBe('segment-two')
      expect(secondPersisted.userState.sharedPathSeenAgain).toBe(sharedStatePath)
      expect(secondPersisted.capabilities.workspace.sharedStatePath).toBe(
        sharedStatePath,
      )

      const secondSharedPersisted = JSON.parse(
        await readFile(sharedStatePath, 'utf-8'),
      ) as Record<string, any>
      expect(secondSharedPersisted.userState.previousSegment).toBe('segment-one')
      expect(secondSharedPersisted.userState.lastSegment).toBe('segment-two')
      expect(secondSharedPersisted.lastTranscriptSubdir).toContain('workflows/')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
