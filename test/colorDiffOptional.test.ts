// test-intent: proves structured diff rendering degrades safely when the optional native color module is unavailable.
// test-spec: specs/runtime-fallbacks.md#color-diff-optional-runtime
import { describe, expect, test } from 'bun:test'
import {
  expectColorDiff,
  expectColorFile,
  getColorModuleUnavailableReason,
  getSyntaxTheme,
} from '../components/StructuredDiff/colorDiff.js'

describe('colorDiff optional native dependency', () => {
  test('gracefully reports missing native module', () => {
    expect(['module', null]).toContain(getColorModuleUnavailableReason())
  })

  test('returns null exports when the native module is unavailable', () => {
    if (getColorModuleUnavailableReason() !== 'module') {
      expect(expectColorDiff()).not.toBeNull()
      expect(expectColorFile()).not.toBeNull()
      return
    }

    expect(expectColorDiff()).toBeNull()
    expect(expectColorFile()).toBeNull()
    expect(getSyntaxTheme('github-light')).toBeNull()
  })
})
