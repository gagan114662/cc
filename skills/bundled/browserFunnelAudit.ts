import {
  BROWSER_HARNESS_REFERENCE_FILES,
  buildBrowserFunnelAuditWorkflowPrompt,
  isBrowserHarnessInstalledSync,
} from '../../utils/browserHarness.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerBrowserFunnelAuditWorkflow(): void {
  registerBundledSkill({
    name: 'browser-funnel-audit',
    description:
      'Audits a live website funnel in the browser, captures friction evidence, and proposes the next fixes.',
    whenToUse:
      'When the user needs a browser-backed funnel, conversion, or signup audit with concrete evidence instead of a generic web review.',
    verbs: ['audit funnel', 'capture friction', 'recommend fixes'],
    inputs: ['Target URL', 'Conversion goal'],
    outputs: ['Funnel audit summary', 'Prioritized fixes'],
    artifactKinds: ['funnel audit', 'fix backlog'],
    successCriteria: [
      'Audits the live browser flow instead of a static page summary',
      'Calls out the highest-friction steps with evidence',
      'Produces the next recommended fixes',
    ],
    handoffFields: ['conversion_goal', 'highest_friction_step'],
    workflowSteps: [
      {
        title: 'Open the funnel and capture the current path',
        objective:
          'Load the target site in a fresh tab and establish the actual funnel path being audited',
        success: 'The audited path and conversion goal are explicit',
        tools: ['Bash', 'Read', 'Grep'],
        retryCount: 1,
      },
      {
        title: 'Collect friction evidence',
        objective:
          'Step through the live flow and capture the biggest points of friction',
        success: 'The top friction points are backed by concrete evidence',
        tools: ['Bash', 'Read', 'Grep'],
        retryCount: 1,
        requiresHandoff: ['conversion_goal'],
      },
      {
        title: 'Recommend the next fixes',
        objective:
          'Turn the observed friction into the next highest-leverage fixes',
        success: 'A prioritized fix backlog exists',
        tools: ['Bash', 'Read', 'Grep'],
        requiresHandoff: ['highest_friction_step'],
      },
    ],
    argumentHint: '[target url and goal]',
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    userInvocable: true,
    context: 'fork',
    workflowRuntime: 'code',
    capabilityGrants: ['browser', 'discovery', 'workspace'],
    isEnabled: () => isBrowserHarnessInstalledSync(),
    files: BROWSER_HARNESS_REFERENCE_FILES,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildBrowserFunnelAuditWorkflowPrompt(args) }]
    },
  })
}
