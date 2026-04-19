import { registerBundledSkill } from '../bundledSkills.js'

function buildPublishDraftWorkflowPrompt(args?: string): string {
  return `# Publish Draft

Turn the current draft into a publish-ready package instead of only critiquing it at a high level.

Primary objective:
- reshape the draft for the intended channel, tighten the publish plan, and surface the last edits needed before release

Working rules:
- preserve the core idea of the draft while making it more publishable
- adapt the structure, clarity, and CTA to the target channel
- call out missing inputs that block a real publish recommendation
- prefer a concrete publishing brief and edit list over generic writing advice

Deliverable requirements:
- summarize the draft and publish goal
- identify the biggest edits still needed
- produce a publish-ready brief or checklist
- call out unresolved content, channel, or approval blockers

Task:

${args || 'Turn the current draft into a publish-ready brief and checklist.'}
`
}

export function registerPublishDraftWorkflow(): void {
  registerBundledSkill({
    name: 'publish-draft',
    description:
      'Turns a working draft into a channel-ready publishing brief with the next edits and release checklist.',
    whenToUse:
      'When the user needs to turn a draft into a publish-ready asset for docs, content, or external communication.',
    verbs: ['publish draft', 'tighten draft', 'prepare release copy'],
    inputs: ['Current draft', 'Target channel', 'Publishing goal'],
    outputs: ['Publishing brief', 'Edit checklist'],
    artifactKinds: ['publishing brief', 'edit checklist'],
    successCriteria: [
      'Adapts the draft to the intended channel',
      'Calls out the biggest edits still needed',
      'Produces a concrete publishing brief or checklist',
    ],
    handoffFields: ['target_channel', 'primary_edit_gap', 'approval_blocker'],
    workflowSteps: [
      {
        title: 'Review the current draft and publish goal',
        objective:
          'Make the current draft, audience, and channel explicit before revising the publish plan',
        success: 'The draft and target channel are explicit',
        tools: ['Read', 'Grep', 'Glob'],
        retryCount: 1,
      },
      {
        title: 'Identify the biggest publish blockers',
        objective:
          'Find the structural, messaging, or approval gaps that still block publishing',
        success: 'The main edit gap is explicit',
        tools: ['Read', 'Grep'],
        requiresHandoff: ['target_channel'],
      },
      {
        title: 'Produce the publishing brief and checklist',
        objective:
          'Turn the reviewed draft into the next publish-ready brief and edit checklist',
        success: 'A publish-ready brief exists',
        tools: ['Read', 'Grep'],
        requiresHandoff: ['primary_edit_gap'],
      },
    ],
    argumentHint: '[draft context and target channel]',
    allowedTools: ['Read', 'Grep', 'Glob'],
    userInvocable: true,
    context: 'fork',
    workflowRuntime: 'code',
    workflowArtifactValidator: 'publish-draft',
    capabilityGrants: ['docs', 'discovery', 'workspace'],
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildPublishDraftWorkflowPrompt(args) }]
    },
  })
}
