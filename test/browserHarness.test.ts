import { describe, expect, test } from 'bun:test'
import {
  BROWSER_HARNESS_INSTALL_SNIPPET,
  BROWSER_HARNESS_REFERENCE_FILES,
  browserHarnessRemoteConfiguredFromSources,
  buildBrowserFunnelAuditWorkflowPrompt,
  buildBrowserHarnessSkillPrompt,
} from 'src/utils/browserHarness.js'

describe('browserHarnessRemoteConfiguredFromSources', () => {
  test('treats runtime BROWSER_USE_API_KEY as remote ready', () => {
    expect(
      browserHarnessRemoteConfiguredFromSources(
        { BROWSER_USE_API_KEY: 'live-key' },
        {},
      ),
    ).toBe(true)
  })

  test('falls back to config env when runtime env is empty', () => {
    expect(
      browserHarnessRemoteConfiguredFromSources(
        { BROWSER_USE_API_KEY: '' },
        { BROWSER_USE_API_KEY: 'persisted-key' },
      ),
    ).toBe(true)
  })

  test('returns false when no API key is configured anywhere', () => {
    expect(browserHarnessRemoteConfiguredFromSources({}, {})).toBe(false)
  })
})

describe('browser harness bundled prompt', () => {
  test('includes the install fallback and new_tab guidance', () => {
    const prompt = buildBrowserHarnessSkillPrompt('Capture a screenshot')
    expect(prompt).toContain('browser-harness')
    expect(prompt).toContain('new_tab(url)')
    expect(prompt).toContain('install.md')
    expect(prompt).toContain('Capture a screenshot')
  })

  test('ships the reference files needed for setup and helper lookup', () => {
    expect(BROWSER_HARNESS_REFERENCE_FILES['install.md']).toContain(
      BROWSER_HARNESS_INSTALL_SNIPPET,
    )
    expect(BROWSER_HARNESS_REFERENCE_FILES['usage.md']).toContain(
      'new_tab(url)',
    )
    expect(BROWSER_HARNESS_REFERENCE_FILES['helpers-reference.md']).toContain(
      'upload_file(selector, path)',
    )
  })

  test('builds a browser-backed workflow prompt for funnel audits', () => {
    const prompt = buildBrowserFunnelAuditWorkflowPrompt(
      'Audit https://example.com signup flow',
    )
    expect(prompt).toContain('browser-harness')
    expect(prompt).toContain('Audit https://example.com signup flow')
    expect(prompt).toContain('Workflow deliverable requirements')
    expect(prompt).toContain('top friction points')
  })
})
