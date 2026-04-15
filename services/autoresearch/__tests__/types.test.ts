import { describe, it, expect } from 'bun:test'
import { ClaudeCodeSessionObservationSchema } from '../types.js'

describe('ClaudeCodeSessionObservationSchema', () => {
  it('accepts cost fields when present', () => {
    const input = {
      id: 'abc123',
      sessionId: 'sess-1',
      eventType: 'session_end',
      transcriptPath: '/tmp/transcript.json',
      cwd: '/tmp',
      success: true,
      actualRegression: false,
      heuristicConfidence: 0.55,
      failureTags: [],
      source: 'claude_code_session_end_hook',
      recordedAt: '2026-04-15T00:00:00Z',
      tokenCost: 0.042,
      runtimeMs: 12345,
      toolCallCount: 37,
    }
    const result = ClaudeCodeSessionObservationSchema().parse(input)
    expect(result.tokenCost).toBe(0.042)
    expect(result.runtimeMs).toBe(12345)
    expect(result.toolCallCount).toBe(37)
  })

  it('defaults cost fields to undefined when absent', () => {
    const input = {
      id: 'abc456',
      sessionId: 'sess-2',
      eventType: 'session_end',
      transcriptPath: '/tmp/transcript.json',
      cwd: '/tmp',
      success: true,
      actualRegression: false,
      heuristicConfidence: 0.55,
      failureTags: [],
      source: 'claude_code_session_end_hook',
      recordedAt: '2026-04-15T00:00:00Z',
    }
    const result = ClaudeCodeSessionObservationSchema().parse(input)
    expect(result.tokenCost).toBeUndefined()
    expect(result.runtimeMs).toBeUndefined()
    expect(result.toolCallCount).toBeUndefined()
  })

  it('rejects negative cost values', () => {
    const base = {
      id: 'abc789',
      sessionId: 'sess-3',
      eventType: 'session_end',
      transcriptPath: '/tmp/transcript.json',
      cwd: '/tmp',
      success: true,
      actualRegression: false,
      heuristicConfidence: 0.55,
      failureTags: [],
      source: 'claude_code_session_end_hook',
      recordedAt: '2026-04-15T00:00:00Z',
    }

    expect(() => ClaudeCodeSessionObservationSchema().parse({ ...base, tokenCost: -1 })).toThrow()
    expect(() => ClaudeCodeSessionObservationSchema().parse({ ...base, runtimeMs: -100 })).toThrow()
    expect(() => ClaudeCodeSessionObservationSchema().parse({ ...base, toolCallCount: -5 })).toThrow()
  })
})
