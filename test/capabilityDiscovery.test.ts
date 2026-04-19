import { describe, expect, test } from 'bun:test'
import type { Command } from 'src/commands.js'
import {
  rankCapabilities,
  rankCapabilityNames,
} from 'src/utils/capabilityDiscovery.js'

function makePromptCommand(overrides: Partial<Command> & Pick<Command, 'name'>): Command {
  return {
    type: 'prompt',
    name: overrides.name,
    description: overrides.description ?? 'Generic capability',
    contentLength: 0,
    progressMessage: 'running',
    source: overrides.source ?? 'bundled',
    loadedFrom: overrides.loadedFrom ?? 'bundled',
    async getPromptForCommand() {
      return [{ type: 'text', text: '# capability' }]
    },
    ...overrides,
  } as Command
}

describe('capability discovery', () => {
  test('prioritizes browser executors for browser-heavy tasks', () => {
    const browserHarness = makePromptCommand({
      name: 'browser-harness',
      description:
        'Drive browser automation, scraping, screenshots, and logged-in web workflows',
      whenToUse:
        'Use when browser work, screenshots, forms, or website automation is needed',
      loadedFrom: 'bundled',
      source: 'bundled',
    })
    const pipelineRefresh = makePromptCommand({
      name: 'browser_harness:workflow:growth:pipeline-refresh',
      description: 'Refresh the GTM pipeline and outreach backlog',
      whenToUse: 'Rebuild the growth plan after market changes',
      kind: 'workflow',
      loadedFrom: 'mcp',
      source: 'mcp',
      workflowSteps: [{ title: 'Refresh the pipeline' }],
      outputs: ['Updated pipeline brief'],
    })
    const ranked = rankCapabilities(
      [pipelineRefresh, browserHarness],
      {
        queryText:
          'Use the browser to log in, click through the funnel, and capture screenshots of the current website flow',
      },
    )

    expect(ranked[0]?.name).toBe('browser-harness')
  })

  test('prioritizes structured workflows for lane-specific work', () => {
    const browserHarness = makePromptCommand({
      name: 'browser-harness',
      description: 'General browser executor',
      whenToUse: 'Use for screenshots and web actions',
      loadedFrom: 'bundled',
      source: 'bundled',
    })
    const pipelineRefresh = makePromptCommand({
      name: 'browser_harness:workflow:growth:pipeline-refresh',
      description: 'Refresh the GTM pipeline from the latest public surface',
      whenToUse:
        'Refresh the pipeline after messaging, ICP, or positioning changes',
      kind: 'workflow',
      loadedFrom: 'mcp',
      source: 'mcp',
      inputs: ['Website and positioning'],
      outputs: ['Updated outreach backlog'],
      successCriteria: ['Prioritizes the next highest-leverage actions'],
      workflowSteps: [
        { title: 'Gather evidence' },
        { title: 'Prioritize outreach actions' },
      ],
    })
    const ranked = rankCapabilities(
      [browserHarness, pipelineRefresh],
      {
        queryText:
          'Refresh the sales pipeline and reprioritize the outreach backlog for this quarter',
      },
    )

    expect(ranked[0]?.name).toBe(
      'browser_harness:workflow:growth:pipeline-refresh',
    )
  })

  test('ranks raw deferred capability names with the same intent model', () => {
    const ranked = rankCapabilityNames(
      [
        'mcp__github__create_issue',
        'mcp__claude-in-chrome__tabs_context_mcp',
        'mcp__google_drive__docs_search',
      ],
      'Open the current browser tab and capture a screenshot of the page',
      3,
    )

    expect(ranked[0]).toBe('mcp__claude-in-chrome__tabs_context_mcp')
  })
})
