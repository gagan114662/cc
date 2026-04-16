// test-intent: proves sandbox helpers expose safe fallback state when the optional sandbox runtime is absent.
// test-spec: specs/runtime-fallbacks.md#sandbox-optional-runtime
import { describe, expect, test } from 'bun:test'
import { SandboxManager } from '../utils/sandbox/sandbox-adapter.js'

describe('sandbox adapter optional runtime', () => {
  test('exposes safe fallback dependency checks and configs', () => {
    const deps = SandboxManager.checkDependencies()
    const violationStore = SandboxManager.getSandboxViolationStore()

    expect(Array.isArray(deps.errors)).toBe(true)
    expect(SandboxManager.getFsReadConfig()).toEqual({
      denyOnly: [],
      allowWithinDeny: [],
    })
    expect(SandboxManager.getFsWriteConfig()).toEqual({
      allowOnly: [],
      denyWithinAllow: [],
    })
    expect(SandboxManager.getNetworkRestrictionConfig()).toEqual({
      allowedHosts: [],
      deniedHosts: [],
    })
    expect(typeof violationStore.subscribe).toBe('function')
  })

  test('notifies subscribers immediately with current fallback violations', () => {
    const violationStore = SandboxManager.getSandboxViolationStore()
    const snapshots: unknown[] = []

    const unsubscribe = violationStore.subscribe(violations => {
      snapshots.push(violations)
    })
    unsubscribe()

    expect(snapshots.length).toBeGreaterThan(0)
    expect(Array.isArray(snapshots[0])).toBe(true)
    expect(violationStore.getTotalCount()).toBe(0)
  })
})
