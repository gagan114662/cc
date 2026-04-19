import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearBundledSkills,
  getBundledSkills,
  registerBundledSkill,
} from 'src/skills/bundledSkills.js'

describe('bundled workflow skills', () => {
  afterEach(() => {
    clearBundledSkills()
  })

  test('registers browser funnel audit as a first-class workflow', () => {
    registerBundledSkill({
      name: 'browser-funnel-audit',
      description: 'Audit a live website funnel and recommend fixes',
      whenToUse: 'Use when a browser-backed funnel audit is needed',
      verbs: ['audit funnel'],
      inputs: ['Target URL'],
      outputs: ['Funnel audit summary'],
      artifactKinds: ['funnel audit'],
      successCriteria: ['Calls out the biggest friction points'],
      handoffFields: ['highest_friction_step'],
      workflowSteps: [
        { title: 'Open funnel' },
        { title: 'Collect friction evidence' },
        { title: 'Recommend fixes' },
      ],
      context: 'fork',
      allowedTools: ['Bash'],
      async getPromptForCommand() {
        return [{ type: 'text', text: '# Audit the funnel' }]
      },
    })

    const workflow = getBundledSkills().find(
      command => command.name === 'browser-funnel-audit',
    )

    expect(workflow).toBeDefined()
    expect(workflow?.kind).toBe('workflow')
    expect(workflow?.context).toBe('fork')
    expect(workflow?.verbs).toContain('audit funnel')
    expect(workflow?.artifactKinds).toContain('funnel audit')
    expect(workflow?.workflowSteps).toHaveLength(3)
  })
})
