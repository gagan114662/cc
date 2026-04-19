import { beforeEach, describe, expect, test } from 'bun:test'
import 'src/skills/loadSkillsDir.js'
import { fetchMcpSkillsForClient } from 'src/skills/mcpSkills.js'

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
