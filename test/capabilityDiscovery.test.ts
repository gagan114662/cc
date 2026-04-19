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

  test('prefers first-class browser workflows over generic executors when the verb matches', () => {
    const browserHarness = makePromptCommand({
      name: 'browser-harness',
      description: 'General browser executor',
      whenToUse: 'Use for screenshots and web actions',
      loadedFrom: 'bundled',
      source: 'bundled',
    })
    const funnelAudit = makePromptCommand({
      name: 'browser-funnel-audit',
      description:
        'Audit a live website funnel, capture friction, and recommend fixes',
      whenToUse:
        'Use when the user needs a browser-backed funnel audit with evidence',
      verbs: ['audit funnel', 'capture friction', 'recommend fixes'],
      outputs: ['Funnel audit summary', 'Prioritized fixes'],
      artifactKinds: ['funnel audit', 'fix backlog'],
      kind: 'workflow',
      loadedFrom: 'bundled',
      source: 'bundled',
      workflowSteps: [
        { title: 'Open funnel' },
        { title: 'Collect friction evidence' },
        { title: 'Recommend fixes' },
      ],
    })

    const ranked = rankCapabilities([browserHarness, funnelAudit], {
      queryText:
        'Audit the signup funnel in the browser and tell me the biggest friction points',
    })

    expect(ranked[0]?.name).toBe('browser-funnel-audit')
  })

  test('prefers competitive teardown workflows for positioning and competitor analysis', () => {
    const browserHarness = makePromptCommand({
      name: 'browser-harness',
      description: 'General browser executor',
      whenToUse: 'Use for screenshots and web actions',
      loadedFrom: 'bundled',
      source: 'bundled',
    })
    const competitiveTeardown = makePromptCommand({
      name: 'browser-competitive-teardown',
      description:
        'Compare a target site against live competitors and prioritize differentiation moves',
      whenToUse:
        'Use when the user needs a browser-backed positioning or competitive teardown',
      verbs: [
        'compare competitors',
        'map positioning gaps',
        'prioritize differentiation',
      ],
      outputs: ['Competitive teardown', 'Differentiation backlog'],
      artifactKinds: ['competitive teardown', 'differentiation backlog'],
      kind: 'workflow',
      loadedFrom: 'bundled',
      source: 'bundled',
      workflowSteps: [
        { title: 'Map target positioning' },
        { title: 'Compare live competitors' },
        { title: 'Prioritize differentiation moves' },
      ],
    })

    const ranked = rankCapabilities([browserHarness, competitiveTeardown], {
      queryText:
        'Compare our homepage to competitors and tell me the biggest messaging and proof gaps',
    })

    expect(ranked[0]?.name).toBe('browser-competitive-teardown')
  })

  test('prefers support audit workflows for FAQ and customer path work', () => {
    const browserHarness = makePromptCommand({
      name: 'browser-harness',
      description: 'General browser executor',
      whenToUse: 'Use for screenshots and web actions',
      loadedFrom: 'bundled',
      source: 'bundled',
    })
    const supportAudit = makePromptCommand({
      name: 'browser-support-faq-audit',
      description:
        'Audit the live support and FAQ paths and prioritize the next fixes',
      whenToUse:
        'Use when the user needs a browser-backed support, FAQ, or help-center audit',
      verbs: ['audit support path', 'map faq gaps', 'prioritize support fixes'],
      outputs: ['Support audit summary', 'FAQ/support backlog'],
      artifactKinds: ['support audit', 'faq backlog'],
      kind: 'workflow',
      loadedFrom: 'bundled',
      source: 'bundled',
      workflowSteps: [
        { title: 'Map support entry points' },
        { title: 'Test top customer task' },
        { title: 'Prioritize FAQ and support fixes' },
      ],
    })

    const ranked = rankCapabilities([browserHarness, supportAudit], {
      queryText:
        'Audit the FAQ and support flow for the top customer issue and tell me what is missing',
    })

    expect(ranked[0]?.name).toBe('browser-support-faq-audit')
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
