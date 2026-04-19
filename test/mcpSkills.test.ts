import { beforeEach, describe, expect, test } from 'bun:test'
import 'src/skills/loadSkillsDir.js'
import {
  fetchMcpSkillsForClient,
  fetchMcpWorkflowsForClient,
} from 'src/skills/mcpSkills.js'

type ResourceShape = {
  uri: string
  name?: string
}

function makeConnectedClient(options?: {
  name?: string
  resources?: ResourceShape[]
  readResults?: Record<string, unknown>
}) {
  let requestCount = 0
  let readCount = 0
  const resources = options?.resources ?? []
  const readResults = options?.readResults ?? {}

  const client = {
    type: 'connected',
    name: options?.name ?? 'browser harness',
    capabilities: { resources: {} },
    client: {
      async request() {
        requestCount += 1
        return { resources }
      },
      async readResource({ uri }: { uri: string }) {
        readCount += 1
        return readResults[uri]
      },
    },
    config: { type: 'stdio', command: 'noop', args: [], scope: 'local' },
    cleanup: async () => undefined,
  } as const

  return {
    client: client as any,
    counts() {
      return { requestCount, readCount }
    },
  }
}

beforeEach(() => {
  fetchMcpSkillsForClient.cache.clear()
  fetchMcpWorkflowsForClient.cache.clear()
})

describe('fetchMcpSkillsForClient', () => {
  test('turns skill:// text resources into MCP-loaded skills', async () => {
    const { client } = makeConnectedClient({
      name: 'browser harness',
      resources: [
        {
          uri: 'skill://growth/outbound-audit',
          name: 'Outbound Audit',
        },
      ],
      readResults: {
        'skill://growth/outbound-audit': {
          contents: [
            {
              text: `---
name: Outbound Audit
description: Find funnel gaps
allowed-tools:
  - Read
---
# Audit the current funnel
Use the public surface and identify the biggest GTM gaps.`,
            },
          ],
        },
      },
    })

    const skills = await fetchMcpSkillsForClient(client)

    expect(skills).toHaveLength(1)
    const skill = skills[0]!
    expect(skill.name).toBe('browser_harness:growth:outbound-audit')
    expect(skill.source).toBe('mcp')
    expect(skill.loadedFrom).toBe('mcp')
    expect(skill.userFacingName?.()).toBe('Outbound Audit')

    const prompt = await skill.getPromptForCommand('', {} as any)
    expect(prompt).toHaveLength(1)
    expect(prompt[0]).toMatchObject({
      type: 'text',
    })
    expect((prompt[0] as { text: string }).text).toContain(
      '# Audit the current funnel',
    )
    expect((prompt[0] as { text: string }).text).not.toContain('allowed-tools')
  })

  test('skips non-skill and non-text resources', async () => {
    const { client } = makeConnectedClient({
      resources: [
        { uri: 'file://workspace/readme.md', name: 'README' },
        { uri: 'skill://ops/binary-runbook', name: 'Binary Runbook' },
      ],
      readResults: {
        'skill://ops/binary-runbook': {
          contents: [
            {
              blob: 'ZGF0YQ==',
              mimeType: 'application/octet-stream',
            },
          ],
        },
      },
    })

    const skills = await fetchMcpSkillsForClient(client)

    expect(skills).toEqual([])
  })

  test('caches by server name and supports explicit invalidation', async () => {
    const { client, counts } = makeConnectedClient({
      resources: [{ uri: 'skill://ops/triage', name: 'Triage' }],
      readResults: {
        'skill://ops/triage': {
          contents: [{ text: '# Triage the inbox' }],
        },
      },
    })

    await fetchMcpSkillsForClient(client)
    await fetchMcpSkillsForClient(client)
    expect(counts()).toEqual({ requestCount: 1, readCount: 1 })

    fetchMcpSkillsForClient.cache.delete(client.name)
    await fetchMcpSkillsForClient(client)
    expect(counts()).toEqual({ requestCount: 2, readCount: 2 })
  })
})

