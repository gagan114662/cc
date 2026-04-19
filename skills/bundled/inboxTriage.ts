import { registerBundledSkill } from '../bundledSkills.js'

function buildInboxTriageWorkflowPrompt(args?: string): string {
  return `# Inbox Triage

Triage the current inbox workload into a clear action queue instead of treating every message as equal priority.

Primary objective:
- classify the inbox, identify what needs action now, and produce a clear response / follow-up queue

Working rules:
- separate urgent customer or revenue-critical work from routine follow-ups
- call out missing context that prevents confident routing
- prefer concise, operator-ready triage decisions over verbose summaries
- include response recommendations only when they are grounded in the message context

Deliverable requirements:
- summarize the inbox themes or queues discovered
- identify urgent, blocked, and lower-priority work
- produce the next response or follow-up queue
- call out unresolved routing or policy gaps

Task:

${args || 'Triage the current inbox and produce the next prioritized response queue.'}
`
}

export function registerInboxTriageWorkflow(): void {
  registerBundledSkill({
    name: 'inbox-triage',
    description:
      'Triages inbound work into a prioritized response queue with explicit urgency, routing, and follow-up decisions.',
    whenToUse:
      'When the user needs to triage an inbox, queue, or inbound workload into clear next actions.',
    verbs: ['triage inbox', 'prioritize responses', 'route follow-up'],
    inputs: ['Inbox context', 'Routing rules', 'Current priorities'],
    outputs: ['Inbox triage brief', 'Prioritized response queue'],
    artifactKinds: ['triage brief', 'response queue'],
    successCriteria: [
      'Separates urgent work from routine follow-up',
      'Produces a concrete response queue',
      'Calls out blocked or ambiguous routing decisions',
    ],
    handoffFields: ['urgent_queue', 'blocked_queue', 'response_owner'],
    workflowSteps: [
      {
        title: 'Review the current inbox workload',
        objective:
          'Gather the current inbound items, themes, and priorities before routing anything',
        success: 'The current inbox picture is explicit',
        tools: ['Read', 'Grep', 'Glob'],
        retryCount: 1,
      },
      {
        title: 'Classify urgency and routing',
        objective:
          'Decide what is urgent, blocked, or routine and who should handle each class of work',
        success: 'Urgent and blocked queues are explicit',
        tools: ['Read', 'Grep'],
      },
      {
        title: 'Produce the response queue',
        objective:
          'Turn the classified inbox into the next response and follow-up queue',
        success: 'A prioritized response queue exists',
        tools: ['Read', 'Grep'],
        requiresHandoff: ['urgent_queue', 'response_owner'],
      },
    ],
    argumentHint: '[inbox context or routing focus]',
    allowedTools: ['Read', 'Grep', 'Glob'],
    userInvocable: true,
    context: 'fork',
    workflowRuntime: 'code',
    workflowArtifactValidator: 'inbox-triage',
    capabilityGrants: ['discovery', 'workspace', 'cli'],
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildInboxTriageWorkflowPrompt(args) }]
    },
  })
}
