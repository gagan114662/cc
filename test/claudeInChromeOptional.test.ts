// test-intent: proves Chrome integration falls back safely when the optional MCP package is unavailable.
// test-spec: specs/runtime-fallbacks.md#chrome-optional-runtime
import { describe, expect, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import {
  createClaudeForChromeUnavailableError,
  getBrowserTools,
  isClaudeForChromeMcpAvailable,
  loadClaudeForChromeMcpModule,
} from '../utils/claudeInChrome/optional.js'
import {
  setupClaudeInChrome,
  shouldEnableClaudeInChrome,
  shouldAutoEnableClaudeInChrome,
} from '../utils/claudeInChrome/setup.js'

describe('claudeInChrome optional runtime', () => {
  test('provides fallback browser tools when the external package is unavailable', () => {
    const tools = getBrowserTools()

    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some(tool => tool.name === 'tabs_context_mcp')).toBe(true)
  })

  test('does not auto-enable chrome integration when the external package is unavailable', () => {
    if (isClaudeForChromeMcpAvailable()) {
      expect(shouldAutoEnableClaudeInChrome()).toBeTypeOf('boolean')
      return
    }

    expect(shouldAutoEnableClaudeInChrome()).toBe(false)
  })

  test('honors an explicit false chrome flag without consulting optional runtime state', () => {
    const previousInteractive = getIsInteractive()
    setIsInteractive(true)

    try {
      expect(shouldEnableClaudeInChrome(false)).toBe(false)
    } finally {
      setIsInteractive(previousInteractive)
    }
  })

  test('throws a clear error when chrome setup is requested without the optional package', () => {
    if (isClaudeForChromeMcpAvailable()) {
      expect(typeof setupClaudeInChrome).toBe('function')
      return
    }

    expect(() => setupClaudeInChrome()).toThrow(
      createClaudeForChromeUnavailableError().message,
    )
  })

  test('returns null from the optional module loader when the package is absent', () => {
    if (isClaudeForChromeMcpAvailable()) {
      expect(loadClaudeForChromeMcpModule()).not.toBeNull()
      return
    }

    expect(loadClaudeForChromeMcpModule()).toBeNull()
  })
})
