import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeForkedWorkflow } from 'src/tools/SkillTool/workflowExecution.js'
import type { WorkflowCommand } from 'src/utils/workflowCommands.js'
import { getCapabilityFamily } from 'src/utils/capabilityDiscovery.js'

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

function makeAnalyticsContext(extraCommands: Array<Record<string, unknown>> = []) {
  return {
    options: {
      tools: [{ name: 'Read' }, { name: 'WebFetch' }, { name: 'Bash' }],
      commands: [
        {
          type: 'prompt',
          name: 'browser-funnel-audit',
          description: 'Audit a live browser funnel and recommend fixes',
          kind: 'workflow',
          verbs: ['audit funnel'],
          outputs: ['Funnel audit summary'],
          artifactKinds: ['funnel audit'],
          loadedFrom: 'bundled',
          userFacingName: () => 'Browser Funnel Audit',
        },
        ...extraCommands,
      ],
    },
    getAppState: () => ({
      mcp: {
        commands: [],
        clients: [],
        resources: {},
      },
    }),
  } as any
}

function makeGitHubCapabilities(): Array<Record<string, unknown>> {
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
  ]
}

describe('workflow analytics', () => {
  test('records typed capability usage and discovery misses for code-mode workflows', async () => {
    const command = {
      ...makeWorkflowCommand(),
      workflowRuntime: 'code' as const,
      capabilityGrants: ['browser', 'github', 'discovery'] as ('mcp' | 'github' | 'cli' | 'discovery' | 'browser' | 'docs' | 'workspace')[],
    }
    const analyticsDir = await mkdtemp(join(tmpdir(), 'cc-workflow-analytics-'))
    const analyticsPath = join(analyticsDir, 'workflow-analytics.json')

    try {
      await executeForkedWorkflow({
        command,
        commandName: command.name,
        args: 'analytics smoke',
        context: makeAnalyticsContext(makeGitHubCapabilities()),
        canUseTool: (() => ({ behavior: 'allow' })) as any,
        parentMessage: { message: { id: 'analytics-parent' } } as any,
        modifiedGetAppState: (() => ({})) as any,
        agentDefinition: { agentType: 'general-purpose' } as any,
        skillContent: '# Refresh the pipeline',
        workflowAnalyticsPath: analyticsPath,
        stageRunner: async stage => {
          if (stage.stageKind === 'codegen') {
            return `\`\`\`js
async ({ workflow, browser, github, discovery }) => {
  browser.status()
  github.listWorkflows()
  github.hasWorkflow('PR Review')
  discovery.search('review pull request', 2)
  discovery.searchByFamily('pack', 'no matching pack capability', 2)
  await workflow.runStep(0)
  await workflow.skipStep(1, 'Analytics smoke only')
  await workflow.skipStep(2, 'Analytics smoke only')
}
\`\`\``
          }

          if (stage.stageKind === 'synthesis') {
            return JSON.stringify({
              summary: 'Collected workflow analytics',
              completionStatus: 'completed',
              outputs: [
                {
                  name: 'Updated pipeline brief',
                  status: 'produced',
                  evidence: 'Workflow completed with typed capability usage',
                },
                {
                  name: 'Prioritized outreach backlog',
                  status: 'produced',
                  evidence: 'Shared analytics smoke backlog produced',
                },
              ],
              artifacts: [
                {
                  kind: 'pipeline brief',
                  status: 'produced',
                  evidence: 'Analytics pipeline artifact',
                },
                {
                  kind: 'outreach backlog',
                  status: 'produced',
                  evidence: 'Analytics backlog artifact',
                },
              ],
              successCriteria: [
                {
                  criterion: 'Calls out stale assumptions',
                  status: 'met',
                  evidence: 'Analytics smoke completed',
                },
                {
                  criterion: 'Produces the next highest-leverage actions',
                  status: 'met',
                  evidence: 'Workflow still completed under analytics tracking',
                },
              ],
              missingInputs: [],
              unresolvedRisks: [],
            })
          }

          return JSON.stringify({
            summary: 'Gathered analytics smoke evidence',
            artifacts: ['Analytics evidence'],
            risks: [],
            handoff: {
              stale_assumptions: 'Analytics smoke',
              priority_segment: 'analytics smoke',
            },
          })
        },
      })

      const analytics = JSON.parse(
        await readFile(analyticsPath, 'utf-8'),
      ) as Record<string, any>
      const family = getCapabilityFamily(command)
      expect(analytics.workflowRuns[command.name].successfulRuns).toBe(1)
      expect(analytics.workflowFamilies[family].successfulRuns).toBe(1)
      expect(analytics.capabilityUsage['browser.status']).toBe(1)
      expect(analytics.capabilityUsage['github.listWorkflows']).toBe(1)
      expect(analytics.capabilityUsage['github.hasWorkflow']).toBe(1)
      expect(analytics.capabilityUsage['discovery.search']).toBe(1)
      expect(analytics.capabilityUsage['discovery.searchByFamily']).toBe(1)
      expect(analytics.discoveryMisses['pack:no matching pack capability']).toBe(
        1,
      )
    } finally {
      await rm(analyticsDir, { recursive: true, force: true })
    }
  })

  test('records failed workflow runs by family', async () => {
    const command = {
      ...makeWorkflowCommand(),
      workflowRuntime: 'code' as const,
    }
    const analyticsDir = await mkdtemp(join(tmpdir(), 'cc-workflow-failure-'))
    const analyticsPath = join(analyticsDir, 'workflow-analytics.json')

    try {
      await expect(
        executeForkedWorkflow({
          command,
          commandName: command.name,
          args: 'failure smoke',
          context: makeAnalyticsContext(),
          canUseTool: (() => ({ behavior: 'allow' })) as any,
          parentMessage: { message: { id: 'failure-parent' } } as any,
          modifiedGetAppState: (() => ({})) as any,
          agentDefinition: { agentType: 'general-purpose' } as any,
          skillContent: '# Refresh the pipeline',
          workflowAnalyticsPath: analyticsPath,
          stageRunner: async stage => {
            if (stage.stageKind === 'codegen') {
              return 'async () => process.cwd()'
            }
            throw new Error('synthesis should not run on failure analytics smoke')
          },
        }),
      ).rejects.toThrow(/process is not defined/)

      const analytics = JSON.parse(
        await readFile(analyticsPath, 'utf-8'),
      ) as Record<string, any>
      const family = getCapabilityFamily(command)
      expect(analytics.workflowRuns[command.name].failedRuns).toBe(1)
      expect(analytics.workflowFamilies[family].failedRuns).toBe(1)
    } finally {
      await rm(analyticsDir, { recursive: true, force: true })
    }
  })

  test('records validator failure reasons even when the workflow recovers on retry', async () => {
    const command = {
      ...makeWorkflowCommand(),
      workflowArtifactValidator: 'pipeline-refresh' as const,
    }
    const analyticsDir = await mkdtemp(join(tmpdir(), 'cc-workflow-validator-'))
    const analyticsPath = join(analyticsDir, 'workflow-analytics.json')
    let synthesisAttempts = 0

    try {
      await executeForkedWorkflow({
        command,
        commandName: command.name,
        args: 'validator smoke',
        context: makeAnalyticsContext(),
        canUseTool: (() => ({ behavior: 'allow' })) as any,
        parentMessage: { message: { id: 'validator-parent' } } as any,
        modifiedGetAppState: (() => ({})) as any,
        agentDefinition: { agentType: 'general-purpose' } as any,
        skillContent: '# Refresh the pipeline',
        workflowAnalyticsPath: analyticsPath,
        stageRunner: async stage => {
          if (stage.stageKind === 'synthesis') {
            synthesisAttempts += 1
            if (synthesisAttempts === 1) {
              return JSON.stringify({
                summary: 'Initial synthesis missed pipeline evidence',
                completionStatus: 'completed',
                outputs: [
                  {
                    name: 'Updated pipeline brief',
                    status: 'produced',
                    evidence: 'Vague summary only',
                  },
                  {
                    name: 'Prioritized outreach backlog',
                    status: 'produced',
                    evidence: 'Vague backlog only',
                  },
                ],
                artifacts: [
                  {
                    kind: 'pipeline brief',
                    status: 'produced',
                    evidence: 'Brief exists',
                  },
                  {
                    kind: 'outreach backlog',
                    status: 'produced',
                    evidence: 'Backlog exists',
                  },
                ],
                successCriteria: [
                  {
                    criterion: 'Calls out stale assumptions',
                    status: 'met',
                    evidence: 'Implicit only',
                  },
                  {
                    criterion: 'Produces the next highest-leverage actions',
                    status: 'met',
                    evidence: 'Implicit only',
                  },
                ],
                missingInputs: [],
                unresolvedRisks: [],
              })
            }

            return JSON.stringify({
              summary: 'Recovered after validator feedback',
              completionStatus: 'completed',
              outputs: [
                {
                  name: 'Updated pipeline brief',
                  status: 'produced',
                  evidence: 'Calls out stale ICP assumptions and the next segment',
                },
                {
                  name: 'Prioritized outreach backlog',
                  status: 'produced',
                  evidence: 'Ranks mid-market SaaS follow-ups by leverage',
                },
              ],
              artifacts: [
                {
                  kind: 'pipeline brief',
                  status: 'produced',
                  evidence: 'Pipeline brief calls out stale ICP assumptions directly',
                },
                {
                  kind: 'outreach backlog',
                  status: 'produced',
                  evidence: 'Backlog is explicitly prioritized for the next segment',
                },
              ],
              successCriteria: [
                {
                  criterion: 'Calls out stale assumptions',
                  status: 'met',
                  evidence: 'Stale ICP assumptions are explicit',
                },
                {
                  criterion: 'Produces the next highest-leverage actions',
                  status: 'met',
                  evidence: 'The next segment and actions are explicit',
                },
              ],
              missingInputs: [],
              unresolvedRisks: [],
            })
          }

          return JSON.stringify({
            summary: 'Validator smoke evidence gathered',
            artifacts: ['Validator evidence'],
            risks: [],
            handoff: {
              stale_assumptions: 'Homepage ICP is stale',
              priority_segment: 'mid-market SaaS',
              next_motion: 'Prioritize the mid-market SaaS outbound sequence',
            },
          })
        },
      })

      const analytics = JSON.parse(
        await readFile(analyticsPath, 'utf-8'),
      ) as Record<string, any>
      const validatorIssues = Object.keys(analytics.validatorFailures)
      expect(validatorIssues.length).toBeGreaterThan(0)
      expect(
        analytics.workflowRuns[command.name].validatorFailures[validatorIssues[0]],
      ).toBeGreaterThan(0)
      expect(analytics.workflowRuns[command.name].successfulRuns).toBe(1)
    } finally {
      await rm(analyticsDir, { recursive: true, force: true })
    }
  })
})
