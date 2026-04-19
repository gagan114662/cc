import {
  BROWSER_HARNESS_REFERENCE_FILES,
  buildBrowserSupportFaqAuditWorkflowPrompt,
  isBrowserHarnessInstalledSync,
} from '../../utils/browserHarness.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerBrowserSupportFaqAuditWorkflow(): void {
  registerBundledSkill({
    name: 'browser-support-faq-audit',
    description:
      'Audits the live support and FAQ paths in the browser and turns the gaps into a prioritized support backlog.',
    whenToUse:
      'When the user needs a browser-backed support, FAQ, or contact-path audit with concrete evidence from the live customer experience.',
    verbs: ['audit support path', 'map faq gaps', 'prioritize support fixes'],
    inputs: ['Support or help-center URL', 'Top customer task'],
    outputs: ['Support audit summary', 'FAQ/support backlog'],
    artifactKinds: ['support audit', 'faq backlog'],
    successCriteria: [
      'Walks the live support or help-center experience instead of summarizing static copy',
      'Captures the top customer-task blockers with evidence',
      'Produces a prioritized FAQ or support backlog',
    ],
    handoffFields: ['top_customer_task', 'biggest_support_gap'],
    workflowSteps: [
      {
        title: 'Map the support entry points',
        objective:
          'Open the live help, FAQ, support, and contact paths a customer would actually use',
        success: 'The current support paths are explicit',
        tools: ['Bash', 'Read', 'Grep'],
        retryCount: 1,
      },
      {
        title: 'Test the highest-priority customer task',
        objective:
          'Attempt the top customer task and identify the biggest blockers or answer gaps',
        success: 'The biggest support gap is explicit with evidence',
        tools: ['Bash', 'Read', 'Grep'],
        retryCount: 1,
        requiresHandoff: ['top_customer_task'],
      },
      {
        title: 'Prioritize FAQ and support fixes',
        objective:
          'Turn the observed gaps into the next FAQ, support, or ops improvements',
        success: 'A prioritized support backlog exists',
        tools: ['Bash', 'Read', 'Grep'],
        requiresHandoff: ['biggest_support_gap'],
      },
    ],
    argumentHint: '[support url and top customer task]',
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    userInvocable: true,
    context: 'fork',
    workflowRuntime: 'code',
    isEnabled: () => isBrowserHarnessInstalledSync(),
    files: BROWSER_HARNESS_REFERENCE_FILES,
    async getPromptForCommand(args) {
      return [
        {
          type: 'text',
          text: buildBrowserSupportFaqAuditWorkflowPrompt(args),
        },
      ]
    },
  })
}
