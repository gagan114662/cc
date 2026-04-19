import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearBundledSkills,
  getBundledSkills,
} from 'src/skills/bundledSkills.js'
import { registerBrowserCompetitiveTeardownWorkflow } from 'src/skills/bundled/browserCompetitiveTeardown.js'
import { registerBrowserFunnelAuditWorkflow } from 'src/skills/bundled/browserFunnelAudit.js'
import { registerBrowserSupportFaqAuditWorkflow } from 'src/skills/bundled/browserSupportFaqAudit.js'
import { registerInboxTriageWorkflow } from 'src/skills/bundled/inboxTriage.js'
import { registerPipelineRefreshWorkflow } from 'src/skills/bundled/pipelineRefresh.js'
import { registerPublishDraftWorkflow } from 'src/skills/bundled/publishDraft.js'

describe('bundled workflow skills', () => {
  afterEach(() => {
    clearBundledSkills()
  })

  test('registers browser-backed business workflows as first-class workflows', () => {
    registerBrowserFunnelAuditWorkflow()
    registerBrowserCompetitiveTeardownWorkflow()
    registerBrowserSupportFaqAuditWorkflow()
    registerPipelineRefreshWorkflow()
    registerInboxTriageWorkflow()
    registerPublishDraftWorkflow()

    const workflows = getBundledSkills().filter(
      command => command.kind === 'workflow',
    )
    const workflowNames = workflows.map(command => command.name)

    expect(workflowNames).toEqual(
      expect.arrayContaining([
        'browser-funnel-audit',
        'browser-competitive-teardown',
        'browser-support-faq-audit',
        'pipeline-refresh',
        'inbox-triage',
        'publish-draft',
      ]),
    )

    const competitive = workflows.find(
      command => command.name === 'browser-competitive-teardown',
    )
    const support = workflows.find(
      command => command.name === 'browser-support-faq-audit',
    )
    const pipeline = workflows.find(
      command => command.name === 'pipeline-refresh',
    )
    const inbox = workflows.find(
      command => command.name === 'inbox-triage',
    )
    const publish = workflows.find(
      command => command.name === 'publish-draft',
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

    expect(pipeline?.workflowRuntime).toBe('code')
    expect(pipeline?.capabilityGrants).toEqual([
      'discovery',
      'workspace',
      'cli',
    ])
    expect(pipeline?.artifactKinds).toContain('pipeline brief')
    expect(pipeline?.verbs).toContain('refresh pipeline')
    expect(pipeline?.workflowSteps).toHaveLength(3)

    expect(inbox?.workflowRuntime).toBe('code')
    expect(inbox?.capabilityGrants).toEqual([
      'discovery',
      'workspace',
      'cli',
    ])
    expect(inbox?.artifactKinds).toContain('response queue')
    expect(inbox?.verbs).toContain('triage inbox')
    expect(inbox?.workflowSteps).toHaveLength(3)

    expect(publish?.workflowRuntime).toBe('code')
    expect(publish?.capabilityGrants).toEqual([
      'docs',
      'discovery',
      'workspace',
    ])
    expect(publish?.artifactKinds).toContain('publishing brief')
    expect(publish?.verbs).toContain('publish draft')
    expect(publish?.workflowSteps).toHaveLength(3)
  })
})
