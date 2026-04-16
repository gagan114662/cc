// test-intent: proves repl bridge state changes remain externally observable across the bootstrap state helpers.
// test-spec: specs/runtime-fallbacks.md#repl-bridge-state
import { describe, expect, test } from 'bun:test'
import {
  isReplBridgeActive,
  setReplBridgeActive,
} from '../bootstrap/state.js'

describe('bootstrap state repl bridge', () => {
  test('defaults repl bridge state to inactive', () => {
    expect(isReplBridgeActive()).toBe(false)
  })

  test('stores active repl bridge state', () => {
    const initial = isReplBridgeActive()

    try {
      setReplBridgeActive(true)
      expect(isReplBridgeActive()).toBe(true)
    } finally {
      setReplBridgeActive(initial)
    }
  })

  test('stores inactive repl bridge state', () => {
    const initial = isReplBridgeActive()

    try {
      setReplBridgeActive(false)
      expect(isReplBridgeActive()).toBe(false)
    } finally {
      setReplBridgeActive(initial)
    }
  })
})
