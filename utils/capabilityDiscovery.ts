import type { Command, WorkflowStep } from '../types/command.js'
import { getCommandName } from '../types/command.js'

export type CapabilityFamily =
  | 'workflow'
  | 'browser'
  | 'integration'
  | 'pack'
  | 'builtin'
  | 'general'

type CapabilityLike = {
  name: string
  description?: string
  aliases?: string[]
  whenToUse?: string
  inputs?: string[]
  outputs?: string[]
  successCriteria?: string[]
  workflowSteps?: WorkflowStep[]
  allowedTools?: string[]
  loadedFrom?: Command['loadedFrom']
  source?: string
  type?: Command['type']
  kind?: Command['kind']
  userFacingName?: () => string
}

type DiscoveryIntent = {
  query: string
  tokens: string[]
  wantsBrowser: boolean
  wantsWorkflow: boolean
  wantsIntegration: boolean
  wantsImplementation: boolean
  lanes: Set<DiscoveryLane>
}

type DiscoveryLane =
  | 'growth'
  | 'content'
  | 'customer_ops'
  | 'business_ops'
  | 'engineering'

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'that',
  'the',
  'this',
  'to',
  'us',
  'we',
  'with',
  'you',
  'your',
])

const BROWSER_KEYWORDS = [
  'browser',
  'browsing',
  'chrome',
  'click',
  'console',
  'crawl',
  'dom',
  'form',
  'login',
  'page',
  'scrape',
  'screenshot',
  'tab',
  'web',
  'website',
]

const INTEGRATION_KEYWORDS = [
  'crm',
  'docs',
  'drive',
  'email',
  'github',
  'gmail',
  'google',
  'hubspot',
  'jira',
  'linear',
  'mcp',
  'notion',
  'salesforce',
  'sheet',
  'slack',
]

const WORKFLOW_KEYWORDS = [
  'audit',
  'execute',
  'playbook',
  'process',
  'publish',
  'qualify',
  'refresh',
  'runbook',
  'triage',
  'workflow',
]

const IMPLEMENTATION_KEYWORDS = [
  'automation',
  'build',
  'debug',
  'deploy',
  'edit',
  'fix',
  'implement',
  'script',
  'test',
  'update',
]

const LANE_KEYWORDS: Record<DiscoveryLane, string[]> = {
  growth: [
    'campaign',
    'conversion',
    'demand',
    'funnel',
    'gtm',
    'growth',
    'icp',
    'lead',
    'messaging',
    'outbound',
    'pipeline',
    'positioning',
    'prospect',
    'sales',
  ],
  content: [
    'blog',
    'content',
    'copy',
    'landing',
    'newsletter',
    'post',
    'publish',
    'seo',
    'social',
  ],
  customer_ops: [
    'customer',
    'escalation',
    'faq',
    'help',
    'helpdesk',
    'inbox',
    'reply',
    'support',
    'ticket',
    'triage',
  ],
  business_ops: [
    'admin',
    'audit',
    'backoffice',
    'billing',
    'finance',
    'invoice',
    'ops',
    'operations',
    'reporting',
    'schedule',
    'vendor',
  ],
  engineering: [
    'bug',
    'build',
    'ci',
    'code',
    'debug',
    'deploy',
    'pr',
    'release',
    'repo',
    'review',
    'test',
  ],
}

function cleanToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function tokenize(value: string): string[] {
  return [...new Set(
    value
      .split(/[^a-zA-Z0-9]+/)
      .map(cleanToken)
      .filter(token => token.length >= 3 && !STOP_WORDS.has(token)),
  )]
}

function normalizeName(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[:/_-]+/g, ' ')
    .toLowerCase()
}

