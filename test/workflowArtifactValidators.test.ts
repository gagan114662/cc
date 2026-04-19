import { describe, expect, test } from 'bun:test'
import type {
  WorkflowCommand,
  WorkflowFinalState,
  WorkflowStepOutcome,
} from 'src/utils/workflowCommands.js'
import { validateWorkflowFinalState } from 'src/utils/workflowCommands.js'

function makeWorkflowCommand(
  overrides: Partial<WorkflowCommand>,
): WorkflowCommand {
  return {
    type: 'prompt',
    name: 'test-workflow',
    description: 'Test workflow',
    progressMessage: 'running workflow',
    contentLength: 10,
    source: 'bundled',
    loadedFrom: 'bundled',
    context: 'fork',
    kind: 'workflow',
    async getPromptForCommand() {
      return [{ type: 'text', text: '# test' }]
    },
    ...overrides,
  }
}

function makeFinalState(
  overrides: Partial<WorkflowFinalState>,
): WorkflowFinalState {
  return {
    structured: true,
    summary: 'Completed workflow',
    completionStatus: 'completed',
    outputs: [],
    artifacts: [],
    successCriteria: [],
    missingInputs: [],
    unresolvedRisks: [],
    ...overrides,
  }
}

function makeStepOutcome(
  handoff: Record<string, string>,
): WorkflowStepOutcome {
  return {
    step: { title: 'Test step' },
    result: 'ok',
    state: {
      status: 'completed',
      structured: true,
      summary: 'completed',
      artifacts: [],
      risks: [],
      handoff,
    },
  }
}

describe('workflow artifact validators', () => {
  test('pipeline-refresh validator reports missing handoff and prioritization evidence precisely', () => {
    const command = makeWorkflowCommand({
      outputs: ['Pipeline refresh brief', 'Prioritized outreach backlog'],
      artifactKinds: ['pipeline brief', 'outreach backlog'],
      successCriteria: [
        'Calls out stale assumptions before replacing them',
        'Produces an ordered outreach backlog',
      ],
      workflowArtifactValidator: 'pipeline-refresh',
    })

    const finalState = makeFinalState({
      summary: 'Refreshed the growth plan',
      outputs: [
        {
          name: 'Pipeline refresh brief',
          status: 'produced',
          evidence: 'Updated the GTM plan for the team',
        },
        {
          name: 'Prioritized outreach backlog',
          status: 'produced',
          evidence: 'List of accounts to contact next',
        },
      ],
      artifacts: [
        {
          kind: 'pipeline brief',
          status: 'produced',
          evidence: 'Updated the GTM plan for the team',
        },
        {
          kind: 'outreach backlog',
          status: 'produced',
          evidence: 'List of accounts to contact next',
        },
      ],
      successCriteria: [
        {
          criterion: 'Calls out stale assumptions before replacing them',
          status: 'met',
          evidence: 'Plan updated',
        },
        {
          criterion: 'Produces an ordered outreach backlog',
          status: 'met',
          evidence: 'Backlog drafted',
        },
      ],
    })

    const validation = validateWorkflowFinalState(finalState, command, [
      makeStepOutcome({
        stale_assumptions: 'Homepage ICP is outdated',
        priority_segment: 'B2B SaaS',
      }),
    ])

    expect(validation.valid).toBe(false)
    expect(validation.issues).toContain(
      'Pipeline validator requires next_motion handoff evidence from the workflow steps.',
    )
    expect(validation.issues).toContain(
      'Pipeline validator requires the outreach backlog evidence to show that the backlog was prioritized.',
    )
  })

  test('inbox-triage validator reports missing routing evidence precisely', () => {
    const command = makeWorkflowCommand({
      outputs: ['Inbox triage brief', 'Prioritized response queue'],
      artifactKinds: ['triage brief', 'response queue'],
      successCriteria: [
        'Separates urgent work from routine follow-up',
        'Produces a concrete response queue',
      ],
      workflowArtifactValidator: 'inbox-triage',
    })

    const finalState = makeFinalState({
      summary: 'Reviewed the inbox and captured next steps',
      outputs: [
        {
          name: 'Inbox triage brief',
          status: 'produced',
          evidence: 'Summary of the inbox volume',
        },
        {
          name: 'Prioritized response queue',
          status: 'produced',
          evidence: 'Follow up with the listed messages',
        },
      ],
      artifacts: [
        {
          kind: 'triage brief',
          status: 'produced',
          evidence: 'Summary of the inbox volume',
        },
        {
          kind: 'response queue',
          status: 'produced',
          evidence: 'Follow up with the listed messages',
        },
      ],
      successCriteria: [
        {
          criterion: 'Separates urgent work from routine follow-up',
          status: 'met',
          evidence: 'Messages grouped',
        },
        {
          criterion: 'Produces a concrete response queue',
          status: 'met',
          evidence: 'Queue drafted',
        },
      ],
    })

    const validation = validateWorkflowFinalState(finalState, command, [
      makeStepOutcome({
        urgent_queue: 'Customer escalations',
      }),
    ])

    expect(validation.valid).toBe(false)
    expect(validation.issues).toContain(
      'Inbox triage validator requires response_owner handoff evidence from the workflow steps.',
    )
    expect(validation.issues).toContain(
      'Inbox triage validator requires the triage brief evidence to describe urgency, blocked work, or routing decisions.',
    )
  })

  test('publish-draft validator passes when channel and edit evidence are explicit', () => {
    const command = makeWorkflowCommand({
      outputs: ['Publishing brief', 'Edit checklist'],
      artifactKinds: ['publishing brief', 'edit checklist'],
      successCriteria: [
        'Adapts the draft to the intended channel',
        'Calls out the biggest edits still needed',
      ],
      workflowArtifactValidator: 'publish-draft',
    })

    const finalState = makeFinalState({
      summary: 'Prepared the LinkedIn release brief and the final edit checklist',
      outputs: [
        {
          name: 'Publishing brief',
          status: 'produced',
          evidence: 'LinkedIn launch brief for the target audience with the release CTA',
        },
        {
          name: 'Edit checklist',
          status: 'produced',
          evidence: 'Edit checklist covers the CTA rewrite and approval blocker',
        },
      ],
      artifacts: [
        {
          kind: 'publishing brief',
          status: 'produced',
          evidence: 'LinkedIn launch brief for the target audience with the release CTA',
        },
        {
          kind: 'edit checklist',
          status: 'produced',
          evidence: 'Edit checklist covers the CTA rewrite and approval blocker',
        },
      ],
      successCriteria: [
        {
          criterion: 'Adapts the draft to the intended channel',
          status: 'met',
          evidence: 'LinkedIn channel and audience are explicit',
        },
        {
          criterion: 'Calls out the biggest edits still needed',
          status: 'met',
          evidence: 'Primary CTA gap and approval blocker are named',
        },
      ],
    })

    const validation = validateWorkflowFinalState(finalState, command, [
      makeStepOutcome({
        target_channel: 'LinkedIn',
        primary_edit_gap: 'CTA needs tightening',
      }),
    ])

    expect(validation.valid).toBe(true)
    expect(validation.issues).toEqual([])
  })
})
