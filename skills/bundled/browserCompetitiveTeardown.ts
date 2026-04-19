import {
  BROWSER_HARNESS_REFERENCE_FILES,
  buildBrowserCompetitiveTeardownWorkflowPrompt,
  isBrowserHarnessInstalledSync,
} from '../../utils/browserHarness.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerBrowserCompetitiveTeardownWorkflow(): void {
  registerBundledSkill({
    name: 'browser-competitive-teardown',
    description:
      'Compares a target site against live competitors in the browser and turns the gaps into a differentiation backlog.',
    whenToUse:
      'When the user needs a browser-backed competitive, positioning, or messaging teardown with evidence from live pages.',
    verbs: [
      'compare competitors',
      'map positioning gaps',
      'prioritize differentiation',
    ],
    inputs: ['Target URL', 'Competitor URLs', 'Primary buyer or ICP'],
    outputs: ['Competitive teardown', 'Differentiation backlog'],
    artifactKinds: ['competitive teardown', 'differentiation backlog'],
    successCriteria: [
      'Reviews the live target and competitor pages in the browser',
      'Calls out concrete proof, messaging, or offer gaps with evidence',
      'Produces a prioritized differentiation backlog',
    ],
    handoffFields: ['target_offer', 'primary_gap', 'winning_competitor'],
    workflowSteps: [
      {
        title: 'Map the target positioning',
        objective:
          'Review the target site and make the current offer, ICP, and CTA explicit',
        success: 'The target positioning is grounded in the live page experience',
        tools: ['Bash', 'Read', 'Grep'],
        retryCount: 1,
      },
      {
        title: 'Compare live competitors',
        objective:
          'Inspect competitor pages and capture the strongest differentiators and proof points',
        success:
          'The biggest positioning, proof, and offer gaps are explicit with evidence',
        tools: ['Bash', 'Read', 'Grep'],
        retryCount: 1,
        requiresHandoff: ['target_offer'],
      },
      {
        title: 'Prioritize differentiation moves',
        objective:
          'Turn the observed gaps into the next highest-leverage differentiation backlog',
        success: 'A clear differentiation backlog exists',
        tools: ['Bash', 'Read', 'Grep'],
        requiresHandoff: ['primary_gap', 'winning_competitor'],
      },
    ],
    argumentHint: '[target url, competitors, and buyer]',
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
          text: buildBrowserCompetitiveTeardownWorkflowPrompt(args),
        },
      ]
    },
  })
}
