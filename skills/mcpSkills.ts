import { ListResourcesResultSchema } from '@modelcontextprotocol/sdk/types.js'
import uniqBy from 'lodash-es/uniqBy.js'
import type { MCPServerConnection, ServerResource } from '../services/mcp/types.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import type { Command } from '../types/command.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { memoizeWithLRU } from '../utils/memoize.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

const SKILL_URI_PREFIX = 'skill://'
const MCP_SKILL_FETCH_CACHE_SIZE = 20

type MappedServerResource = Pick<ServerResource, 'uri' | 'name'>

type TextResourceContent = {
  text: string
  mimeType?: string
}

function isSkillResource(resource: Pick<ServerResource, 'uri'>): boolean {
  return resource.uri.startsWith(SKILL_URI_PREFIX)
}

function isTextResourceContent(value: unknown): value is TextResourceContent {
  return !!value && typeof value === 'object' && typeof value.text === 'string'
}

function normalizeSkillSegments(parts: string[]): string[] {
  return parts
    .map(part => normalizeNameForMCP(decodeURIComponent(part).trim()))
    .filter(Boolean)
}

function fallbackSkillSlugFromName(name?: string): string | null {
  if (!name) return null
  const parts = normalizeSkillSegments(name.split(/[/:]/g))
  return parts.length > 0 ? parts.join(':') : null
}

function getSkillSlug(resource: MappedServerResource): string | null {
  try {
    const url = new URL(resource.uri)
    if (url.protocol !== 'skill:') {
      return fallbackSkillSlugFromName(resource.name)
    }
    const segments = normalizeSkillSegments([
      url.hostname,
      ...url.pathname.split('/').filter(Boolean),
    ])
    return segments.length > 0
      ? segments.join(':')
      : fallbackSkillSlugFromName(resource.name)
  } catch {
    return fallbackSkillSlugFromName(resource.name)
  }
}

function getResourceContents(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return []
  const contents = value.contents
  return Array.isArray(contents) ? contents : []
}

function getSkillMarkdownFromReadResult(value: unknown): string | null {
  const textBlocks = getResourceContents(value)
    .filter(isTextResourceContent)
    .map(block => block.text)
    .filter(text => text.trim().length > 0)

  if (textBlocks.length === 0) return null
  return textBlocks.join('\n\n')
}

function buildMcpSkillCommand(
  client: MCPServerConnection,
  resource: MappedServerResource,
  rawMarkdown: string,
): Command | null {
  const skillSlug = getSkillSlug(resource)
  if (!skillSlug) {
    logForDebugging(
      `[mcp-skills] Skipping ${resource.uri} from ${client.name}: unable to derive a stable skill name`,
      { level: 'warn' },
    )
    return null
  }

  const commandName = `${normalizeNameForMCP(client.name)}:${skillSlug}`
  const resourceRef = `<mcp-skill:${client.name}:${resource.uri}>`
  const { frontmatter, content: markdownContent } = parseFrontmatter(
    rawMarkdown,
    resourceRef,
  )
  const { createSkillCommand, parseSkillFrontmatterFields } =
    getMCPSkillBuilders()
  const parsed = parseSkillFrontmatterFields(
    frontmatter,
    markdownContent,
    commandName,
  )

  return createSkillCommand({
    ...parsed,
    skillName: commandName,
    displayName: parsed.displayName ?? resource.name ?? undefined,
    markdownContent,
    source: 'mcp',
    baseDir: undefined,
    loadedFrom: 'mcp',
    paths: undefined,
  })
}

export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected' || !client.capabilities?.resources) {
      return []
    }

    try {
      const result = await client.client.request(
        { method: 'resources/list' },
        ListResourcesResultSchema,
      )
      const skillResources = (result.resources ?? []).filter(isSkillResource)

      if (skillResources.length === 0) {
        return []
      }

      const commands = await Promise.all(
        skillResources.map(async resource => {
          try {
            const readResult = await client.client.readResource({
              uri: resource.uri,
            })
            const markdown = getSkillMarkdownFromReadResult(readResult)
            if (!markdown) {
              logForDebugging(
                `[mcp-skills] Skipping ${resource.uri} from ${client.name}: resource did not contain text skill content`,
                { level: 'warn' },
              )
              return null
            }
            return buildMcpSkillCommand(client, resource, markdown)
          } catch (error) {
            logForDebugging(
              `[mcp-skills] Failed to load ${resource.uri} from ${client.name}: ${errorMessage(error)}`,
              { level: 'warn' },
            )
            return null
          }
        }),
      )

      return uniqBy(
        commands.filter((command): command is Command => command !== null),
        'name',
      )
    } catch (error) {
      logForDebugging(
        `[mcp-skills] Failed to list skill resources for ${client.name}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_SKILL_FETCH_CACHE_SIZE,
)