function collectCapabilityText(capability: CapabilityLike): string {
  return [
    normalizeName(getCapabilityDisplayName(capability)),
    normalizeName(capability.name),
    capability.aliases?.join(' '),
    capability.description,
    capability.whenToUse,
    capability.inputs?.join(' '),
    capability.outputs?.join(' '),
    capability.successCriteria?.join(' '),
    capability.workflowSteps
      ?.map(step =>
        [step.title, step.objective, step.success, step.tools?.join(' ')]
          .filter(Boolean)
          .join(' '),
      )
      .join(' '),
    capability.allowedTools?.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some(needle => haystack.includes(needle))
}

function inferLaneMatches(text: string): Set<DiscoveryLane> {
  const lanes = new Set<DiscoveryLane>()
  for (const [lane, keywords] of Object.entries(LANE_KEYWORDS) as Array<
    [DiscoveryLane, string[]]
  >) {
    if (keywords.some(keyword => text.includes(keyword))) {
      lanes.add(lane)
    }
  }
  return lanes
}

function inferDiscoveryIntent(queryText: string): DiscoveryIntent {
  const query = queryText.trim().toLowerCase()
  const tokens = tokenize(query)
  const lanes = inferLaneMatches(query)

  return {
    query,
    tokens,
    lanes,
    wantsBrowser: includesAny(query, BROWSER_KEYWORDS),
    wantsWorkflow:
      includesAny(query, WORKFLOW_KEYWORDS) ||
      query.includes('step') ||
      query.includes('plan'),
    wantsIntegration: includesAny(query, INTEGRATION_KEYWORDS),
    wantsImplementation: includesAny(query, IMPLEMENTATION_KEYWORDS),
  }
}

function getCapabilityFamily(capability: CapabilityLike): CapabilityFamily {
  const searchableText = collectCapabilityText(capability)

  if (
    capability.kind === 'workflow' ||
    (capability.workflowSteps?.length ?? 0) > 0
  ) {
    return 'workflow'
  }

  if (
    includesAny(searchableText, BROWSER_KEYWORDS) ||
    includesAny(capability.allowedTools?.join(' ').toLowerCase() ?? '', [
      'claude-in-chrome',
    ])
  ) {
    return 'browser'
  }

  if (
    capability.loadedFrom === 'mcp' ||
    capability.loadedFrom === 'plugin' ||
    capability.source === 'mcp' ||
    capability.source === 'plugin' ||
    searchableText.includes('mcp__')
  ) {
    return 'integration'
  }

  if (capability.type === 'local' || capability.type === 'local-jsx') {
    return 'builtin'
  }

  if (
    capability.loadedFrom === 'bundled' ||
    capability.loadedFrom === 'skills' ||
    capability.loadedFrom === 'managed' ||
    capability.loadedFrom === 'commands_DEPRECATED'
  ) {
    return 'pack'
  }

  return 'general'
}

function getBaseFamilyScore(family: CapabilityFamily): number {
  switch (family) {
    case 'workflow':
      return 7
    case 'browser':
      return 6
    case 'integration':
      return 5
    case 'pack':
      return 4
    case 'builtin':
      return 3
    case 'general':
      return 2
  }
}

function getLaneAlignmentScore(
  intent: DiscoveryIntent,
  capabilityText: string,
): number {
  if (intent.lanes.size === 0) {
    return 0
  }

  let score = 0
  for (const lane of intent.lanes) {
    const keywords = LANE_KEYWORDS[lane]
    if (keywords.some(keyword => capabilityText.includes(keyword))) {
      score += 10
    }
  }
  return score
}

export function scoreCapabilityForQuery(
  capability: CapabilityLike,
  queryText: string,
  usageScore = 0,
): number {
  const intent = inferDiscoveryIntent(queryText)
  const capabilityText = collectCapabilityText(capability)
  const capabilityTokens = new Set(tokenize(capabilityText))
  const name = normalizeName(capability.name)
  const aliases = capability.aliases?.map(alias => normalizeName(alias)) ?? []
  const family = getCapabilityFamily(capability)

  let score = getBaseFamilyScore(family)

  if (intent.query.length === 0) {
    score += usageScore * 0.5
    return score
  }

  for (const token of intent.tokens) {
    if (name.includes(token)) {
      score += 8
    }
    if (aliases.some(alias => alias.includes(token))) {
      score += 6
    }
    if (capabilityTokens.has(token)) {
      score += 4
    } else if (capabilityText.includes(token)) {
      score += 2
    }
  }

  score += getLaneAlignmentScore(intent, capabilityText)

  if (intent.wantsBrowser && family === 'browser') {
    score += 16
  }
  if (intent.wantsWorkflow && family === 'workflow') {
    score += 12
  }
  if (intent.wantsIntegration && family === 'integration') {
    score += 10
  }
  if (intent.wantsImplementation && family === 'builtin') {
    score += 6
  }

  if (
    capability.kind === 'workflow' &&
    (capability.outputs?.length ?? 0) > 0 &&
    intent.wantsWorkflow
  ) {
    score += 3
  }

  if ((capability.workflowSteps?.length ?? 0) > 0) {
    score += 2
  }

  score += Math.min(usageScore, 20) * 0.75

  return score
}

function getFamilySelectionLimit(
  family: CapabilityFamily,
  intent: DiscoveryIntent,
): number {
  switch (family) {
    case 'browser':
      return intent.wantsBrowser ? 3 : 2
    case 'workflow':
      return intent.wantsWorkflow ? 4 : 3
    case 'integration':
      return intent.wantsIntegration ? 4 : 3
    case 'pack':
      return 3
    case 'builtin':
      return intent.query.length === 0 ? 6 : 3
    case 'general':
      return 2
  }
}

export function rankCapabilities<T extends CapabilityLike>(
  capabilities: T[],
  options: {
    queryText?: string | null
    limit?: number
    getUsageScore?: (capability: T) => number
  } = {},
): T[] {
  const queryText = options.queryText?.trim() ?? ''
  const intent = inferDiscoveryIntent(queryText)

  const ranked = capabilities
    .map(capability => {
      const family = getCapabilityFamily(capability)
      const usageScore = options.getUsageScore?.(capability) ?? 0
      const score = scoreCapabilityForQuery(capability, queryText, usageScore)
      return {
        capability,
        family,
        score,
      }
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      if (left.family !== right.family) {
        return getBaseFamilyScore(right.family) - getBaseFamilyScore(left.family)
      }

      return left.capability.name.localeCompare(right.capability.name)
    })

  const limit =
    options.limit ?? (intent.query.length === 0 ? 16 : 12)

  const selected: T[] = []
  const familyCounts = new Map<CapabilityFamily, number>()
  const topScore = ranked[0]?.score ?? 0

  for (const entry of ranked) {
    if (selected.length >= limit) {
      break
    }

    const count = familyCounts.get(entry.family) ?? 0
    const familyLimit = getFamilySelectionLimit(entry.family, intent)
    const isStrongMatch =
      entry.score >= Math.max(8, topScore - 4) || selected.length < 3

    if (count >= familyLimit && !isStrongMatch) {
      continue
    }

    selected.push(entry.capability)
    familyCounts.set(entry.family, count + 1)
  }

  if (selected.length === 0) {
    return ranked.slice(0, limit).map(entry => entry.capability)
  }

  return selected
}

export function rankCapabilityNames(
  names: string[],
  queryText: string,
  limit = 12,
): string[] {
  return rankCapabilities(
    names.map(name => ({ name })),
    {
      queryText,
      limit,
    },
  ).map(capability => capability.name)
}

export function getCapabilityDisplayName(capability: CapabilityLike): string {
  if (typeof capability.userFacingName === 'function') {
    return capability.userFacingName()
  }
  if ('type' in capability) {
    return getCommandName(capability as Command)
  }
  return capability.name
}
