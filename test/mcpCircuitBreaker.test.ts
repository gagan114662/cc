// Pins the state-machine for the per-server MCP circuit breaker.
// A hung MCP server must not keep eating duty timeouts — after N
// consecutive failures the breaker opens and calls fail instantly
// with MCPCircuitOpenError until the cooldown elapses, then one
// probe is allowed through (half-open).

import { describe, expect, test } from 'bun:test'
import {
  MCPCircuitOpenError,
  MCPCircuitRegistry,
} from 'src/services/mcp/circuitBreaker.js'

function makeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs
  return {
    now: () => current,
    advance: ms => {
      current += ms
    },
  }
}

describe('MCPCircuitRegistry', () => {
  test('starts closed and allows calls', async () => {
    const reg = new MCPCircuitRegistry()
    expect(reg.getState('srv')).toBe('closed')
    const result = await reg.run('srv', async () => 42)
    expect(result).toBe(42)
    expect(reg.getState('srv')).toBe('closed')
  })

  test('opens after failureThreshold consecutive failures', async () => {
    const reg = new MCPCircuitRegistry({ failureThreshold: 3, cooldownMs: 1000 })
    for (let i = 0; i < 3; i++) {
      try {
        await reg.run('srv', async () => {
          throw new Error('boom')
        })
      } catch {
        /* expected */
      }
    }
    expect(reg.getState('srv')).toBe('open')
  })

  test('open breaker rejects calls with MCPCircuitOpenError', async () => {
    const reg = new MCPCircuitRegistry({ failureThreshold: 1, cooldownMs: 1000 })
    try {
      await reg.run('srv', async () => {
        throw new Error('boom')
      })
    } catch {
      /* expected */
    }
    expect(reg.getState('srv')).toBe('open')

    let caught: unknown
    try {
      await reg.run('srv', async () => 'ok')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(MCPCircuitOpenError)
  })

  test('transitions to half-open after cooldown elapses', async () => {
    const clock = makeClock(1000)
    const reg = new MCPCircuitRegistry({
      failureThreshold: 1,
      cooldownMs: 500,
      now: clock.now,
    })

    // Trip the breaker.
    try {
      await reg.run('srv', async () => {
        throw new Error('boom')
      })
    } catch {
      /* expected */
    }
    expect(reg.getState('srv')).toBe('open')

    // Before cooldown — still rejects instantly.
    let caught: unknown
    try {
      reg.guard('srv')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(MCPCircuitOpenError)

    // After cooldown — guard() flips to half-open and returns.
    clock.advance(600)
    reg.guard('srv')
    expect(reg.getState('srv')).toBe('half-open')
  })

  test('half-open closes on success and re-opens on failure', async () => {
    const clock = makeClock(0)
    const reg = new MCPCircuitRegistry({
      failureThreshold: 1,
      cooldownMs: 100,
      now: clock.now,
    })

    // Trip, then wait for cooldown.
    try {
      await reg.run('srv', async () => {
        throw new Error('boom')
      })
    } catch {
      /* expected */
    }
    clock.advance(150)

    // Half-open probe succeeds → closed.
    await reg.run('srv', async () => 'ok')
    expect(reg.getState('srv')).toBe('closed')

    // Trip again, wait for cooldown.
    try {
      await reg.run('srv', async () => {
        throw new Error('boom')
      })
    } catch {
      /* expected */
    }
    clock.advance(150)

    // Half-open probe fails → back to open.
    try {
      await reg.run('srv', async () => {
        throw new Error('still broken')
      })
    } catch {
      /* expected */
    }
    expect(reg.getState('srv')).toBe('open')
  })

  test('breakers are keyed per-server and do not cross-trip', async () => {
    const reg = new MCPCircuitRegistry({ failureThreshold: 1, cooldownMs: 1000 })
    try {
      await reg.run('broken-srv', async () => {
        throw new Error('boom')
      })
    } catch {
      /* expected */
    }
    expect(reg.getState('broken-srv')).toBe('open')
    expect(reg.getState('healthy-srv')).toBe('closed')

    // Healthy server still serves calls.
    const result = await reg.run('healthy-srv', async () => 'ok')
    expect(result).toBe('ok')
  })

  test('recordSuccess mid-run resets consecutiveFailures', async () => {
    const reg = new MCPCircuitRegistry({ failureThreshold: 3, cooldownMs: 1000 })
    // Two failures, then a success → counter resets.
    for (let i = 0; i < 2; i++) {
      try {
        await reg.run('srv', async () => {
          throw new Error('boom')
        })
      } catch {
        /* expected */
      }
    }
    await reg.run('srv', async () => 'ok')
    expect(reg.getState('srv')).toBe('closed')

    // Now two more failures should still leave it closed (counter reset,
    // threshold is 3).
    for (let i = 0; i < 2; i++) {
      try {
        await reg.run('srv', async () => {
          throw new Error('boom')
        })
      } catch {
        /* expected */
      }
    }
    expect(reg.getState('srv')).toBe('closed')
  })
})
