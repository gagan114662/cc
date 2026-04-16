import type {
  ClaudeForChromeContext,
  Logger,
  PermissionMode,
} from '@ant/claude-for-chrome-mcp'

export type BrowserToolDefinition = {
  name: string
}

export type ClaudeForChromeMcpModule = {
  BROWSER_TOOLS: BrowserToolDefinition[]
  createClaudeForChromeMcpServer: (
    context: ClaudeForChromeContext,
  ) => {
    connect: (...connectArgs: unknown[]) => Promise<void>
  }
}

const FALLBACK_BROWSER_TOOLS: BrowserToolDefinition[] = [
  { name: 'javascript_tool' },
  { name: 'read_page' },
  { name: 'find' },
  { name: 'form_input' },
  { name: 'computer' },
  { name: 'navigate' },
  { name: 'resize_window' },
  { name: 'gif_creator' },
  { name: 'upload_image' },
  { name: 'get_page_text' },
  { name: 'tabs_context_mcp' },
  { name: 'tabs_create_mcp' },
  { name: 'update_plan' },
  { name: 'read_console_messages' },
  { name: 'read_network_requests' },
  { name: 'shortcuts_list' },
  { name: 'shortcuts_execute' },
]

function isMissingModuleError(
  error: unknown,
  specifier: string,
): boolean {
  return String(error).includes(`Cannot find module '${specifier}'`)
}

export function loadClaudeForChromeMcpModule(): ClaudeForChromeMcpModule | null {
  try {
    return require('@ant/claude-for-chrome-mcp') as ClaudeForChromeMcpModule
  } catch (error) {
    if (isMissingModuleError(error, '@ant/claude-for-chrome-mcp')) {
      return null
    }
    throw error
  }
}

export function isClaudeForChromeMcpAvailable(): boolean {
  return loadClaudeForChromeMcpModule() !== null
}

export function getBrowserTools(): BrowserToolDefinition[] {
  return loadClaudeForChromeMcpModule()?.BROWSER_TOOLS ?? FALLBACK_BROWSER_TOOLS
}

export function createClaudeForChromeUnavailableError(): Error {
  return new Error(
    'Claude in Chrome requires the optional @ant/claude-for-chrome-mcp package in this runtime.',
  )
}

export type {
  ClaudeForChromeContext,
  Logger,
  PermissionMode,
}
