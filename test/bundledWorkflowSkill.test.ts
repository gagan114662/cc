import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearBundledSkills,
  getBundledSkills,
} from 'src/skills/bundledSkills.js'
import { registerBrowserCompetitiveTeardownWorkflow } from 'src/skills/bundled/browserCompetitiveTeardown.js'
import { registerBrowserFunnelAuditWorkflow } from 'src/skills/bundled/browserFunnelAudit.js'
import { registerBrowserSupportFaqAuditWorkflow } from 'src/skills/bundled/browserSupportFaqAudit.js'

describe('bundled workflow skills', () => {
  afterEach(() => {
    clearBundledSkills()
  })

  test('registers browser-backed business workflows as first-class workflows', () => {
    registerBrowserFunnelAuditWorkflow()
    registerBrowserCompetitiveTeardownWorkflow()
    registerBrowserSupportFaqAuditWorkflow()

    const workflows = getBundledSkills().filter(
      command => command.kind === 'workflow',
    )
    const workflowNames = workflows.map(command => command.name)

    expect(workflowNames).toEqual(
      expect.arrayContaining([
        'browser-funnel-audit',
        'browser-competitive-teardown',
        'browser-support-faq-audit',
      ]),
    )

    const competitive = workflows.find(
      command => command.name === 'browser-competitive-teardown',
    )
    const support = workflows.find(
      command => command.name === 'browser-support-faq-audit',
    )

    expect(competitive?.context).toBe('fork')
    expect(competitive?.workflowRuntime).toBe('code')
    expect(competitive?.capabilityGrants).toEqual([
      'browser',
      'discovery',
      'workspace',
    ])
    expect(competitive?.artifactKinds).toContain('competitive teardown')
    expect(competitive?.verbs).toContain('map positioning gaps')
    expect(competitive?.workflowSteps).toHaveLength(3)

    expect(support?.context).toBe('fork')
    expect(support?.workflowRuntime).toBe('code')
    expect(support?.capabilityGrants).toEqual([
      'browser',
      'discovery',
      'workspace',
    ])
    expect(support?.artifactKinds).toContain('support audit')
    expect(support?.verbs).toContain('audit support path')
    expect(support?.workflowSteps).toHaveLength(3)
  })
})
