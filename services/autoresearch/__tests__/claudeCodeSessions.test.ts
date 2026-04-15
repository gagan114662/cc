import { describe, it, expect } from 'bun:test'
import { classifyClaudeCodeSessionObservation } from '../claudeCodeSessions.js'

describe('classifyClaudeCodeSessionObservation', () => {
  it('includes cost fields when provided', () => {
    const result = classifyClaudeCodeSessionObservation({
      sessionId: 'sess-cost-1',
      eventType: 'session_end',
      transcriptPath: '/tmp/t.json',
      cwd: '/tmp',
      summary: 'Session completed successfully',
      recordedAt: '2026-04-15T12:00:00Z',
      tokenCost: 0.15,
      runtimeMs: 30000,
      toolCallCount: 42,
    })
    expect(result.tokenCost).toBe(0.15)
    expect(result.runtimeMs).toBe(30000)
    expect(result.toolCallCount).toBe(42)
  })

  it('omits cost fields when not provided', () => {
    const result = classifyClaudeCodeSessionObservation({
      sessionId: 'sess-cost-2',
      eventType: 'session_end',
      transcriptPath: '/tmp/t.json',
      cwd: '/tmp',
      summary: 'Session completed',
      recordedAt: '2026-04-15T12:00:00Z',
    })
    expect(result.tokenCost).toBeUndefined()
    expect(result.runtimeMs).toBeUndefined()
    expect(result.toolCallCount).toBeUndefined()
  })
})
