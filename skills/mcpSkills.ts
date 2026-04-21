import { ListResourcesResultSchema } from '@modelcontextprotocol/sdk/types.js'
import uniqBy from 'lodash-es/uniqBy.js'
import type { MCPServerConnection, ServerResource } from '../services/mcp/types.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import type { Command } from '../types/command.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { memoizeWithLRU } from '../utils/memoize.js'
import { decorateWorkflowPromptCommand } from '../utils/workflowCommands.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

const SKILL_URI_PREFIX = 'skill://'
const WORKFLOW_URI_PREFIX = 'workflow://'
const MCP_SKILL_FETCH_CACHE_SIZE = 20

type MappedServerResource = Pick<ServerResource, 'uri' | 'name'>

type TextResourceContent = {
  text: string
  mimeType?: string
}

type McpResourceCommandKind = 'skill' | 'workflow'

type McpResourceCommandConfig = {
  kind: McpResourceCommandKind
  uriPrefix: string
  uriProtocol: string
  commandPrefix: string
  descriptionFallbackLabel: 'Skill' | 'Custom command'
}

function hasResourcePrefix(
  resource: Pick<ServerResource, 'uri'>,
  prefix: string,
): boolean {
  return resource.uri.startsWith(prefix)
}

function isTextResourceContent(value: unknown): value is TextResourceContent {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { text?: unknown }).text === 'string'
  )
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

function getResourceSlug(
  resource: MappedServerResource,
  expectedProtocol: string,
): string | null {
  try {
    const url = new URL(resource.uri)
    if (url.protocol !== expectedProtocol) {
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
  const contents = (value as { contents?: unknown }).contents
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

function buildMcpResourceCommand(
  client: MCPServerConnection,
  resource: MappedServerResource,
  rawMarkdown: string,
  config: McpResourceCommandConfig,
): Command | null {
  const skillSlug = getResourceSlug(resource, config.uriProtocol)
  if (!skillSlug) {
    logForDebugging(
      `[mcp-${config.kind}s] Skipping ${resource.uri} from ${client.name}: unable to derive a stable ${config.kind} name`,
      { level: 'warn' },
    )
    return null
  }

  const commandName = `${normalizeNameForMCP(client.name)}:${config.commandPrefix}${skillSlug}`
  const resourceRef = `<mcp-${config.kind}:${client.name}:${resource.uri}>`
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
    config.descriptionFallbackLabel,
  )

  const command = createSkillCommand({
    ...parsed,
    skillName: commandName,
    displayName: parsed.displayName ?? resource.name ?? undefined,
    markdownContent,
    source: 'mcp',
    baseDir: undefined,
    loadedFrom: 'mcp',
    paths: undefined,
  })

  if (config.kind === 'workflow') {
    return decorateWorkflowPromptCommand({
      ...command,
      kind: 'workflow',
      context: (command as { context?: string }).context ?? 'fork',
      progressMessage: 'running workflow',
    } as never)
  }

  return command
}

function createMcpResourceCommandFetcher(config: McpResourceCommandConfig) {
  return memoizeWithLRU(
    async (client: MCPServerConnection): Promise<Command[]> => {
      if (client.type !== 'connected' || !client.capabilities?.resources) {
        return []
      }

      try {
        const result = await client.client.request(
          { method: 'resources/list' },
          ListResourcesResultSchema,
        )
        const matchingResources = (result.resources ?? []).filter(resource =>
          hasResourcePrefix(resource, config.uriPrefix),
        )

        if (matchingResources.length === 0) {
          return []
        }

        const commands = await Promise.all(
          matchingResources.map(async resource => {
            try {
              const readResult = await client.client.readResource({
                uri: resource.uri,
              })
              const markdown = getSkillMarkdownFromReadResult(readResult)
              if (!markdown) {
                logForDebugging(
                  `[mcp-${config.kind}s] Skipping ${resource.uri} from ${client.name}: resource did not contain text ${config.kind} content`,
                  { level: 'warn' },
                )
                return null
              }
              return buildMcpResourceCommand(client, resource, markdown, config)
            } catch (error) {
              logForDebugging(
                `[mcp-${config.kind}s] Failed to load ${resource.uri} from ${client.name}: ${errorMessage(error)}`,
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
          `[mcp-${config.kind}s] Failed to list ${config.kind} resources for ${client.name}: ${errorMessage(error)}`,
          { level: 'warn' },
        )
        return []
      }
    },
    (client: MCPServerConnection) => client.name,
    MCP_SKILL_FETCH_CACHE_SIZE,
  )
}

export const fetchMcpSkillsForClient = createMcpResourceCommandFetcher({
  kind: 'skill',
  uriPrefix: SKILL_URI_PREFIX,
  uriProtocol: 'skill:',
  commandPrefix: '',
  descriptionFallbackLabel: 'Skill',
})

export const fetchMcpWorkflowsForClient = createMcpResourceCommandFetcher({
  kind: 'workflow',
  uriPrefix: WORKFLOW_URI_PREFIX,
  uriProtocol: 'workflow:',
  commandPrefix: 'workflow:',
  descriptionFallbackLabel: 'Custom command',
})
