import type { createClaudeForChromeMcpServer } from '@ant/claude-for-chrome-mcp'
import { createRequire } from 'module'
import { logForDebugging } from '../debug.js'

type BrowserTool = {
  name: string
}

type ClaudeInChromeMcpModule = {
  BROWSER_TOOLS: BrowserTool[]
  createClaudeForChromeMcpServer: typeof createClaudeForChromeMcpServer
}

const require = createRequire(import.meta.url)
let cachedClaudeInChromeMcpModule: ClaudeInChromeMcpModule | null | undefined

function loadClaudeInChromeMcpModule(): ClaudeInChromeMcpModule | null {
  if (cachedClaudeInChromeMcpModule !== undefined) {
    return cachedClaudeInChromeMcpModule
  }

  try {
    cachedClaudeInChromeMcpModule = require(
      '@ant/claude-for-chrome-mcp',
    ) as ClaudeInChromeMcpModule
  } catch (error) {
    logForDebugging(
      `[Claude in Chrome] optional runtime unavailable: ${String(error)}`,
    )
    cachedClaudeInChromeMcpModule = null
  }

  return cachedClaudeInChromeMcpModule
}

export function getBrowserTools(): BrowserTool[] {
  return loadClaudeInChromeMcpModule()?.BROWSER_TOOLS ?? []
}

export function isClaudeInChromeMcpAvailable(): boolean {
  return loadClaudeInChromeMcpModule() !== null
}

export function requireClaudeInChromeMcpModule(): ClaudeInChromeMcpModule {
  const module = loadClaudeInChromeMcpModule()
  if (module) {
    return module
  }

  throw new Error(
    'Claude in Chrome requires the optional @ant/claude-for-chrome-mcp package to be installed.',
  )
}