describe('fetchMcpWorkflowsForClient', () => {
  test('turns workflow:// text resources into MCP-loaded workflow commands', async () => {
    const { client } = makeConnectedClient({
      name: 'browser harness',
      resources: [
        {
          uri: 'workflow://growth/pipeline-refresh',
          name: 'Pipeline Refresh',
        },
      ],
      readResults: {
        'workflow://growth/pipeline-refresh': {
          contents: [
            {
              text: `---
name: Pipeline Refresh
description: Rebuild the pipeline from the current public surface
context: fork
workflow_runtime: code
when_to_use: Refresh the growth plan after market, messaging, or demand changes
verbs:
  - refresh pipeline
  - prioritize outreach
inputs:
  - Website and public positioning
  - Current ICP assumptions
outputs:
  - Updated pipeline brief
  - Prioritized outreach backlog
artifact_kinds:
  - pipeline brief
  - outreach backlog
success_criteria:
  - Identifies stale assumptions
  - Produces the next highest-leverage actions
handoff_fields:
  - stale_assumptions
  - priority_segment
steps:
  - title: Gather evidence
    objective: Review the website and current positioning assumptions
    success: You have a current fact base for the pipeline refresh
    tools:
      - Read
    retries: 1
  - title: Rebuild the backlog
    objective: Turn the refreshed view into concrete GTM actions
    success: The backlog is prioritized and ready to execute
    tools:
      - Read
    on_failure: continue
    requires_handoff:
      - priority_segment
arguments:
  - segment
allowed-tools:
  - Read
---
# Refresh the pipeline
Review the current state, identify stale assumptions, and return the next
highest-leverage GTM actions.`,
            },
          ],
        },
      },
    })

    const workflows = await fetchMcpWorkflowsForClient(client)

    expect(workflows).toHaveLength(1)
    const workflow = workflows[0]!
    expect(workflow.name).toBe('browser_harness:workflow:growth:pipeline-refresh')
    expect(workflow.kind).toBe('workflow')
    expect(workflow.source).toBe('mcp')
    expect(workflow.loadedFrom).toBe('mcp')
    expect(workflow.userFacingName?.()).toBe('Pipeline Refresh')
    expect(workflow.context).toBe('fork')
    expect(workflow.workflowRuntime).toBe('code')
    expect(workflow.progressMessage).toBe('running workflow')
    expect(workflow.verbs).toEqual([
      'refresh pipeline',
      'prioritize outreach',
    ])
    expect(workflow.inputs).toEqual([
      'Website and public positioning',
      'Current ICP assumptions',
    ])
    expect(workflow.outputs).toEqual([
      'Updated pipeline brief',
      'Prioritized outreach backlog',
    ])
    expect(workflow.artifactKinds).toEqual([
      'pipeline brief',
      'outreach backlog',
    ])
    expect(workflow.successCriteria).toEqual([
      'Identifies stale assumptions',
      'Produces the next highest-leverage actions',
    ])
    expect(workflow.handoffFields).toEqual([
      'stale_assumptions',
      'priority_segment',
    ])
    expect(workflow.workflowSteps).toEqual([
      {
        title: 'Gather evidence',
        objective: 'Review the website and current positioning assumptions',
        success: 'You have a current fact base for the pipeline refresh',
        tools: ['Read'],
        retryCount: 1,
      },
      {
        title: 'Rebuild the backlog',
        objective: 'Turn the refreshed view into concrete GTM actions',
        success: 'The backlog is prioritized and ready to execute',
        tools: ['Read'],
        onFailure: 'continue',
        requiresHandoff: ['priority_segment'],
      },
    ])
    expect(workflow.argNames).toEqual(['segment'])

    const prompt = await workflow.getPromptForCommand('', {} as any)
    expect(prompt).toHaveLength(2)
    expect(prompt[0]).toMatchObject({ type: 'text' })
    expect((prompt[0] as { text: string }).text).toContain('Workflow contract:')
    expect((prompt[0] as { text: string }).text).toContain(
      'Operations: refresh pipeline, prioritize outreach',
    )
    expect((prompt[0] as { text: string }).text).toContain(
      'Expected outputs: Updated pipeline brief, Prioritized outreach backlog',
    )
    expect((prompt[0] as { text: string }).text).toContain(
      'Artifact kinds: pipeline brief, outreach backlog',
    )
    expect((prompt[0] as { text: string }).text).toContain(
      'Success criteria: Identifies stale assumptions, Produces the next highest-leverage actions',
    )
    expect((prompt[0] as { text: string }).text).toContain(
      'Structured handoff: stale_assumptions, priority_segment',
    )
    expect((prompt[0] as { text: string }).text).toContain('Procedure:')
    expect((prompt[0] as { text: string }).text).toContain('1. Gather evidence')
    expect((prompt[0] as { text: string }).text).toContain(
      '2. Rebuild the backlog',
    )
    expect((prompt[0] as { text: string }).text).toContain(
      'Arguments: segment',
    )
    expect((prompt[0] as { text: string }).text).toContain(
      'Recommended tools: Read',
    )
    expect(prompt[1]).toMatchObject({ type: 'text' })
    expect((prompt[1] as { text: string }).text).toContain(
      '# Refresh the pipeline',
    )
    expect((prompt[1] as { text: string }).text).not.toContain('allowed-tools')
  })

  test('caches workflow resources by server name and supports invalidation', async () => {
    const { client, counts } = makeConnectedClient({
      resources: [{ uri: 'workflow://ops/site-refresh', name: 'Site Refresh' }],
      readResults: {
        'workflow://ops/site-refresh': {
          contents: [{ text: '# Refresh the public site backlog' }],
        },
      },
    })

    await fetchMcpWorkflowsForClient(client)
    await fetchMcpWorkflowsForClient(client)
    expect(counts()).toEqual({ requestCount: 1, readCount: 1 })

    fetchMcpWorkflowsForClient.cache.delete(client.name)
    await fetchMcpWorkflowsForClient(client)
    expect(counts()).toEqual({ requestCount: 2, readCount: 2 })
  })

  test('defaults MCP workflows to forked execution when context is not specified', async () => {
    const { client } = makeConnectedClient({
      resources: [
        { uri: 'workflow://ops/site-refresh', name: 'Site Refresh' },
      ],
      readResults: {
        'workflow://ops/site-refresh': {
          contents: [
            {
              text: `---
name: Site Refresh
description: Refresh the site backlog
---
# Refresh the site`,
            },
          ],
        },
      },
    })

    const workflows = await fetchMcpWorkflowsForClient(client)
    expect(workflows).toHaveLength(1)
    expect(workflows[0]?.context).toBe('fork')
  })
})
