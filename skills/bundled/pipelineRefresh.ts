import { registerBundledSkill } from '../bundledSkills.js'

function buildPipelineRefreshWorkflowPrompt(args?: string): string {
  return `# Pipeline Refresh

Refresh the current growth pipeline using the freshest available context instead of repeating stale assumptions.

Primary objective:
- turn the latest positioning, ICP, demand, and funnel context into a sharper pipeline brief and the next highest-leverage outreach backlog

Working rules:
- prefer current evidence from the workspace, recent project materials, and explicitly stated workflow arguments
- call out stale assumptions before replacing them
- keep the backlog concrete, prioritized, and ready for an operator to execute
- do not claim a full refresh if the key source material is missing; call out the missing context directly

Deliverable requirements:
- summarize the current pipeline and what changed
- identify the highest-leverage segment, offer, or motion to prioritize next
- produce a prioritized outreach backlog
- surface the top risks, blockers, or unknowns still left open

Task:

${args || 'Refresh the current growth pipeline and produce the next prioritized outreach backlog.'}
`
}

export function registerPipelineRefreshWorkflow(): void {
  registerBundledSkill({
    name: 'pipeline-refresh',
    description:
      'Refreshes the current growth pipeline and turns the latest context into a prioritized outreach backlog.',
    whenToUse:
      'When the user needs to refresh the growth pipeline after messaging, ICP, market, or demand changes.',
    verbs: ['refresh pipeline', 'prioritize outreach', 'update growth plan'],
    inputs: ['Current positioning', 'ICP assumptions', 'Recent GTM context'],
    outputs: ['Pipeline refresh brief', 'Prioritized outreach backlog'],
    artifactKinds: ['pipeline brief', 'outreach backlog'],
    successCriteria: [
      'Calls out stale assumptions before replacing them',
      'Identifies the next highest-leverage pipeline focus',
      'Produces an ordered outreach backlog',
    ],
    handoffFields: ['stale_assumptions', 'priority_segment', 'next_motion'],
    workflowSteps: [
      {
        title: 'Gather the latest pipeline context',
        objective:
          'Review the current positioning, ICP, and demand context before changing the plan',
        success: 'A current fact base exists for the refresh',
        tools: ['Read', 'Grep', 'Glob'],
        retryCount: 1,
      },
      {
        title: 'Identify stale assumptions and the next focus',
        objective:
          'Separate what changed from what is still true and pick the next highest-leverage motion',
        success: 'The priority segment and motion are explicit',
        tools: ['Read', 'Grep'],
        requiresHandoff: ['stale_assumptions'],
      },
      {
        title: 'Produce the refreshed backlog',
        objective:
          'Turn the refreshed view into an ordered outreach backlog that can be executed next',
        success: 'A prioritized backlog exists',
        tools: ['Read', 'Grep'],
        requiresHandoff: ['priority_segment', 'next_motion'],
      },
    ],
    argumentHint: '[context or segment to refresh]',
    allowedTools: ['Read', 'Grep', 'Glob'],
    userInvocable: true,
    context: 'fork',
    workflowRuntime: 'code',
    capabilityGrants: ['discovery', 'workspace', 'cli'],
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildPipelineRefreshWorkflowPrompt(args) }]
    },
  })
}
