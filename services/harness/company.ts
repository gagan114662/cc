import { createStableId, nowIso, truncateText } from './utils.js'
import {
  buildHarnessRepoId,
  ensureHostedRepoRegistration,
  filterHarnessStateForRepo,
  getHostedHarnessControlPlaneInfo,
  withHostedHarnessState,
} from './controlPlane.js'
import { readEffectiveHarnessConfig } from './config.js'
import { enqueueHarnessJob } from './runtime.js'
import {
  choosePreferredRuntime,
  getDefaultPackRegistry,
  getPackCatalogForCompanyGraph,
  recommendedConnectorsForCompany,
  selectPacksForCompanyGraph,
  summarizePackTitles,
} from './packs.js'
import { logHarnessWideEvent } from './telemetry.js'
import type {
  BusinessArchetype,
  CompanyGap,
  CompanyGraph,
  CompanyMetrics,
  CompanyRecord,
  ConnectorPolicy,
  ConnectorUnlockRecommendation,
  DynamicOrg,
  HarnessExecutionBackend,
  HarnessAgentKind,
  HarnessRuntimeState,
  LaneRun,
  MissionControlAction,
  MissionControlActionResult,
  MissionControlMetrics,
  MissionControlPackView,
  MissionControlSnapshot,
  MissionControlStandingLaneCard,
  MissionControlWorkstreamCard,
  OperatingModel,
  OwnerException,
  OwnerMessage,
  OwnerTouchMetric,
  PMDecision,
  PackManifest,
  PMSnapshot,
  SpecialistAgentRole,
  StandingLane,
  StandingLaneType,
  UsefulArtifact,
  WorkstreamSpec,
} from './types.js'

export type CompanyOnboardInput = {
  websiteUrl: string
  socialUrls?: string[]
}

export type CompanyMissionControl = {
  controlPlane: ReturnType<typeof getHostedHarnessControlPlaneInfo>
  repoId: string
  snapshot: MissionControlSnapshot
  company: CompanyRecord | null
  operatingModel: OperatingModel | null
  pmAgent: SpecialistAgentRole | null
  specialistAgents: SpecialistAgentRole[]
  standingLanes: MissionControlStandingLaneCard[]
  laneRuns: LaneRun[]
  workstreams: WorkstreamSpec[]
  workstreamCards: MissionControlWorkstreamCard[]
  usefulArtifacts: UsefulArtifact[]
  exceptions: OwnerException[]
  gaps: CompanyGap[]
  connectorRecommendations: ConnectorUnlockRecommendation[]
  connectorPolicies: ConnectorPolicy[]
  ownerTouchMetrics: OwnerTouchMetric[]
  packs: MissionControlPackView[]
  recentPmDecisions: PMDecision[]
  recentOwnerMessages: OwnerMessage[]
  metrics: MissionControlMetrics
  queuedCount: number
  activeCount: number
  observability: HarnessRuntimeState['observability']
  summary: string
}

type PageSignal = {
  url: string
  kind: 'website' | 'social'
  title?: string
  description?: string
  text: string
}

type WebsitePageFetch = {
  signal: PageSignal
  html: string
}

const SOCIAL_HINTS = [
  'linkedin.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'instagram.com',
  'tiktok.com',
]

const MAX_WEBSITE_PAGES = 8
const MS_PER_DAY = 86_400_000
const WEBSITE_DISCOVERY_PATHS = [
  '/',
  '/pricing',
  '/about',
  '/docs',
  '/blog',
  '/careers',
  '/faq',
  '/help',
  '/contact',
] as const

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => {
      const parsed = Number.parseInt(code, 10)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const parsed = Number.parseInt(code, 16)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _
    })
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
}

function normalizeUrl(raw: string): string {
  const url = raw.startsWith('http://') || raw.startsWith('https://')
    ? new URL(raw)
    : new URL(`https://${raw}`)
  url.hash = ''
  return url.toString()
}

function getHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '')
}

function titleCase(value: string): string {
  return value
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function toIso(date: Date): string {
  return date.toISOString()
}

function getDayBucket(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10)
}

function getCadenceBucket(cadence: StandingLane['cadence'], isoTimestamp: string): string {
  switch (cadence) {
    case 'daily':
      return `D:${getDayBucket(isoTimestamp)}`
    case 'weekly':
      return `W:${getWeekBucket(isoTimestamp)}`
    default:
      return `O:${getDayBucket(isoTimestamp)}`
  }
}

function addCadenceWindow(
  isoTimestamp: string,
  cadence: StandingLane['cadence'],
): string | undefined {
  if (cadence === 'on-demand') {
    return undefined
  }
  const base = new Date(isoTimestamp)
  const next = new Date(
    base.getTime() + (cadence === 'weekly' ? 7 * MS_PER_DAY : MS_PER_DAY),
  )
  return toIso(next)
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(),
  )
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return (
    decodeHtmlEntities(match?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim() || undefined
  )
}

function extractMetaDescription(html: string): string | undefined {
  const match = html.match(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
  )
  return (
    decodeHtmlEntities(match?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim() || undefined
  )
}

function extractHeadingTexts(html: string): string[] {
  return [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map(match => stripHtml(match[1] ?? ''))
    .filter(Boolean)
}

function buildPageSignal(
  url: string,
  kind: 'website' | 'social',
  html: string,
): PageSignal {
  const title = extractTitle(html)
  const description = extractMetaDescription(html)
  const headings = extractHeadingTexts(html).slice(0, 6)
  const text = [description, ...headings, stripHtml(html)].filter(Boolean).join(' ')
  return {
    url,
    kind,
    title,
    description,
    text: truncateText(text, 8_000),
  }
}

async function fetchWebsitePage(url: string): Promise<WebsitePageFetch | null> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'cc-company-onboard/1.0',
      accept: 'text/html,application/xhtml+xml',
    },
  })
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (
    !contentType.includes('text/html') &&
    !contentType.includes('application/xhtml+xml')
  ) {
    return null
  }
  const html = await response.text()
  return {
    signal: buildPageSignal(url, 'website', html),
    html,
  }
}

async function fetchSocialSignal(url: string): Promise<PageSignal | null> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'cc-company-onboard/1.0',
      accept: 'text/html,application/xhtml+xml',
    },
  })
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (
    !contentType.includes('text/html') &&
    !contentType.includes('application/xhtml+xml')
  ) {
    return null
  }
  const html = await response.text()
  return buildPageSignal(url, 'social', html)
}

function isSocialHost(value: string): boolean {
  const host = value.includes('://') ? getHost(value) : value.replace(/^www\./, '')
  return SOCIAL_HINTS.some(hint => host === hint || host.endsWith(`.${hint}`))
}

function getSocialHandle(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname
    const segments = pathname.split('/').filter(Boolean)
    return segments[0] || undefined
  } catch {
    return undefined
  }
}

function normalizeSameHostUrl(candidate: string, host: string): string | null {
  try {
    const normalized = normalizeUrl(candidate)
    return getHost(normalized) === host ? normalized : null
  } catch {
    return null
  }
}

function extractSameHostLinks(
  html: string,
  baseUrl: string,
  host: string,
): string[] {
  return [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
    .map(match => match[1] ?? '')
    .map(href => {
      try {
        return new URL(href, baseUrl).toString()
      } catch {
        return null
      }
    })
    .filter((value): value is string => Boolean(value))
    .map(url => normalizeSameHostUrl(url, host))
    .filter((value): value is string => Boolean(value))
}

function extractSitemapUrls(xml: string, host: string): string[] {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map(match => stripHtml(match[1] ?? ''))
    .map(url => normalizeSameHostUrl(url, host))
    .filter((value): value is string => Boolean(value))
}

function rankWebsiteUrl(url: string): number {
  const pathname = new URL(url).pathname.toLowerCase()
  const weights = [
    '/pricing',
    '/about',
    '/docs',
    '/blog',
    '/careers',
    '/faq',
    '/help',
    '/contact',
  ]
  const index = weights.findIndex(weight => pathname.startsWith(weight))
  return index >= 0 ? index : weights.length + pathname.length
}

async function fetchSitemapCandidates(
  websiteUrl: string,
  host: string,
): Promise<string[]> {
  try {
    const sitemapUrl = new URL('/sitemap.xml', websiteUrl).toString()
    const response = await fetch(sitemapUrl, {
      redirect: 'follow',
      headers: {
        'user-agent': 'cc-company-onboard/1.0',
        accept: 'application/xml,text/xml,text/plain',
      },
    })
    if (!response.ok) {
      return []
    }
    const xml = await response.text()
    return extractSitemapUrls(xml, host)
  } catch {
    return []
  }
}

function containsAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase()
  return terms.some(term => lower.includes(term))
}

function pickMatchingPhrases(text: string, phrases: string[], limit: number): string[] {
  const lower = text.toLowerCase()
  return phrases.filter(phrase => lower.includes(phrase.toLowerCase())).slice(0, limit)
}

function inferBusinessArchetype(text: string): BusinessArchetype {
  const lower = text.toLowerCase()
  if (
    lower.includes('marketplace') ||
    lower.includes('buyers and sellers') ||
    lower.includes('vendors')
  ) {
    return 'marketplace'
  }
  if (
    lower.includes('developer') ||
    lower.includes('sdk') ||
    lower.includes('api') ||
    lower.includes('cli') ||
    lower.includes('open source')
  ) {
    return 'developer-tools'
  }
  if (
    lower.includes('agency') ||
    lower.includes('client work') ||
    lower.includes('services for') ||
    lower.includes('studio')
  ) {
    return 'agency'
  }
  if (
    lower.includes('shop') ||
    lower.includes('cart') ||
    lower.includes('buy now') ||
    lower.includes('ecommerce')
  ) {
    return 'ecommerce'
  }
  if (
    lower.includes('newsletter') ||
    lower.includes('podcast') ||
    lower.includes('media') ||
    lower.includes('creator')
  ) {
    return 'media'
  }
  if (
    lower.includes('community') ||
    lower.includes('membership') ||
    lower.includes('forum')
  ) {
    return 'community'
  }
  if (
    lower.includes('book a call') ||
    lower.includes('book an appointment') ||
    lower.includes('consulting') ||
    lower.includes('service business')
  ) {
    return 'services'
  }
  if (
    lower.includes('software') ||
    lower.includes('platform') ||
    lower.includes('free trial') ||
    lower.includes('get started') ||
    lower.includes('pricing')
  ) {
    return 'saas'
  }
  return 'unknown'
}

function inferCompanyName(signal: PageSignal, host: string): string {
  const title = signal.title?.split(/[\-|–|•|·]/)[0]?.trim()
  if (title) {
    if (isSocialHost(host)) {
      return title.replace(/\s+\(@[^)]+\)\s*$/i, '').trim()
    }
    return title
  }
  if (isSocialHost(host)) {
    const handle = getSocialHandle(signal.url)
    if (handle) {
      return titleCase(handle)
    }
  }
  return titleCase(host.split('.')[0] ?? host)
}

function inferBusinessArchetypeFromSignals(
  signals: PageSignal[],
  combinedText: string,
  companyName: string,
  host: string,
): BusinessArchetype {
  const lower = combinedText.toLowerCase()
  const socialProfilePrimary = isSocialHost(host) && signals.every(signal => signal.kind === 'social')

  if (socialProfilePrimary) {
    const socialServiceSignals = [companyName, combinedText].join(' ').toLowerCase()
    if (
      containsAny(socialServiceSignals, [
        'agency',
        'studio',
        'creative',
        'branding',
        'brand design',
        'graphic design',
        'design',
      ])
    ) {
      return 'agency'
    }
    if (
      containsAny(socialServiceSignals, [
        'consulting',
        'book a call',
        'book an appointment',
        'service',
      ])
    ) {
      return 'services'
    }
    if (
      containsAny(socialServiceSignals, [
        'shop',
        'store',
        'buy',
        'order',
      ])
    ) {
      return 'ecommerce'
    }
    return 'unknown'
  }

  return inferBusinessArchetype(lower)
}

function buildCompanySummary(
  signal: PageSignal,
  companyName: string,
  archetype: BusinessArchetype,
): string {
  if (signal.description) {
    return truncateText(signal.description, 240)
  }
  const prefix =
    archetype === 'unknown'
      ? `${companyName} has a public web presence with enough signal to start a PM-led business sweep.`
      : `${companyName} looks like a ${archetype.replace('-', ' ')} business.`
  return truncateText(`${prefix} ${signal.text}`, 240)
}

function buildEvidence(text: string, headings: string[]): string[] {
  const phrases = [
    'pricing',
    'free trial',
    'book a demo',
    'contact sales',
    'blog',
    'docs',
    'faq',
    'help center',
    'api',
    'integrations',
    'careers',
    'customers',
    'case studies',
  ]
  return [...new Set([...headings, ...pickMatchingPhrases(text, phrases, 8)])].slice(0, 8)
}

function synthesizeCompanyGraph(
  repoId: string,
  websiteUrl: string,
  socialUrls: string[],
  signals: PageSignal[],
  now: string,
): CompanyGraph {
  const normalizedHost = getHost(websiteUrl)
  const websiteSignal = signals[0]
  const headings = signals.flatMap(signal =>
    (signal.title ? [signal.title] : []).concat(
      signal.description ? [signal.description] : [],
    ),
  )
  const combinedText = signals.map(signal => signal.text).join(' ')
  const companyName = inferCompanyName(websiteSignal, normalizedHost)
  const businessArchetype = inferBusinessArchetypeFromSignals(
    signals,
    combinedText,
    companyName,
    normalizedHost,
  )
  const icpRoles = pickMatchingPhrases(
    combinedText,
    [
      'founders',
      'marketers',
      'sales teams',
      'developers',
      'engineering teams',
      'customer support',
      'finance teams',
      'operations teams',
      'recruiters',
      'creators',
    ],
    6,
  )
  const demandChannels = pickMatchingPhrases(
    combinedText,
    [
      'seo',
      'content',
      'social',
      'outbound',
      'email',
      'partnerships',
      'community',
      'ads',
      'referrals',
    ],
    6,
  )
  if (isSocialHost(normalizedHost)) {
    demandChannels.unshift('social')
  }
  const supportSurfaces = pickMatchingPhrases(
    combinedText,
    ['support', 'help center', 'faq', 'docs', 'documentation', 'contact'],
    6,
  )
  const operationalNeeds = pickMatchingPhrases(
    combinedText,
    [
      'reporting',
      'automation',
      'analytics',
      'scheduling',
      'billing',
      'hiring',
      'customer onboarding',
      'workflow',
    ],
    8,
  )
  const technicalSignals = pickMatchingPhrases(
    combinedText,
    ['api', 'sdk', 'github', 'developers', 'integration', 'cli', 'webhook'],
    8,
  )
  const offers = pickMatchingPhrases(
    combinedText,
    [
      'platform',
      'software',
      'service',
      'consulting',
      'agency',
      'marketplace',
      'tool',
      'app',
      'subscription',
    ],
    8,
  )
  const valueProps = headings
    .map(heading => truncateText(heading, 120))
    .filter(Boolean)
    .slice(0, 6)
  const summary = buildCompanySummary(websiteSignal, companyName, businessArchetype)
  const evidence = buildEvidence(combinedText, valueProps)

  return {
    id: createStableId(repoId, normalizedHost, 'graph'),
    repoId,
    websiteUrl,
    socialUrls,
    normalizedHost,
    companyName,
    businessArchetype,
    summary,
    valueProps,
    offers,
    icpRoles,
    demandChannels,
    supportSurfaces,
    operationalNeeds,
    technicalSignals,
    evidence,
    signals: signals.map(signal => ({
      id: createStableId(signal.url, signal.kind),
      kind: signal.kind,
      sourceUrl: signal.url,
      title: signal.title,
      description: signal.description,
      contentPreview: truncateText(signal.text, 240),
      keywords: buildEvidence(signal.text, signal.title ? [signal.title] : []),
      fetchedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
    metadata: {},
  }
}

function synthesizeOperatingModel(
  companyId: string,
  graph: CompanyGraph,
  now: string,
): OperatingModel {
  const recurringLaneNeeds: StandingLaneType[] = ['GrowthLane', 'BusinessOpsLane', 'ExecutiveBriefLane']

  if (
    graph.demandChannels.length > 0 ||
    graph.signals.some(signal =>
      signal.keywords.some(keyword =>
        ['content', 'seo', 'blog', 'social'].some(token =>
          keyword.toLowerCase().includes(token),
        ),
      ),
    )
  ) {
    recurringLaneNeeds.push('ContentLane')
  }

  if (
    graph.supportSurfaces.length > 0 ||
    ['agency', 'services', 'ecommerce', 'marketplace'].includes(graph.businessArchetype)
  ) {
    recurringLaneNeeds.push('CustomerOpsLane')
  }

  return {
    id: createStableId(companyId, 'operating-model'),
    companyId,
    businessArchetype: graph.businessArchetype,
    offers: graph.offers,
    buyerRoles: graph.icpRoles,
    coreChannels: dedupe(graph.demandChannels),
    operationalSurfaces: dedupe([
      ...graph.supportSurfaces,
      ...graph.operationalNeeds,
      ...graph.technicalSignals,
    ]),
    recurringLaneNeeds: dedupe(recurringLaneNeeds),
    evidence: graph.evidence,
    confidence: {
      archetype: graph.businessArchetype === 'unknown' ? 0.35 : 0.75,
      offers: Math.min(1, Math.max(0.25, graph.offers.length / 4)),
      buyers: Math.min(1, Math.max(0.25, graph.icpRoles.length / 4)),
      channels: Math.min(1, Math.max(0.25, graph.demandChannels.length / 4)),
      operations: Math.min(
        1,
        Math.max(
          0.3,
          dedupe([...graph.supportSurfaces, ...graph.operationalNeeds]).length / 5,
        ),
      ),
      technical: Math.min(1, Math.max(0.2, graph.technicalSignals.length / 4)),
    },
    createdAt: now,
    updatedAt: now,
    metadata: {
      normalizedHost: graph.normalizedHost,
    },
  }
}

function buildSpecialistRole(
  companyId: string,
  now: string,
  input: {
    slug: string
    name: string
    title: string
    domain: WorkstreamSpec['domain']
    objective: string
    agentKind: HarnessAgentKind
    visibility?: 'owner' | 'internal'
    packIds?: string[]
    capabilities?: string[]
  },
): SpecialistAgentRole {
  return {
    id: createStableId(companyId, input.slug),
    companyId,
    name: input.name,
    title: input.title,
    domain: input.domain,
    objective: input.objective,
    agentKind: input.agentKind,
    visibility: input.visibility ?? 'internal',
    status: 'active',
    capabilities: input.capabilities ?? [],
    packIds: input.packIds ?? [],
    createdBy: 'pm',
    createdAt: now,
    metadata: {},
  }
}

function synthesizeDynamicOrg(
  graph: CompanyGraph,
  packs: PackManifest[],
  now: string,
): DynamicOrg {
  const companyId = createStableId(graph.repoId, graph.websiteUrl)
  const pmRole = buildSpecialistRole(companyId, now, {
    slug: 'pm-chief-of-staff',
    name: `${graph.companyName} PM`,
    title: 'Chief of Staff',
    domain: 'pm',
    agentKind: 'claude',
    visibility: 'owner',
    objective:
      'Own company understanding, prioritize workstreams, shield the owner from swarm complexity, and communicate only exceptions and executive summaries.',
    capabilities: ['company-understanding', 'prioritization', 'executive-briefs'],
    packIds: ['company-os-foundations'],
  })
  const roles: SpecialistAgentRole[] = [pmRole]

  const addRole = (
    slug: string,
    title: string,
    domain: WorkstreamSpec['domain'],
    objective: string,
    agentKind: HarnessAgentKind,
    packIds: string[],
  ): void => {
    roles.push(
      buildSpecialistRole(companyId, now, {
        slug,
        name: `${graph.companyName} ${title}`,
        title,
        domain,
        objective,
        agentKind,
        packIds,
      }),
    )
  }

  addRole(
    'market-intel',
    'Market Intelligence Lead',
    'market-intel',
    'Map competitors, positioning, and growth opportunities for the PM.',
    'claude',
    packs.filter(pack => pack.domain === 'market-intel' || pack.domain === 'gtm').map(pack => pack.id),
  )

  if (graph.businessArchetype !== 'unknown') {
    addRole(
      'gtm',
      'GTM Lead',
      'gtm',
      'Own pipeline, messaging, and demand experiments for the PM.',
      'claude',
      packs.filter(pack => pack.domain === 'gtm').map(pack => pack.id),
    )
  }

  if (
    graph.demandChannels.length > 0 ||
    containsAny(graph.summary, ['content', 'seo', 'blog', 'newsletter'])
  ) {
    addRole(
      'content',
      'Content and SEO Lead',
      'content',
      'Turn public positioning into repeatable content and SEO workstreams.',
      'claude',
      packs.filter(pack => pack.domain === 'content').map(pack => pack.id),
    )
  }

  if (graph.supportSurfaces.length > 0) {
    addRole(
      'support',
      'Customer Ops Lead',
      'support',
      'Audit support surfaces, FAQ quality, and customer issue handling.',
      'claude',
      packs.filter(pack => pack.domain === 'support').map(pack => pack.id),
    )
  }

  addRole(
    'ops',
    'BizOps Lead',
    'ops',
    'Own automation, workflow, and connector-ready operational systems.',
    'codex',
    packs.filter(pack => pack.domain === 'ops' || pack.domain === 'company-system').map(pack => pack.id),
  )

  if (graph.technicalSignals.length > 0 || graph.businessArchetype === 'developer-tools') {
    addRole(
      'engineering',
      'Engineering Lead',
      'engineering',
      'Translate technical signals and product needs into implementation workstreams.',
      'codex',
      packs.filter(pack => pack.domain === 'engineering' || pack.domain === 'company-system').map(pack => pack.id),
    )
    addRole(
      'product',
      'Product Lead',
      'product',
      'Shape product opportunities and feature hypotheses for the PM.',
      'claude',
      packs.filter(pack => pack.domain === 'product' || pack.domain === 'company-system').map(pack => pack.id),
    )
  }

  return {
    id: createStableId(companyId, 'org'),
    companyId,
    pmAgentId: pmRole.id,
    roles,
    rationale:
      'The PM creates a small specialist org from public business signals, then prunes the team to the domains that evidence supports.',
    createdAt: now,
    updatedAt: now,
  }
}

function mergeDynamicOrg(
  existingOrg: DynamicOrg | undefined,
  nextOrg: DynamicOrg,
  now: string,
): DynamicOrg {
  if (!existingOrg) {
    return nextOrg
  }

  const activeRoleIds = new Set(nextOrg.roles.map(role => role.id))
  const retiredRoles = existingOrg.roles
    .filter(role => !activeRoleIds.has(role.id))
    .map(role => ({
      ...role,
      status: 'retired' as const,
      retiredAt: role.retiredAt ?? now,
    }))

  return {
    ...nextOrg,
    roles: [...nextOrg.roles, ...retiredRoles],
    updatedAt: now,
  }
}

function mergeWorkstreamState(
  existing: WorkstreamSpec | undefined,
  next: WorkstreamSpec,
): WorkstreamSpec {
  if (!existing) {
    return next
  }
  return {
    ...next,
    status: existing.status,
    jobInstanceId: existing.jobInstanceId,
    summary: existing.summary,
    lastOutcome: existing.lastOutcome,
    latestArtifactId: existing.latestArtifactId,
    completedAt: existing.completedAt,
    metadata: {
      ...next.metadata,
      ...existing.metadata,
      cadence: next.metadata.cadence ?? existing.metadata.cadence,
    },
    createdAt: existing.createdAt,
  }
}

function mergeConnectorRecommendationState(
  existing: ConnectorUnlockRecommendation | undefined,
  next: ConnectorUnlockRecommendation,
): ConnectorUnlockRecommendation {
  if (!existing) {
    return next
  }
  return {
    ...next,
    status: existing.status,
    metadata: {
      ...next.metadata,
      ...existing.metadata,
    },
  }
}

function chooseOwnerRole(
  org: DynamicOrg,
  domain: WorkstreamSpec['domain'],
): SpecialistAgentRole {
  return (
    org.roles.find(role => role.domain === domain && role.status === 'active') ??
    org.roles.find(role => role.id === org.pmAgentId) ??
    org.roles[0]!
  )
}

function packSupportsLaneType(
  pack: PackManifest,
  laneType: StandingLaneType,
): boolean {
  return pack.supportedLaneTypes.includes(laneType)
}

function buildStandingLane(
  companyId: string,
  now: string,
  input: {
    type: StandingLaneType
    title: string
    domain: WorkstreamSpec['domain']
    objective: string
    cadence: StandingLane['cadence']
    inputs: string[]
    ownerAgentId: string
    runtimeOwner: StandingLane['runtimeOwner']
    packIds: string[]
    connectorIds: string[]
    expectedArtifactKinds: StandingLane['expectedArtifactKinds']
    successCriteria: string[]
  },
): StandingLane {
  return {
    id: createStableId(companyId, 'lane', input.type),
    companyId,
    type: input.type,
    title: input.title,
    domain: input.domain,
    objective: input.objective,
    cadence: input.cadence,
    inputs: input.inputs,
    connectorIds: input.connectorIds,
    expectedArtifactKinds: input.expectedArtifactKinds,
    escalationPolicy: 'exception-only',
    successCriteria: input.successCriteria,
    ownerAgentId: input.ownerAgentId,
    runtimeOwner: input.runtimeOwner,
    packIds: input.packIds,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    metadata: {},
  }
}

function synthesizeStandingLanes(
  companyId: string,
  graph: CompanyGraph,
  operatingModel: OperatingModel,
  org: DynamicOrg,
  packs: PackManifest[],
  now: string,
): StandingLane[] {
  const packsFor = (laneType: StandingLaneType): PackManifest[] =>
    packs.filter(pack => packSupportsLaneType(pack, laneType))
  const packIdsFor = (laneType: StandingLaneType): string[] =>
    packsFor(laneType).map(pack => pack.id)
  const connectorsFor = (laneType: StandingLaneType): string[] =>
    dedupe(packsFor(laneType).flatMap(pack => pack.requiredConnectors))
  const artifactsFor = (laneType: StandingLaneType): StandingLane['expectedArtifactKinds'] =>
    dedupe(packsFor(laneType).flatMap(pack => pack.expectedArtifactKinds))

  const growthOwner = chooseOwnerRole(org, 'gtm')
  const contentOwner = chooseOwnerRole(org, 'content')
  const customerOpsOwner = chooseOwnerRole(org, 'support')
  const businessOpsOwner = chooseOwnerRole(org, 'ops')
  const pmOwner = chooseOwnerRole(org, 'pm')

  const lanes: StandingLane[] = [
    buildStandingLane(companyId, now, {
      type: 'GrowthLane',
      title: 'Growth lane',
      domain: 'gtm',
      objective:
        'Own recurring market, positioning, and demand work that turns public business context into weekly growth motions.',
      cadence: 'weekly',
      inputs: ['company_graph', 'operating_model', 'public_web'],
      ownerAgentId: growthOwner.id,
      runtimeOwner: 'claude',
      packIds: packIdsFor('GrowthLane'),
      connectorIds: connectorsFor('GrowthLane'),
      expectedArtifactKinds: artifactsFor('GrowthLane'),
      successCriteria: [
        'Produce a market map, growth plan, or outreach-ready motion the PM can execute.',
        'Avoid generic strategy summaries without clear next actions.',
      ],
    }),
    buildStandingLane(companyId, now, {
      type: 'BusinessOpsLane',
      title: 'Business ops lane',
      domain: 'ops',
      objective:
        'Maintain company memory, connector policy, and operational systems so the PM can run the business without leaning on the owner.',
      cadence: 'weekly',
      inputs: ['company_graph', 'operating_model', 'connector_policies', 'exceptions'],
      ownerAgentId: businessOpsOwner.id,
      runtimeOwner: connectorsFor('BusinessOpsLane').length > 0 ? 'either' : 'claude',
      packIds: packIdsFor('BusinessOpsLane'),
      connectorIds: connectorsFor('BusinessOpsLane'),
      expectedArtifactKinds: artifactsFor('BusinessOpsLane'),
      successCriteria: [
        'Keep company memory current and propose the next connector unlock only when it enables real recurring work.',
        'Produce process or execution artifacts, not abstract implementation ideas.',
      ],
    }),
    buildStandingLane(companyId, now, {
      type: 'ExecutiveBriefLane',
      title: 'Executive brief lane',
      domain: 'pm',
      objective:
        'Prepare the weekly PM brief that summarizes outcomes, blockers, and next actions without exposing specialist churn.',
      cadence: 'weekly',
      inputs: ['lane_outcomes', 'exceptions', 'gaps', 'connector_policies'],
      ownerAgentId: pmOwner.id,
      runtimeOwner: 'claude',
      packIds: packIdsFor('ExecutiveBriefLane'),
      connectorIds: connectorsFor('ExecutiveBriefLane'),
      expectedArtifactKinds: artifactsFor('ExecutiveBriefLane'),
      successCriteria: [
        'Ship an owner-usable executive brief every cycle.',
      ],
    }),
  ]

  if (operatingModel.recurringLaneNeeds.includes('ContentLane')) {
    lanes.push(
      buildStandingLane(companyId, now, {
        type: 'ContentLane',
        title: 'Content lane',
        domain: 'content',
        objective:
          'Own the recurring content and SEO backlog so the PM can compound public attention without fresh owner prompts.',
        cadence: 'weekly',
        inputs: ['company_graph', 'growth_outputs', 'public_content'],
        ownerAgentId: contentOwner.id,
        runtimeOwner: 'claude',
        packIds: packIdsFor('ContentLane'),
        connectorIds: connectorsFor('ContentLane'),
        expectedArtifactKinds: artifactsFor('ContentLane'),
        successCriteria: [
          'Produce a repeatable backlog of content or SEO tasks tied to business goals.',
        ],
      }),
    )
  }

  if (operatingModel.recurringLaneNeeds.includes('CustomerOpsLane')) {
    lanes.push(
      buildStandingLane(companyId, now, {
        type: 'CustomerOpsLane',
        title: 'Customer ops lane',
        domain: 'support',
        objective:
          'Own recurring customer and client operations work such as FAQ gaps, reviews, follow-up loops, and service quality.',
        cadence: 'weekly',
        inputs: ['company_graph', 'support_surface', 'customer_feedback'],
        ownerAgentId: customerOpsOwner.id,
        runtimeOwner: connectorsFor('CustomerOpsLane').length > 0 ? 'either' : 'claude',
        packIds: packIdsFor('CustomerOpsLane'),
        connectorIds: connectorsFor('CustomerOpsLane'),
        expectedArtifactKinds: artifactsFor('CustomerOpsLane'),
        successCriteria: [
          'Produce customer-ops outputs with clear follow-up actions instead of generic audits.',
        ],
      }),
    )
  }

  return lanes.map(lane => ({
    ...lane,
    metadata: {
      ...lane.metadata,
      businessArchetype: graph.businessArchetype,
    },
  }))
}

function mergeStandingLaneState(
  existing: StandingLane | undefined,
  next: StandingLane,
): StandingLane {
  if (!existing) {
    return next
  }
  return {
    ...next,
    status: existing.status,
    createdAt: existing.createdAt,
    metadata: {
      ...next.metadata,
      ...existing.metadata,
    },
  }
}

function buildLaneWorkstreams(
  companyId: string,
  graph: CompanyGraph,
  lanes: StandingLane[],
  packs: PackManifest[],
  connectorPolicies: ConnectorPolicy[],
  now: string,
): WorkstreamSpec[] {
  const connectorStatus = new Map(
    connectorPolicies.map(policy => [policy.connector, policy.status]),
  )
  const lanePacks = (lane: StandingLane): PackManifest[] =>
    packs.filter(pack => lane.packIds.includes(pack.id))
  const runnablePacks = (lane: StandingLane): PackManifest[] =>
    lanePacks(lane).filter(
      pack =>
        pack.requiredConnectors.length === 0 ||
        pack.requiredConnectors.every(
          connector => connectorStatus.get(connector) === 'connected',
        ),
    )
  const preferredAgent = (
    lane: StandingLane,
    activePacks: PackManifest[],
  ): Exclude<HarnessAgentKind, 'either'> | 'either' => {
    if (lane.type === 'ExecutiveBriefLane') {
      return 'claude'
    }
    const codexPack = activePacks.find(pack => choosePreferredRuntime(pack) === 'codex')
    if (codexPack) {
      return 'codex'
    }
    return lane.runtimeOwner === 'either' ? 'claude' : lane.runtimeOwner
  }
  const workstreams: WorkstreamSpec[] = []

  for (const lane of lanes) {
    const activePacks = runnablePacks(lane)
    const selectedPacks = activePacks.length > 0 ? activePacks : lanePacks(lane)
    const packIds = dedupe(selectedPacks.map(pack => pack.id))
    const preferredAgentKind = preferredAgent(lane, activePacks)
    const jobId =
      lane.type === 'ExecutiveBriefLane'
        ? 'pm-executive-brief'
        : preferredAgentKind === 'codex'
          ? 'pm-company-implementation'
          : 'pm-company-research'
    const title =
      lane.type === 'ExecutiveBriefLane'
        ? `Executive brief for ${graph.companyName}`
        : lane.type === 'BusinessOpsLane'
          ? `Company system foundations for ${graph.companyName}`
          : lane.type === 'GrowthLane'
            ? `Growth lane sprint for ${graph.companyName}`
            : lane.type === 'ContentLane'
              ? `Content backlog for ${graph.companyName}`
              : `Customer ops audit for ${graph.companyName}`

    workstreams.push({
      id: createStableId(companyId, 'workstream', lane.type),
      companyId,
      title,
      domain: lane.domain,
      objective: lane.objective,
      ownerAgentId: lane.ownerAgentId,
      preferredAgentKind,
      status: 'planned',
      packIds,
      laneId: lane.id,
      jobId,
      createdAt: now,
      updatedAt: now,
      metadata: {
        websiteUrl: graph.websiteUrl,
        cadence: lane.cadence,
        laneType: lane.type,
        expectedArtifactKinds: lane.expectedArtifactKinds,
        connectorIds: lane.connectorIds,
        blockedConnectors: lane.connectorIds.filter(
          connector => connectorStatus.get(connector) !== 'connected',
        ),
        packSummary: summarizePackTitles(selectedPacks),
      },
    })
  }

  return workstreams
}

function buildConnectorRecommendations(
  companyId: string,
  graph: CompanyGraph,
  lanes: StandingLane[],
  packs: PackManifest[],
  now: string,
): ConnectorUnlockRecommendation[] {
  const packTitles = summarizePackTitles(packs)
  return recommendedConnectorsForCompany(graph).map(connector => ({
    id: createStableId(companyId, 'connector', connector),
    companyId,
    connector,
    reason:
      connector === 'github'
        ? 'Technical signals suggest code or automation work will compound fastest after the PM proves value from public-web analysis.'
        : connector === 'crm'
          ? 'A sales motion is evident, so CRM data is the next high-leverage unlock after the PM ships the first GTM outputs.'
          : connector === 'website-cms'
            ? 'Publishing content or profile updates directly will let the PM turn planning into recurring outward-facing execution.'
            : connector === 'docs-drive'
              ? 'Shared docs and trackers are the smallest unlock for reusable operating artifacts and recurring PM follow-through.'
          : `This is the next smallest connector that unlocks more of the active PM workstreams (${packTitles}).`,
    unlocks: packs
      .filter(pack => pack.requiredConnectors.includes(connector))
      .map(pack => pack.title),
    status: 'pending',
    recommendedAt: now,
    metadata: {
      laneTypes: lanes
        .filter(lane => lane.connectorIds.includes(connector))
        .map(lane => lane.type),
    },
  }))
}

function mergeConnectorPolicyState(
  existing: ConnectorPolicy | undefined,
  next: ConnectorPolicy,
  recommendation: ConnectorUnlockRecommendation | undefined,
): ConnectorPolicy {
  if (!existing) {
    return {
      ...next,
      status:
        recommendation?.status === 'dismissed'
          ? 'dismissed'
          : recommendation?.status === 'accepted'
            ? 'accepted'
            : next.status,
    }
  }
  return {
    ...next,
    status:
      existing.status === 'connected'
        ? 'connected'
        : recommendation?.status === 'dismissed'
          ? 'dismissed'
          : recommendation?.status === 'accepted'
            ? 'accepted'
            : existing.status,
    createdAt: existing.createdAt,
    metadata: {
      ...next.metadata,
      ...existing.metadata,
    },
  }
}

function buildConnectorPolicies(
  companyId: string,
  recommendations: ConnectorUnlockRecommendation[],
  lanes: StandingLane[],
  now: string,
): ConnectorPolicy[] {
  return recommendations.map(recommendation => ({
    id: createStableId(companyId, 'connector-policy', recommendation.connector),
    companyId,
    connector: recommendation.connector,
    status:
      recommendation.status === 'dismissed'
        ? 'dismissed'
        : recommendation.status === 'accepted'
          ? 'accepted'
          : 'recommended',
    autonomyMode: 'exception-only',
    reason: recommendation.reason,
    laneTypes: lanes
      .filter(lane => lane.connectorIds.includes(recommendation.connector))
      .map(lane => lane.type),
    createdAt: now,
    updatedAt: now,
    metadata: {},
  }))
}

function classifyGapKindFromJob(
  job: HarnessRuntimeState['jobs'][string] | undefined,
): CompanyGap['kind'] {
  if (!job) {
    return 'platform'
  }
  const tags = new Set(job.failureTags)
  const summary = (job.outcomeSummary ?? '').toLowerCase()
  if (
    tags.has('lease_expired') ||
    tags.has('bootstrap_failed') ||
    tags.has('verification_infrastructure_failure') ||
    tags.has('remote_dispatch_failed') ||
    tags.has('remote_auth_failed') ||
    tags.has('runtime_error') ||
    summary.includes('macro is not defined') ||
    summary.includes('failed to fetch environments') ||
    summary.includes('401 unauthorized') ||
    summary.includes('authentication failed')
  ) {
    return 'platform'
  }
  if (
    Object.values(job.metadata).some(value =>
      typeof value === 'string' && value.toLowerCase().includes('pack'),
    )
  ) {
    return 'pack'
  }
  return 'product'
}

function summarizeGapForOwner(
  job: HarnessRuntimeState['jobs'][string] | undefined,
  workstream: WorkstreamSpec,
): string {
  const rawSummary = job?.outcomeSummary?.trim()
  if (!rawSummary) {
    return `Workstream ${workstream.title} stalled before producing a usable deliverable.`
  }

  const lower = rawSummary.toLowerCase()
  if (lower.includes('macro is not defined')) {
    return 'The harness worker launched the wrong CLI entrypoint and failed before producing the deliverable. The platform path has been fixed and the workstream has been requeued.'
  }
  if (
    lower.includes('failed to fetch environments') ||
    lower.includes('401 unauthorized') ||
    lower.includes('authentication failed')
  ) {
    return 'Remote dispatch could not authenticate with the execution environment service, so the workstream could not start normally.'
  }
  return rawSummary
}

function jobNeedsOwnerAction(
  job: HarnessRuntimeState['jobs'][string] | undefined,
): boolean {
  if (!job) {
    return false
  }
  const tags = new Set(job.failureTags.map(tag => tag.toLowerCase()))
  if (
    [
      'owner_action_required',
      'approval_required',
      'credential_required',
      'connector_required',
      'missing_access',
    ].some(tag => tags.has(tag))
  ) {
    return true
  }

  const hints = [
    job.outcomeSummary,
    ...Object.values(job.metadata).map(value =>
      typeof value === 'string' ? value : JSON.stringify(value),
    ),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return [
    'owner',
    'approval',
    'connector',
    'credential',
    'authorize',
    'login',
    'permission',
  ].some(token => hints.includes(token))
}

function appendCompanyEventLedger(
  state: HarnessRuntimeState,
  eventName: string,
  companyId: string,
  recordedAt: string,
  metadata: Record<string, unknown>,
): void {
  state.eventLedger = [
    {
      id: createStableId(eventName, companyId, recordedAt, JSON.stringify(metadata)),
      eventName,
      recordedAt,
      repoId: state.companyOps.companies[companyId]?.repoId,
      metadata: {
        companyId,
        ...metadata,
      },
    },
    ...state.eventLedger,
  ].slice(0, 500)
}

function upsertExceptionForWorkstream(
  state: HarnessRuntimeState,
  company: CompanyRecord,
  workstream: WorkstreamSpec,
  job: HarnessRuntimeState['jobs'][string],
  now: string,
): string {
  const existing = Object.values(state.companyOps.exceptions).find(
    exception =>
      exception.companyId === company.id &&
      exception.metadata.workstreamId === workstream.id &&
      exception.metadata.sourceJobInstanceId === job.instanceId,
  )
  if (existing) {
    if (existing.status === 'open') {
      return existing.id
    }
    existing.metadata = {
      ...existing.metadata,
      lastReobservedAt: now,
    }
    return existing.id
  }

  const exceptionId = createStableId(
    company.id,
    workstream.id,
    job.instanceId,
    'owner-exception',
  )
  state.companyOps.exceptions[exceptionId] = {
    id: exceptionId,
    companyId: company.id,
    severity:
      job.status === 'failed'
        ? 'high'
        : job.failureTags.includes('approval_required')
          ? 'warn'
          : 'warn',
    title: `Owner input needed for ${workstream.title}`,
    summary:
      job.outcomeSummary ??
      `The PM needs owner help before ${workstream.title} can continue.`,
    status: 'open',
    requiresOwner: true,
    createdAt: now,
    metadata: {
      laneId: workstream.laneId,
      workstreamId: workstream.id,
      sourceJobInstanceId: job.instanceId,
      jobId: job.jobId,
      failureTags: job.failureTags,
    },
  }
  if (!company.exceptionIds.includes(exceptionId)) {
    company.exceptionIds.push(exceptionId)
  }
  appendCompanyEventLedger(state, 'cc_company_exception_created', company.id, now, {
    exceptionId,
    workstreamId: workstream.id,
    jobInstanceId: job.instanceId,
  })
  return exceptionId
}

function upsertGapForWorkstream(
  state: HarnessRuntimeState,
  company: CompanyRecord,
  workstream: WorkstreamSpec,
  job: HarnessRuntimeState['jobs'][string] | undefined,
  now: string,
): string | null {
  if (!job || (job.status !== 'failed' && job.status !== 'blocked')) {
    return null
  }
  if (jobNeedsOwnerAction(job)) {
    return upsertExceptionForWorkstream(state, company, workstream, job, now)
  }
  const existing = Object.values(state.companyOps.gaps).find(
    gap =>
      gap.companyId === company.id &&
      gap.laneId === workstream.laneId &&
      gap.workstreamId === workstream.id &&
      gap.sourceJobInstanceId === job.instanceId &&
      gap.status === 'open',
  )
  if (existing) {
    existing.kind = classifyGapKindFromJob(job)
    existing.summary = summarizeGapForOwner(job, workstream)
    existing.metadata = {
      ...existing.metadata,
      failureTags: job.failureTags,
      jobId: job.jobId,
      refreshedAt: now,
    }
    return existing.id
  }
  const kind = classifyGapKindFromJob(job)
  const gapId = createStableId(company.id, workstream.id, job.instanceId, kind)
  state.companyOps.gaps[gapId] = {
    id: gapId,
    companyId: company.id,
    laneId: workstream.laneId,
    workstreamId: workstream.id,
    kind,
    status: 'open',
    summary: summarizeGapForOwner(job, workstream),
    sourceJobInstanceId: job.instanceId,
    createdAt: now,
    metadata: {
      laneId: workstream.laneId,
      failureTags: job.failureTags,
      jobId: job.jobId,
    },
  }
  if (!company.gapIds.includes(gapId)) {
    company.gapIds.push(gapId)
  }
  appendCompanyEventLedger(state, 'cc_company_gap_created', company.id, now, {
    gapId,
    workstreamId: workstream.id,
    jobInstanceId: job.instanceId,
    kind,
  })
  return gapId
}

function extractStructuredOutcomePayload(
  summary: string | undefined,
): Record<string, unknown> | null {
  if (!summary) {
    return null
  }

  const trimmed = summary.trim()
  const fencedMatch = trimmed.match(/^```json\s*([\s\S]*?)\s*```$/i)
  const candidate = (fencedMatch?.[1] ?? trimmed).trim()
  try {
    const parsed = JSON.parse(candidate)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function isIntakeOnlyOutcome(summary: string | undefined): boolean {
  const lower = summary?.toLowerCase() ?? ''
  if (
    lower.includes('"phase": "intake"') ||
    lower.includes('"phase":"intake"') ||
    (lower.includes('"proposedactions"') && lower.includes('"nextphase"')) ||
    lower.includes('cold-start intake')
  ) {
    return true
  }

  const payload = extractStructuredOutcomePayload(summary)
  if (!payload) {
    return false
  }

  const phase = typeof payload.phase === 'string' ? payload.phase.toLowerCase() : ''
  if (phase === 'intake') {
    return true
  }

  return (
    Array.isArray(payload.proposedActions) &&
    typeof payload.nextPhase === 'string' &&
    !('deliverable' in payload)
  )
}

function isPlaceholderReviewOnlyOutcome(summary: string | undefined): boolean {
  return (
    summary?.trim().toLowerCase() ===
    'review-only job executed without worker session'
  )
}

function buildSyntheticExecutiveBrief(
  state: HarnessRuntimeState,
  company: CompanyRecord,
  now: string,
): string {
  const activeWorkstreams = company.workstreamIds
    .map(workstreamId => state.companyOps.workstreams[workstreamId])
    .filter((workstream): workstream is WorkstreamSpec => Boolean(workstream))
    .filter(workstream => ['queued', 'active', 'blocked'].includes(workstream.status))
    .slice(0, 3)
  const recentWins = company.workstreamIds
    .map(workstreamId => state.companyOps.workstreams[workstreamId])
    .filter((workstream): workstream is WorkstreamSpec => Boolean(workstream))
    .filter(
      workstream =>
        workstream.status === 'completed' &&
        workstream.id !== createStableId(company.id, 'workstream', 'executive-brief') &&
        !isIntakeOnlyOutcome(workstream.lastOutcome ?? workstream.summary) &&
        !isPlaceholderReviewOnlyOutcome(workstream.lastOutcome ?? workstream.summary),
    )
    .slice(0, 3)
  const openGaps = company.gapIds
    .map(gapId => state.companyOps.gaps[gapId])
    .filter((gap): gap is CompanyGap => Boolean(gap) && gap.status === 'open')
    .slice(0, 3)
  const openExceptions = company.exceptionIds
    .map(exceptionId => state.companyOps.exceptions[exceptionId])
    .filter(
      (exception): exception is OwnerException =>
        Boolean(exception) && exception.status === 'open',
    )
    .slice(0, 3)
  const nextConnectors = company.connectorRecommendationIds
    .map(recommendationId => state.companyOps.connectorRecommendations[recommendationId])
    .filter(
      (recommendation): recommendation is ConnectorUnlockRecommendation =>
        Boolean(recommendation) && recommendation.status === 'pending',
    )
    .slice(0, 2)

  const formatList = (values: string[], fallback: string): string =>
    values.length > 0 ? values.map(value => `- ${value}`).join('\n') : `- ${fallback}`

  return [
    `# Executive Brief — ${company.companyName}`,
    `Date: ${now.slice(0, 10)}`,
    '',
    '## Progress',
    formatList(
      recentWins.map(workstream => workstream.title),
      'No fully useful PM workstreams have completed yet.',
    ),
    '',
    '## Active Focus',
    formatList(
      activeWorkstreams.map(
        workstream => `${workstream.title} [${workstream.status}]`,
      ),
      'No active workstreams right now.',
    ),
    '',
    '## Risks',
    formatList(
      [
        ...openExceptions.map(exception => exception.title),
        ...openGaps.map(gap => `${gap.kind}: ${truncateText(gap.summary, 140)}`),
      ],
      'No open owner exceptions or platform/product gaps.',
    ),
    '',
    '## Next Unlocks',
    formatList(
      nextConnectors.map(
        recommendation =>
          `${recommendation.connector}: ${truncateText(recommendation.reason, 140)}`,
      ),
      'No connector unlock is urgent yet.',
    ),
  ].join('\n')
}

type CompletedWorkstreamAssessment = {
  useful: boolean
  summary: string
  failureTags: string[]
  artifactKind?: UsefulArtifact['artifactKind']
  ownerTouchRequired: boolean
}

function includesAtLeast(value: string, tokens: string[], minimum: number): boolean {
  const lower = value.toLowerCase()
  let matches = 0
  for (const token of tokens) {
    if (lower.includes(token)) {
      matches += 1
    }
    if (matches >= minimum) {
      return true
    }
  }
  return false
}

function inferArtifactKindForWorkstream(
  workstream: WorkstreamSpec,
): UsefulArtifact['artifactKind'] | undefined {
  const expectedArtifactKinds = Array.isArray(workstream.metadata.expectedArtifactKinds)
    ? workstream.metadata.expectedArtifactKinds.filter(
        value => typeof value === 'string',
      )
    : []
  const expected = expectedArtifactKinds[0]
  switch (expected) {
    case 'company-brief':
    case 'market-map':
    case 'growth-plan':
    case 'content-backlog':
    case 'customer-ops-audit':
    case 'ops-playbook':
    case 'executive-brief':
    case 'implementation-artifact':
      return expected
    default:
      return workstream.jobId === 'pm-executive-brief'
        ? 'executive-brief'
        : workstream.domain === 'content'
          ? 'content-backlog'
          : workstream.domain === 'support'
            ? 'customer-ops-audit'
            : workstream.domain === 'ops'
              ? 'ops-playbook'
              : workstream.domain === 'gtm' || workstream.domain === 'market-intel'
                ? 'growth-plan'
                : 'company-brief'
  }
}

function validateArtifactText(
  artifactKind: UsefulArtifact['artifactKind'],
  summary: string,
): boolean {
  if (summary.trim().length < 160) {
    return false
  }

  switch (artifactKind) {
    case 'executive-brief':
      return includesAtLeast(summary, ['progress', 'risks', 'next', 'brief'], 2)
    case 'content-backlog':
      return includesAtLeast(
        summary,
        ['content', 'backlog', 'seo', 'calendar', 'topics', 'reels', 'posts'],
        2,
      )
    case 'customer-ops-audit':
      return includesAtLeast(
        summary,
        ['customer', 'support', 'faq', 'reviews', 'follow-up', 'onboarding'],
        2,
      )
    case 'ops-playbook':
    case 'implementation-artifact':
      return includesAtLeast(
        summary,
        ['workflow', 'system', 'process', 'automation', 'tracker', 'crm', 'playbook'],
        2,
      )
    case 'market-map':
      return includesAtLeast(
        summary,
        ['competitor', 'positioning', 'market', 'opportunity'],
        2,
      )
    case 'growth-plan':
      return includesAtLeast(
        summary,
        ['channel', 'outreach', 'growth', 'pipeline', 'leads', 'campaign'],
        2,
      )
    case 'company-brief':
    default:
      return includesAtLeast(
        summary,
        ['company', 'offers', 'customers', 'channels', 'operations', 'next'],
        2,
      )
  }
}

function assessCompletedWorkstreamOutput(
  state: HarnessRuntimeState,
  company: CompanyRecord,
  workstream: WorkstreamSpec,
  job: HarnessRuntimeState['jobs'][string],
  now: string,
): CompletedWorkstreamAssessment {
  const rawSummary = job.outcomeSummary?.trim()
  if (!rawSummary) {
    return {
      useful: false,
      summary:
        'Workstream finished without an owner-visible deliverable summary. Requeueing for a real PM output.',
      failureTags: ['missing_deliverable_summary', 'insufficient_deliverable'],
      ownerTouchRequired: false,
    }
  }

  if (
    workstream.jobId === 'pm-executive-brief' &&
    isPlaceholderReviewOnlyOutcome(rawSummary)
  ) {
    return {
      useful: true,
      summary: buildSyntheticExecutiveBrief(state, company, now),
      failureTags: [],
      artifactKind: 'executive-brief',
      ownerTouchRequired: false,
    }
  }

  if (isIntakeOnlyOutcome(rawSummary)) {
    return {
      useful: false,
      summary:
        'Workstream only produced intake-phase planning instead of the requested deliverable. Requeueing for a real PM output.',
      failureTags: ['intake_only_output', 'insufficient_deliverable'],
      ownerTouchRequired: false,
    }
  }

  if (isPlaceholderReviewOnlyOutcome(rawSummary)) {
    return {
      useful: false,
      summary:
        'Workstream exited without a worker session or owner-visible deliverable. Requeueing for a real result.',
      failureTags: ['placeholder_review_output', 'insufficient_deliverable'],
      ownerTouchRequired: false,
    }
  }

  const artifactKind = inferArtifactKindForWorkstream(workstream)
  if (!validateArtifactText(artifactKind, rawSummary)) {
    return {
      useful: false,
      summary:
        'Workstream completed, but the output was still too weak to count as a durable business artifact. Requeueing for a stronger result.',
      failureTags: ['artifact_validation_failed', 'insufficient_deliverable'],
      artifactKind,
      ownerTouchRequired: false,
    }
  }

  return {
    useful: true,
    summary: rawSummary,
    failureTags: [],
    artifactKind,
    ownerTouchRequired: jobNeedsOwnerAction(job),
  }
}

function upsertLaneRun(
  state: HarnessRuntimeState,
  company: CompanyRecord,
  workstream: WorkstreamSpec,
  job: HarnessRuntimeState['jobs'][string],
  now: string,
): LaneRun | null {
  if (!workstream.laneId) {
    return null
  }
  const laneRunId = createStableId(workstream.laneId, job.instanceId, 'lane-run')
  const existing = state.companyOps.laneRuns[laneRunId]
  const nextStatus =
    job.status === 'queued'
      ? 'queued'
      : job.status === 'leased' || job.status === 'running'
        ? 'active'
        : job.status
  const laneRun: LaneRun = {
    id: laneRunId,
    companyId: company.id,
    laneId: workstream.laneId,
    workstreamId: workstream.id,
    jobInstanceId: job.instanceId,
    status: nextStatus,
    usefulArtifactId: existing?.usefulArtifactId,
    usefulOutput: existing?.usefulOutput ?? false,
    ownerTouchRequired: existing?.ownerTouchRequired ?? false,
    startedAt: existing?.startedAt ?? job.startedAt ?? now,
    completedAt:
      nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'blocked'
        ? (job.completedAt ?? now)
        : existing?.completedAt,
    outcomeSummary: job.outcomeSummary,
    metadata: {
      ...(existing?.metadata ?? {}),
      preferredAgentKind: workstream.preferredAgentKind,
    },
  }
  state.companyOps.laneRuns[laneRunId] = laneRun
  if (!company.laneRunIds.includes(laneRunId)) {
    company.laneRunIds.push(laneRunId)
  }
  return laneRun
}

function recordUsefulArtifact(
  state: HarnessRuntimeState,
  company: CompanyRecord,
  workstream: WorkstreamSpec,
  laneRun: LaneRun | null,
  summary: string,
  artifactKind: UsefulArtifact['artifactKind'] | undefined,
  now: string,
): UsefulArtifact | null {
  if (!workstream.laneId || !laneRun || !artifactKind) {
    return null
  }
  const artifactId = createStableId(workstream.laneId, laneRun.id, artifactKind)
  const artifact: UsefulArtifact = {
    id: artifactId,
    companyId: company.id,
    laneId: workstream.laneId,
    runId: laneRun.id,
    workstreamId: workstream.id,
    artifactKind,
    title: workstream.title,
    summary: truncateText(summary, 240),
    content: summary,
    outputPath: undefined,
    usefulOutput: true,
    ownerTouchRequired: laneRun.ownerTouchRequired,
    createdAt: laneRun.completedAt ?? now,
    metadata: {
      domain: workstream.domain,
      preferredAgentKind: workstream.preferredAgentKind,
    },
  }
  state.companyOps.usefulArtifacts[artifactId] = artifact
  if (!company.usefulArtifactIds.includes(artifactId)) {
    company.usefulArtifactIds.push(artifactId)
  }
  workstream.latestArtifactId = artifactId
  laneRun.usefulArtifactId = artifactId
  laneRun.usefulOutput = true
  return artifact
}

function syncCompanyStateFromHarness(
  state: HarnessRuntimeState,
  companyId: string,
  now: string,
): void {
  const company = state.companyOps.companies[companyId]
  if (!company) {
    return
  }

  let successCount = 0
  let failureCount = 0
  const domainSuccessCounts: Record<string, number> = {}
  const executionFailureCountsByRuntime: Record<string, number> = {}

  for (const workstreamId of company.workstreamIds) {
    const workstream = state.companyOps.workstreams[workstreamId]
    if (!workstream) {
      continue
    }
    const previousStatus = workstream.status
    const job = workstream.jobInstanceId
      ? state.jobs[workstream.jobInstanceId]
      : undefined
    if (!job) {
      continue
    }
    const laneRun = upsertLaneRun(state, company, workstream, job, now)
    if (job.status === 'queued') {
      workstream.status = 'queued'
    } else if (job.status === 'leased' || job.status === 'running') {
      workstream.status = 'active'
    } else if (job.status === 'completed') {
      const completedAssessment = assessCompletedWorkstreamOutput(
        state,
        company,
        workstream,
        job,
        now,
      )
      if (completedAssessment.useful) {
        workstream.status = 'completed'
        workstream.completedAt = workstream.completedAt ?? job.completedAt
        if (laneRun) {
          laneRun.status = 'completed'
          laneRun.completedAt = laneRun.completedAt ?? job.completedAt ?? now
          laneRun.outcomeSummary = completedAssessment.summary
          laneRun.ownerTouchRequired = completedAssessment.ownerTouchRequired
        }
        const artifact = recordUsefulArtifact(
          state,
          company,
          workstream,
          laneRun,
          completedAssessment.summary,
          completedAssessment.artifactKind,
          now,
        )
        for (const gapId of company.gapIds) {
          const gap = state.companyOps.gaps[gapId]
          if (
            gap &&
            gap.workstreamId === workstream.id &&
            gap.status === 'open'
          ) {
            gap.status = 'resolved'
            gap.metadata = {
              ...gap.metadata,
              resolvedByJobInstanceId: job.instanceId,
              resolvedAt: now,
            }
          }
        }
        for (const exceptionId of company.exceptionIds) {
          const exception = state.companyOps.exceptions[exceptionId]
          if (
            exception &&
            exception.metadata.workstreamId === workstream.id &&
            exception.status === 'open'
          ) {
            exception.status = 'resolved'
            exception.resolvedAt = now
            exception.metadata = {
              ...exception.metadata,
              resolution:
                exception.metadata.resolution ??
                'Resolved automatically after the workstream completed.',
              resolvedByJobInstanceId: job.instanceId,
            }
          }
        }
        successCount += 1
        domainSuccessCounts[workstream.domain] =
          (domainSuccessCounts[workstream.domain] ?? 0) + 1
        company.metrics.firstUsefulOutputAt =
          company.metrics.firstUsefulOutputAt ?? job.completedAt
        if (artifact) {
          appendCompanyEventLedger(
            state,
            'cc_company_useful_artifact_created',
            company.id,
            now,
            {
              workstreamId: workstream.id,
              artifactId: artifact.id,
              artifactKind: artifact.artifactKind,
            },
          )
        }
      } else {
        workstream.status = 'blocked'
        failureCount += 1
        executionFailureCountsByRuntime[workstream.preferredAgentKind] =
          (executionFailureCountsByRuntime[workstream.preferredAgentKind] ?? 0) + 1
        if (laneRun) {
          laneRun.status = 'blocked'
          laneRun.completedAt = laneRun.completedAt ?? job.completedAt ?? now
          laneRun.outcomeSummary = completedAssessment.summary
          laneRun.usefulOutput = false
          laneRun.ownerTouchRequired = completedAssessment.ownerTouchRequired
        }
        upsertGapForWorkstream(
          state,
          company,
          workstream,
          {
            ...job,
            status: 'blocked',
            outcomeSummary: completedAssessment.summary,
            failureTags: dedupe([
              ...job.failureTags,
              ...completedAssessment.failureTags,
            ]),
          },
          now,
        )
      }
      workstream.summary = completedAssessment.summary
      workstream.lastOutcome = completedAssessment.summary
      workstream.metadata = {
        ...workstream.metadata,
        rawOutcomeSummary: job.outcomeSummary,
        usefulOutput: completedAssessment.useful,
        artifactKind: completedAssessment.artifactKind,
      }
    } else if (job.status === 'failed') {
      workstream.status = 'failed'
      failureCount += 1
      executionFailureCountsByRuntime[workstream.preferredAgentKind] =
        (executionFailureCountsByRuntime[workstream.preferredAgentKind] ?? 0) + 1
      if (laneRun) {
        laneRun.status = 'failed'
        laneRun.completedAt = laneRun.completedAt ?? job.completedAt ?? now
        laneRun.outcomeSummary = job.outcomeSummary
      }
      upsertGapForWorkstream(state, company, workstream, job, now)
    } else if (job.status === 'blocked') {
      workstream.status = 'blocked'
      failureCount += 1
      executionFailureCountsByRuntime[workstream.preferredAgentKind] =
        (executionFailureCountsByRuntime[workstream.preferredAgentKind] ?? 0) + 1
      if (laneRun) {
        laneRun.status = 'blocked'
        laneRun.completedAt = laneRun.completedAt ?? job.completedAt ?? now
        laneRun.outcomeSummary = job.outcomeSummary
      }
      upsertGapForWorkstream(state, company, workstream, job, now)
    }
    if (job.status !== 'completed') {
      workstream.summary = job.outcomeSummary
      workstream.lastOutcome = job.outcomeSummary
    }
    workstream.updatedAt = now
    if (previousStatus !== workstream.status) {
      appendCompanyEventLedger(
        state,
        workstream.status === 'completed'
          ? 'cc_company_workstream_completed'
          : 'cc_company_workstream_updated',
        company.id,
        now,
        {
          workstreamId: workstream.id,
          previousStatus,
          nextStatus: workstream.status,
          jobInstanceId: job.instanceId,
        },
      )
    }
  }

  const gaps = company.gapIds
    .map(gapId => state.companyOps.gaps[gapId])
    .filter((gap): gap is CompanyGap => Boolean(gap))
  const exceptions = company.exceptionIds
    .map(exceptionId => state.companyOps.exceptions[exceptionId])
    .filter((exception): exception is OwnerException => Boolean(exception))
  const standingLanes = company.standingLaneIds
    .map(laneId => state.companyOps.standingLanes[laneId])
    .filter((lane): lane is StandingLane => Boolean(lane))
  const usefulArtifacts = company.usefulArtifactIds
    .map(artifactId => state.companyOps.usefulArtifacts[artifactId])
    .filter((artifact): artifact is UsefulArtifact => Boolean(artifact))
  const completedLaneRuns = company.laneRunIds
    .map(laneRunId => state.companyOps.laneRuns[laneRunId])
    .filter((laneRun): laneRun is LaneRun => Boolean(laneRun))
    .filter(laneRun => laneRun.status === 'completed')
  company.metrics.pmCreatedAgentCount = company.org.roles.length
  company.metrics.pmRetiredAgentCount = company.org.roles.filter(
    role => role.status === 'retired',
  ).length
  company.metrics.activeLaneCount = standingLanes.filter(
    lane => lane.status === 'active',
  ).length
  company.metrics.workstreamSuccessCount = successCount
  company.metrics.workstreamFailureCount = failureCount
  company.metrics.usefulArtifactCount = usefulArtifacts.length
  company.metrics.usefulArtifactsThisWeek = usefulArtifacts.filter(
    artifact => getWeekBucket(artifact.createdAt) === getWeekBucket(now),
  ).length
  company.metrics.recurringLaneCompletionRate =
    company.laneRunIds.length > 0
      ? completedLaneRuns.filter(laneRun => laneRun.usefulOutput).length /
        company.laneRunIds.length
      : 0
  company.metrics.repeatedExceptionCount = exceptions.filter(
    exception => exception.status === 'open',
  ).length
  company.metrics.platformGapCount = gaps.filter(gap => gap.kind === 'platform').length
  company.metrics.packGapCount = gaps.filter(gap => gap.kind === 'pack').length
  company.metrics.productGapCount = gaps.filter(gap => gap.kind === 'product').length
  company.metrics.domainSuccessCounts = domainSuccessCounts
  company.metrics.executionFailureCountsByRuntime = executionFailureCountsByRuntime
  company.updatedAt = now
}

async function discoverWebsiteSignals(websiteUrl: string): Promise<PageSignal[]> {
  const normalizedWebsiteUrl = normalizeUrl(websiteUrl)
  const host = getHost(normalizedWebsiteUrl)
  if (isSocialHost(host)) {
    const socialSignal = await fetchSocialSignal(normalizedWebsiteUrl)
    return socialSignal ? [socialSignal] : []
  }
  const homepageFetch = await fetchWebsitePage(normalizedWebsiteUrl)
  if (!homepageFetch) {
    return []
  }

  const canonicalUrls = WEBSITE_DISCOVERY_PATHS.map(pathname =>
    new URL(pathname, normalizedWebsiteUrl).toString(),
  )
  const sitemapUrls = await fetchSitemapCandidates(normalizedWebsiteUrl, host)
  const linkedUrls = extractSameHostLinks(
    homepageFetch.html,
    normalizedWebsiteUrl,
    host,
  )

  const nextUrls = dedupe([
    normalizedWebsiteUrl,
    ...canonicalUrls,
    ...linkedUrls,
    ...sitemapUrls,
  ])
    .filter(url => getHost(url) === host)
    .filter(url => url !== normalizedWebsiteUrl)
    .sort((left, right) => rankWebsiteUrl(left) - rankWebsiteUrl(right))
    .slice(0, Math.max(0, MAX_WEBSITE_PAGES - 1))

  const fetched = await Promise.all(nextUrls.map(url => fetchWebsitePage(url)))
  return [
    homepageFetch.signal,
    ...fetched
      .filter((item): item is WebsitePageFetch => Boolean(item))
      .map(item => item.signal),
  ]
}

async function buildCompanySignals(
  input: CompanyOnboardInput,
): Promise<PageSignal[]> {
  const websiteUrl = normalizeUrl(input.websiteUrl)
  const socialUrls = (input.socialUrls ?? [])
    .map(normalizeUrl)
    .filter((url, index, array) => array.indexOf(url) === index)
    .filter(url => SOCIAL_HINTS.some(hint => getHost(url).includes(hint)))
  const [websiteSignals, socialSignals] = await Promise.all([
    discoverWebsiteSignals(websiteUrl),
    Promise.all(socialUrls.map(fetchSocialSignal)),
  ])
  return [...websiteSignals, ...socialSignals.filter((signal): signal is PageSignal => Boolean(signal))]
}

function buildPmResponse(snapshot: CompanyMissionControl, ownerText: string): string {
  if (!snapshot.company || !snapshot.pmAgent) {
    return 'No company is onboarded yet. Start with `claude company onboard <url>` and I will take it from there.'
  }
  const topLanes = snapshot.standingLanes.slice(0, 3).map(
    laneCard =>
      `${laneCard.lane.title} (${laneCard.activeWorkstream?.status ?? laneCard.connectorReadiness})`,
  )
  const nextConnector = snapshot.connectorRecommendations.find(
    recommendation => recommendation.status === 'pending',
  )
  const exceptionLine =
    snapshot.exceptions.length > 0
      ? `Open exceptions: ${snapshot.exceptions.map(exception => exception.title).join(', ')}.`
      : 'No owner exceptions are open.'
  return [
    `${snapshot.pmAgent.name} heard: "${truncateText(ownerText, 160)}"`,
    `Current lanes: ${topLanes.join('; ') || 'no standing lanes yet'}.`,
    exceptionLine,
    nextConnector
      ? `Next connector I recommend only after the first public-web wins: ${nextConnector.connector}.`
      : 'No connector recommendation is urgent yet.',
  ].join(' ')
}

function summarizeMissionControl(snapshot: Omit<CompanyMissionControl, 'summary'>): string {
  if (!snapshot.company || !snapshot.pmAgent) {
    return 'No PM-led company is onboarded yet.'
  }
  return [
    `${snapshot.company.companyName} (${snapshot.company.businessArchetype})`,
    `${snapshot.pmAgent.title} is the only owner-facing operator.`,
    `${snapshot.standingLanes.length} standing lanes are active.`,
    `${snapshot.workstreams.filter(workstream => workstream.status === 'active' || workstream.status === 'queued').length} active or queued workstreams.`,
    `${snapshot.usefulArtifacts.length} useful artifacts recorded.`,
    `${snapshot.exceptions.filter(exception => exception.status === 'open').length} open owner exceptions.`,
    `${snapshot.gaps.filter(gap => gap.status === 'open').length} open gaps.`,
  ].join(' ')
}

function sortByCreatedAtDesc<
  T extends {
    createdAt?: string
    recommendedAt?: string
    startedAt?: string
    updatedAt?: string
  },
>(
  values: T[],
): T[] {
  return [...values].sort((left, right) =>
    (right.createdAt ?? right.recommendedAt ?? right.startedAt ?? right.updatedAt ?? '').localeCompare(
      left.createdAt ?? left.recommendedAt ?? left.startedAt ?? left.updatedAt ?? '',
    ),
  )
}

function buildPMSnapshot(
  pmAgent: SpecialistAgentRole | null,
  recentPmDecisions: PMDecision[],
  recentOwnerMessages: OwnerMessage[],
): PMSnapshot | null {
  if (!pmAgent) {
    return null
  }
  return {
    agent: pmAgent,
    recentDecisions: recentPmDecisions,
    recentMessages: recentOwnerMessages,
  }
}

function buildWorkstreamCards(
  workstreams: WorkstreamSpec[],
  roles: SpecialistAgentRole[],
  gaps: CompanyGap[],
  exceptions: OwnerException[],
): MissionControlWorkstreamCard[] {
  return workstreams.map(workstream => {
    const linkedGap = gaps.find(
      gap => gap.status === 'open' && gap.workstreamId === workstream.id,
    )
    const linkedException = exceptions.find(
      exception =>
        exception.status === 'open' &&
        exception.metadata.workstreamId === workstream.id,
    )
    return {
      workstream,
      ownerRole:
        roles.find(role => role.id === workstream.ownerAgentId && role.status === 'active') ??
        null,
      latestSummary: workstream.lastOutcome ?? workstream.summary,
      linkedGapId: linkedGap?.id,
      linkedExceptionId: linkedException?.id,
    }
  })
}

function buildStandingLaneCards(
  lanes: StandingLane[],
  roles: SpecialistAgentRole[],
  workstreams: WorkstreamSpec[],
  usefulArtifacts: UsefulArtifact[],
  connectorPolicies: ConnectorPolicy[],
): MissionControlStandingLaneCard[] {
  const connectorStatus = new Map(
    connectorPolicies.map(policy => [policy.connector, policy.status]),
  )
  return lanes.map(lane => {
    const latestArtifact =
      usefulArtifacts
        .filter(artifact => artifact.laneId === lane.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
    const activeWorkstream =
      workstreams
        .filter(workstream => workstream.laneId === lane.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
    const connectorReadiness =
      lane.connectorIds.length === 0
        ? 'ready'
        : lane.connectorIds.every(
              connector => connectorStatus.get(connector) === 'connected',
            )
          ? 'ready'
          : lane.connectorIds.some(
                connector => connectorStatus.get(connector) === 'dismissed',
              )
            ? 'blocked'
            : 'recommended'
    const referenceTimestamp =
      activeWorkstream?.completedAt ??
      latestArtifact?.createdAt ??
      lane.updatedAt ??
      lane.createdAt

    return {
      lane,
      ownerRole:
        roles.find(role => role.id === lane.ownerAgentId && role.status === 'active') ??
        null,
      latestArtifact,
      activeWorkstream,
      nextScheduledAt: addCadenceWindow(referenceTimestamp, lane.cadence),
      connectorReadiness,
    }
  })
}

function buildMissionControlMetrics(
  company: CompanyRecord | null,
  standingLanes: StandingLane[],
  workstreams: WorkstreamSpec[],
  usefulArtifacts: UsefulArtifact[],
  exceptions: OwnerException[],
  gaps: CompanyGap[],
): MissionControlMetrics {
  if (!company) {
    return {
      ownerTouchCount: 0,
      pmCreatedAgentCount: 0,
      pmRetiredAgentCount: 0,
      standingLaneCount: 0,
      activeWorkstreamCount: 0,
      usefulArtifactCount: 0,
      usefulArtifactsThisWeek: 0,
      recurringLaneCompletionRate: 0,
      openExceptionCount: 0,
      gapCounts: {
        product: 0,
        pack: 0,
        platform: 0,
      },
      successCountsByDomain: {},
      executionFailureCountsByRuntime: {},
    }
  }

  return {
    ownerTouchCount: company.metrics.ownerTouchCount,
    pmCreatedAgentCount: company.metrics.pmCreatedAgentCount,
    pmRetiredAgentCount: company.metrics.pmRetiredAgentCount,
    standingLaneCount: standingLanes.length,
    activeWorkstreamCount: workstreams.filter(workstream =>
      ['queued', 'active', 'blocked'].includes(workstream.status),
    ).length,
    usefulArtifactCount: usefulArtifacts.length,
    usefulArtifactsThisWeek: usefulArtifacts.filter(
      artifact => getWeekBucket(artifact.createdAt) === getWeekBucket(nowIso()),
    ).length,
    recurringLaneCompletionRate: company.metrics.recurringLaneCompletionRate,
    openExceptionCount: exceptions.filter(exception => exception.status === 'open')
      .length,
    firstUsefulOutputAt: company.metrics.firstUsefulOutputAt,
    gapCounts: {
      product: gaps.filter(gap => gap.status === 'open' && gap.kind === 'product')
        .length,
      pack: gaps.filter(gap => gap.status === 'open' && gap.kind === 'pack').length,
      platform: gaps.filter(
        gap => gap.status === 'open' && gap.kind === 'platform',
      ).length,
    },
    successCountsByDomain: company.metrics.domainSuccessCounts,
    executionFailureCountsByRuntime:
      company.metrics.executionFailureCountsByRuntime,
  }
}

function getWeekBucket(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86_400_000)
  return `${date.getUTCFullYear()}-W${String(Math.floor(dayOfYear / 7) + 1).padStart(2, '0')}`
}

function shouldEnqueueCompanyWorkstream(
  workstream: WorkstreamSpec,
  job: HarnessRuntimeState['jobs'][string] | undefined,
  reason: 'onboard' | 'refresh',
  now: string,
): boolean {
  const blockedConnectors = Array.isArray(workstream.metadata.blockedConnectors)
    ? workstream.metadata.blockedConnectors.filter(
        value => typeof value === 'string' && value.length > 0,
      )
    : []
  if (blockedConnectors.length > 0) {
    return false
  }
  if (!job) {
    return true
  }
  if (job.status === 'queued' || job.status === 'leased' || job.status === 'running') {
    return false
  }
  if (reason === 'refresh' && (job.status === 'failed' || job.status === 'blocked')) {
    return true
  }
  if (
    reason === 'refresh' &&
    job.status === 'completed' &&
    isIntakeOnlyOutcome(job.outcomeSummary)
  ) {
    return true
  }
  if (
    reason === 'refresh' &&
    job.status === 'completed' &&
    isPlaceholderReviewOnlyOutcome(job.outcomeSummary) &&
    workstream.jobId !== 'pm-executive-brief'
  ) {
    return true
  }
  if (reason === 'refresh' && workstream.laneId && workstream.domain === 'ops') {
    return true
  }
  if (workstream.metadata.cadence === 'daily') {
    const lastCompletedAt = workstream.completedAt ?? job.completedAt ?? job.updatedAt
    return getDayBucket(lastCompletedAt) !== getDayBucket(now)
  }
  if (workstream.metadata.cadence === 'weekly') {
    const lastCompletedAt = workstream.completedAt ?? job.completedAt ?? job.updatedAt
    return getWeekBucket(lastCompletedAt) !== getWeekBucket(now)
  }
  return false
}

function buildCompanyWorkstreamDedupeKey(
  companyId: string,
  workstream: WorkstreamSpec,
  reason: 'onboard' | 'refresh',
  now: string,
): string {
  if (reason === 'refresh') {
    return `company:${companyId}:workstream:${workstream.id}:refresh:${now}`
  }
  if (workstream.metadata.cadence === 'daily') {
    return `company:${companyId}:workstream:${workstream.id}:daily:${getDayBucket(now)}`
  }
  if (workstream.metadata.cadence === 'weekly') {
    return `company:${companyId}:workstream:${workstream.id}:weekly:${getWeekBucket(now)}`
  }
  return `company:${companyId}:workstream:${workstream.id}:initial`
}

async function upsertCompanyFromPublicWeb(
  repoRoot: string,
  input: CompanyOnboardInput,
  mode: 'onboard' | 'refresh',
): Promise<CompanyMissionControl> {
  const normalizedWebsiteUrl = normalizeUrl(input.websiteUrl)
  const socialUrls = (input.socialUrls ?? []).map(normalizeUrl)
  const [config, signals] = await Promise.all([
    readEffectiveHarnessConfig(repoRoot),
    buildCompanySignals({
      websiteUrl: normalizedWebsiteUrl,
      socialUrls,
    }),
  ])
  if (signals.length === 0) {
    throw new Error(
      `Unable to build a company brief from ${normalizedWebsiteUrl}. No HTML pages were discovered in the bounded crawl.`,
    )
  }

  const now = nowIso()
  const repoId = buildHarnessRepoId(repoRoot)
  const companyId = createStableId(repoId, normalizedWebsiteUrl)
  const graph = synthesizeCompanyGraph(
    repoId,
    normalizedWebsiteUrl,
    socialUrls,
    signals,
    now,
  )
  const operatingModel = synthesizeOperatingModel(companyId, graph, now)
  const packs = selectPacksForCompanyGraph(graph)
  const nextOrg = synthesizeDynamicOrg(graph, packs, now)
  const nextStandingLanes = synthesizeStandingLanes(
    companyId,
    graph,
    operatingModel,
    nextOrg,
    packs,
    now,
  )
  const nextRecommendations = buildConnectorRecommendations(
    companyId,
    graph,
    nextStandingLanes,
    packs,
    now,
  )

  const { hostedRepoId, workstreamsToEnqueue } = await withHostedHarnessState(state => {
    const persistedRepoId = ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      now: new Date(now),
    })
    const existingCompany = state.companyOps.companies[companyId]
    const org = mergeDynamicOrg(existingCompany?.org, nextOrg, now)
    const mergedRecommendations = nextRecommendations.map(recommendation =>
      mergeConnectorRecommendationState(
        state.companyOps.connectorRecommendations[recommendation.id],
        recommendation,
      ),
    )
    const nextConnectorPolicies = buildConnectorPolicies(
      companyId,
      mergedRecommendations,
      nextStandingLanes,
      now,
    )
    const mergedConnectorPolicies = nextConnectorPolicies.map(policy =>
      mergeConnectorPolicyState(
        state.companyOps.connectorPolicies[policy.id],
        policy,
        mergedRecommendations.find(
          recommendation => recommendation.connector === policy.connector,
        ),
      ),
    )
    const mergedStandingLanes = nextStandingLanes.map(lane =>
      mergeStandingLaneState(state.companyOps.standingLanes[lane.id], {
        ...lane,
        ownerAgentId:
          org.roles.find(role => role.id === lane.ownerAgentId)?.id ??
          lane.ownerAgentId,
      }),
    )
    const nextWorkstreams = buildLaneWorkstreams(
      companyId,
      graph,
      mergedStandingLanes,
      packs,
      mergedConnectorPolicies,
      now,
    )
    const mergedWorkstreams = nextWorkstreams.map(workstream =>
      mergeWorkstreamState(state.companyOps.workstreams[workstream.id], {
        ...workstream,
        ownerAgentId:
          org.roles.find(role => role.domain === workstream.domain && role.status === 'active')
            ?.id ?? workstream.ownerAgentId,
      }),
    )

    const company: CompanyRecord = {
      id: companyId,
      repoId: persistedRepoId,
      websiteUrl: normalizedWebsiteUrl,
      socialUrls,
      companyName: graph.companyName,
      businessArchetype: graph.businessArchetype,
      pmAgentId: org.pmAgentId,
      graph: {
        ...graph,
        repoId: persistedRepoId,
      },
      operatingModelId: operatingModel.id,
      org,
      activePackIds: packs.map(pack => pack.id),
      standingLaneIds: mergedStandingLanes.map(lane => lane.id),
      laneRunIds: existingCompany?.laneRunIds ?? [],
      workstreamIds: mergedWorkstreams.map(workstream => workstream.id),
      usefulArtifactIds: existingCompany?.usefulArtifactIds ?? [],
      exceptionIds: existingCompany?.exceptionIds ?? [],
      gapIds: existingCompany?.gapIds ?? [],
      ownerMessageIds: existingCompany?.ownerMessageIds ?? [],
      ownerTouchMetricIds: existingCompany?.ownerTouchMetricIds ?? [],
      pmDecisionIds: existingCompany?.pmDecisionIds ?? [],
      connectorRecommendationIds: mergedRecommendations.map(
        recommendation => recommendation.id,
      ),
      connectorPolicyIds: mergedConnectorPolicies.map(policy => policy.id),
      metrics: {
        ownerTouchCount: existingCompany?.metrics.ownerTouchCount ?? 0,
        pmCreatedAgentCount: org.roles.length,
        pmRetiredAgentCount: org.roles.filter(role => role.status === 'retired').length,
        activeLaneCount: mergedStandingLanes.length,
        workstreamSuccessCount:
          existingCompany?.metrics.workstreamSuccessCount ?? 0,
        workstreamFailureCount:
          existingCompany?.metrics.workstreamFailureCount ?? 0,
        usefulArtifactCount: existingCompany?.metrics.usefulArtifactCount ?? 0,
        usefulArtifactsThisWeek:
          existingCompany?.metrics.usefulArtifactsThisWeek ?? 0,
        recurringLaneCompletionRate:
          existingCompany?.metrics.recurringLaneCompletionRate ?? 0,
        firstUsefulOutputAt: existingCompany?.metrics.firstUsefulOutputAt,
        repeatedExceptionCount:
          existingCompany?.metrics.repeatedExceptionCount ?? 0,
        platformGapCount: existingCompany?.metrics.platformGapCount ?? 0,
        packGapCount: existingCompany?.metrics.packGapCount ?? 0,
        productGapCount: existingCompany?.metrics.productGapCount ?? 0,
        domainSuccessCounts:
          existingCompany?.metrics.domainSuccessCounts ?? {},
        executionFailureCountsByRuntime:
          existingCompany?.metrics.executionFailureCountsByRuntime ?? {},
      },
      createdAt: existingCompany?.createdAt ?? now,
      updatedAt: now,
      metadata: {
        packTitles: packs.map(pack => pack.title),
        normalizedHost: graph.normalizedHost,
      },
    }

    state.companyOps.companies[companyId] = company
    state.companyOps.operatingModels[operatingModel.id] = operatingModel
    for (const lane of mergedStandingLanes) {
      state.companyOps.standingLanes[lane.id] = lane
    }
    for (const workstream of mergedWorkstreams) {
      state.companyOps.workstreams[workstream.id] = workstream
    }
    for (const recommendation of mergedRecommendations) {
      state.companyOps.connectorRecommendations[recommendation.id] = recommendation
    }
    for (const policy of mergedConnectorPolicies) {
      state.companyOps.connectorPolicies[policy.id] = policy
    }

    const decisionType = mode === 'onboard' ? 'onboard' : 'org_synthesis'
    const decisionId = createStableId(companyId, 'decision', decisionType, now)
    if (!state.companyOps.pmDecisions[decisionId]) {
      state.companyOps.pmDecisions[decisionId] = {
        id: decisionId,
        companyId,
        type: decisionType,
        summary:
          mode === 'onboard'
            ? `Onboarded ${graph.companyName} and created a PM-led org with ${org.roles.filter(role => role.status === 'active').length} active roles and ${mergedStandingLanes.length} standing lanes.`
            : `Refreshed ${graph.companyName}, updated the operating model, and kept standing lanes current from the bounded public-web crawl.`,
        rationale:
          mode === 'onboard'
            ? `Selected packs: ${summarizePackTitles(packs)}. Standing lanes: ${mergedStandingLanes.map(lane => lane.title).join(', ')}.`
            : `Refresh kept a single company record in place and updated packs, lanes, and connector policy from current evidence.`,
        createdAt: now,
        metadata: {
          businessArchetype: graph.businessArchetype,
          websiteUrl: normalizedWebsiteUrl,
          roleCount: org.roles.length,
          standingLaneCount: mergedStandingLanes.length,
        },
      }
      company.pmDecisionIds.push(decisionId)
    }

    appendCompanyEventLedger(
      state,
      mode === 'onboard' ? 'cc_company_onboarded' : 'cc_company_graph_refreshed',
      companyId,
      now,
      {
        websiteUrl: normalizedWebsiteUrl,
        businessArchetype: graph.businessArchetype,
        roleCount: org.roles.length,
        standingLaneCount: mergedStandingLanes.length,
      },
    )

    syncCompanyStateFromHarness(state, companyId, now)

    const enqueueable = mergedWorkstreams.filter(workstream =>
      shouldEnqueueCompanyWorkstream(
        workstream,
        workstream.jobInstanceId
          ? state.jobs[workstream.jobInstanceId]
          : undefined,
        mode,
        now,
      ),
    )

    return {
      hostedRepoId: persistedRepoId,
      workstreamsToEnqueue: enqueueable,
    }
  })

  for (const workstream of workstreamsToEnqueue) {
    const instance = await enqueueHarnessJob(repoRoot, {
      jobId: workstream.jobId,
      sourceKind: 'manual',
      promptVariables: {
        companyId,
        companyName: graph.companyName,
        websiteUrl: normalizedWebsiteUrl,
        workstreamId: workstream.id,
        workstreamTitle: workstream.title,
        workstreamGoal: workstream.objective,
        laneId: workstream.laneId ?? '',
        laneType: typeof workstream.metadata.laneType === 'string'
          ? workstream.metadata.laneType
          : '',
        cadence: typeof workstream.metadata.cadence === 'string'
          ? workstream.metadata.cadence
          : '',
        expectedArtifactKinds: Array.isArray(workstream.metadata.expectedArtifactKinds)
          ? workstream.metadata.expectedArtifactKinds.join(', ')
          : '',
        packIds: workstream.packIds.join(', '),
        operatingModelSummary: JSON.stringify({
          businessArchetype: operatingModel.businessArchetype,
          offers: operatingModel.offers,
          buyerRoles: operatingModel.buyerRoles,
          coreChannels: operatingModel.coreChannels,
          operationalSurfaces: operatingModel.operationalSurfaces,
        }),
      },
      metadata: {
        companyId,
        workstreamId: workstream.id,
        laneId: workstream.laneId,
        packIds: workstream.packIds,
        requestedBy: mode === 'onboard' ? 'pm-onboard' : 'pm-refresh',
      },
      dedupeKey: buildCompanyWorkstreamDedupeKey(companyId, workstream, mode, now),
    })
    await withHostedHarnessState(state => {
      const persisted = state.companyOps.workstreams[workstream.id]
      if (persisted) {
        persisted.jobInstanceId = instance.instanceId
        persisted.status = 'queued'
        persisted.updatedAt = nowIso()
      }
      const company = state.companyOps.companies[companyId]
      if (company) {
        syncCompanyStateFromHarness(state, companyId, nowIso())
      }
      appendCompanyEventLedger(
        state,
        'cc_company_workstream_opened',
        companyId,
        nowIso(),
        {
          workstreamId: workstream.id,
          workstreamTitle: workstream.title,
          jobId: workstream.jobId,
          jobInstanceId: instance.instanceId,
        },
      )
      return filterHarnessStateForRepo(state, hostedRepoId)
    })
    await logHarnessWideEvent('cc_company_workstream_opened', {
      repoRoot,
      repoId,
      metadata: {
        'cc.company_id': companyId,
        'cc.company_name': graph.companyName,
        'cc.workstream_id': workstream.id,
        'cc.workstream_title': workstream.title,
        'cc.workstream_domain': workstream.domain,
        'cc.pack_ids': workstream.packIds,
        'cc.job_id': workstream.jobId,
      },
    })
  }

  await logHarnessWideEvent(
    mode === 'onboard' ? 'cc_company_onboarded' : 'cc_company_graph_refreshed',
    {
      repoRoot,
      repoId,
      metadata: {
        'cc.company_id': companyId,
        'cc.company_name': graph.companyName,
        'cc.business_archetype': graph.businessArchetype,
        'cc.website_url': normalizedWebsiteUrl,
        'cc.social_urls': socialUrls,
        'cc.pack_ids': packs.map(pack => pack.id),
        'cc.pm_agent_id': nextOrg.pmAgentId,
        'cc.role_count': nextOrg.roles.length,
      },
    },
  )

  return getCompanyMissionControl(repoRoot, companyId)
}

export async function onboardCompany(
  repoRoot: string,
  input: CompanyOnboardInput,
): Promise<CompanyMissionControl> {
  return upsertCompanyFromPublicWeb(repoRoot, input, 'onboard')
}

export async function refreshCompanyBrief(
  repoRoot: string,
  companyId?: string,
): Promise<CompanyMissionControl> {
  const snapshot = await getCompanyMissionControl(repoRoot, companyId)
  if (!snapshot.company) {
    throw new Error('No company is onboarded yet.')
  }
  return upsertCompanyFromPublicWeb(
    repoRoot,
    {
      websiteUrl: snapshot.company.websiteUrl,
      socialUrls: snapshot.company.socialUrls,
    },
    'refresh',
  )
}

export async function getCompanyMissionControl(
  repoRoot: string,
  requestedCompanyId?: string,
): Promise<CompanyMissionControl> {
  const config = await readEffectiveHarnessConfig(repoRoot)
  const repoId = buildHarnessRepoId(repoRoot)
  const state = await withHostedHarnessState(state => {
    const hostedRepoId = ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      now: new Date(),
    })
    const companyId =
      requestedCompanyId ??
      Object.values(state.companyOps.companies)
        .find(company => company.repoId === hostedRepoId)
        ?.id
    if (companyId) {
      const recordedAt = nowIso()
      syncCompanyStateFromHarness(state, companyId, recordedAt)
      appendCompanyEventLedger(
        state,
        'cc_company_mission_snapshot',
        companyId,
        recordedAt,
        {},
      )
    }
    return filterHarnessStateForRepo(state, hostedRepoId)
  })
  const companyId =
    requestedCompanyId ?? Object.keys(state.companyOps.companies)[0]
  const company = companyId ? state.companyOps.companies[companyId] ?? null : null
  const operatingModel =
    company?.operatingModelId
      ? state.companyOps.operatingModels[company.operatingModelId] ?? null
      : null
  const specialistAgents = company
    ? company.org.roles.filter(role => role.id !== company.pmAgentId)
    : []
  const pmAgent =
    company?.org.roles.find(role => role.id === company.pmAgentId) ?? null
  const standingLanes = company
    ? sortByCreatedAtDesc(
        company.standingLaneIds
          .map(laneId => state.companyOps.standingLanes[laneId])
          .filter((lane): lane is StandingLane => Boolean(lane)),
      )
    : []
  const laneRuns = company
    ? sortByCreatedAtDesc(
        company.laneRunIds
          .map(laneRunId => state.companyOps.laneRuns[laneRunId])
          .filter((laneRun): laneRun is LaneRun => Boolean(laneRun)),
      )
    : []
  const workstreams = company
    ? sortByCreatedAtDesc(
        company.workstreamIds
          .map(workstreamId => state.companyOps.workstreams[workstreamId])
          .filter((workstream): workstream is WorkstreamSpec => Boolean(workstream)),
      )
    : []
  const usefulArtifacts = company
    ? sortByCreatedAtDesc(
        company.usefulArtifactIds
          .map(artifactId => state.companyOps.usefulArtifacts[artifactId])
          .filter((artifact): artifact is UsefulArtifact => Boolean(artifact)),
      )
    : []
  const exceptions = company
    ? sortByCreatedAtDesc(
        company.exceptionIds
          .map(exceptionId => state.companyOps.exceptions[exceptionId])
          .filter((exception): exception is OwnerException => Boolean(exception)),
      )
    : []
  const gaps = company
    ? sortByCreatedAtDesc(
        company.gapIds
          .map(gapId => state.companyOps.gaps[gapId])
          .filter((gap): gap is CompanyGap => Boolean(gap)),
      )
    : []
  const connectorRecommendations = company
    ? sortByCreatedAtDesc(
        company.connectorRecommendationIds
          .map(id => state.companyOps.connectorRecommendations[id])
          .filter(
            (recommendation): recommendation is ConnectorUnlockRecommendation =>
              Boolean(recommendation),
          ),
      )
    : []
  const connectorPolicies = company
    ? sortByCreatedAtDesc(
        company.connectorPolicyIds
          .map(id => state.companyOps.connectorPolicies[id])
          .filter((policy): policy is ConnectorPolicy => Boolean(policy)),
      )
    : []
  const ownerTouchMetrics = company
    ? sortByCreatedAtDesc(
        company.ownerTouchMetricIds
          .map(id => state.companyOps.ownerTouchMetrics[id])
          .filter((metric): metric is OwnerTouchMetric => Boolean(metric)),
      )
    : []
  const recentPmDecisions = company
    ? sortByCreatedAtDesc(
        company.pmDecisionIds
          .map(decisionId => state.companyOps.pmDecisions[decisionId])
          .filter((decision): decision is PMDecision => Boolean(decision)),
      ).slice(0, 10)
    : []
  const recentOwnerMessages = company
    ? sortByCreatedAtDesc(
        company.ownerMessageIds
          .map(messageId => state.companyOps.ownerMessages[messageId])
          .filter((message): message is OwnerMessage => Boolean(message)),
      ).slice(0, 10)
    : []
  const workstreamCards = buildWorkstreamCards(
    workstreams,
    company?.org.roles ?? [],
    gaps,
    exceptions,
  )
  const standingLaneCards = buildStandingLaneCards(
    standingLanes,
    company?.org.roles ?? [],
    workstreams,
    usefulArtifacts,
    connectorPolicies,
  )
  const packs = company
    ? getPackCatalogForCompanyGraph(company.graph)
    : getDefaultPackRegistry().map(pack => ({
        pack,
        status: 'available' as const,
        reason: 'Available once a company has been onboarded.',
      }))
  const metrics = buildMissionControlMetrics(
    company,
    standingLanes,
    workstreams,
    usefulArtifacts,
    exceptions,
    gaps,
  )
  const missionSnapshot: MissionControlSnapshot = {
    company,
    operatingModel,
    pm: buildPMSnapshot(pmAgent, recentPmDecisions, recentOwnerMessages),
    specialists: specialistAgents.filter(role => role.status === 'active'),
    standingLanes: standingLaneCards,
    workstreams: workstreamCards,
    usefulArtifacts,
    exceptions,
    gaps,
    connectorRecommendations,
    connectorPolicies,
    packs,
    metrics,
    observability: state.observability,
    summary: '',
  }

  const snapshotBase = {
    controlPlane: getHostedHarnessControlPlaneInfo(),
    repoId,
    snapshot: missionSnapshot,
    company,
    operatingModel,
    pmAgent,
    specialistAgents,
    standingLanes: standingLaneCards,
    laneRuns,
    workstreams,
    workstreamCards,
    usefulArtifacts,
    exceptions,
    gaps,
    connectorRecommendations,
    connectorPolicies,
    ownerTouchMetrics,
    packs,
    recentPmDecisions,
    recentOwnerMessages,
    metrics,
    queuedCount: state.queue.length,
    activeCount: Object.values(state.jobs).filter(
      job => job.status === 'leased' || job.status === 'running',
    ).length,
    observability: state.observability,
  }

  const result: CompanyMissionControl = {
    ...snapshotBase,
    summary: summarizeMissionControl(snapshotBase),
  }
  result.snapshot.summary = result.summary

  if (company) {
    await logHarnessWideEvent('cc_company_mission_snapshot', {
      repoRoot,
      repoId,
      state,
      metadata: {
        'cc.company_id': company.id,
        'cc.company_name': company.companyName,
        'cc.standing_lane_count': standingLanes.length,
        'cc.workstream_count': workstreams.length,
        'cc.useful_artifact_count': usefulArtifacts.length,
        'cc.exception_count': exceptions.length,
        'cc.gap_count': gaps.length,
      },
    })
  }

  return result
}

export async function recordOwnerMessage(
  repoRoot: string,
  input: {
    companyId?: string
    text: string
  },
): Promise<{
  snapshot: CompanyMissionControl
  response: string
}> {
  const now = nowIso()
  const config = await readEffectiveHarnessConfig(repoRoot)
  const repoId = buildHarnessRepoId(repoRoot)
  const state = await withHostedHarnessState(state => {
    const hostedRepoId = ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      now: new Date(now),
    })
    const companyId =
      input.companyId ??
      Object.values(state.companyOps.companies)
        .find(company => company.repoId === hostedRepoId)
        ?.id
    if (!companyId) {
      throw new Error('No company is onboarded yet.')
    }
    const company = state.companyOps.companies[companyId]
    if (!company) {
      throw new Error(`Unknown company: ${companyId}`)
    }
    const ownerMessageId = createStableId(companyId, 'owner-message', now, input.text)
    state.companyOps.ownerMessages[ownerMessageId] = {
      id: ownerMessageId,
      companyId,
      text: input.text,
      createdAt: now,
      metadata: {},
    }
    if (!company.ownerMessageIds.includes(ownerMessageId)) {
      company.ownerMessageIds.push(ownerMessageId)
    }
    company.metrics.ownerTouchCount += 1
    const ownerTouchMetricId = createStableId(
      companyId,
      'owner-touch',
      ownerMessageId,
    )
    state.companyOps.ownerTouchMetrics[ownerTouchMetricId] = {
      id: ownerTouchMetricId,
      companyId,
      source: 'owner_message',
      recordedAt: now,
      summary: truncateText(input.text, 240),
      metadata: {},
    }
    if (!company.ownerTouchMetricIds.includes(ownerTouchMetricId)) {
      company.ownerTouchMetricIds.push(ownerTouchMetricId)
    }
    const decisionId = createStableId(companyId, 'decision', 'owner-response', now)
    state.companyOps.pmDecisions[decisionId] = {
      id: decisionId,
      companyId,
      type: 'owner_response',
      summary: `PM acknowledged owner message and updated priorities: ${truncateText(input.text, 160)}`,
      rationale: 'Owner communications stay at the PM layer; specialists remain hidden unless surfaced intentionally.',
      createdAt: now,
      metadata: {},
    }
    if (!company.pmDecisionIds.includes(decisionId)) {
      company.pmDecisionIds.push(decisionId)
    }
    appendCompanyEventLedger(state, 'cc_company_owner_message', companyId, now, {
      ownerMessageId,
      ownerTouchMetricId,
      decisionId,
    })
    syncCompanyStateFromHarness(state, companyId, now)
    return filterHarnessStateForRepo(state, hostedRepoId)
  })

  const snapshot = await getCompanyMissionControl(repoRoot, input.companyId)
  const response = buildPmResponse(snapshot, input.text)

  await logHarnessWideEvent('cc_company_owner_message', {
    repoRoot,
    repoId,
    state,
    metadata: {
      'cc.company_id': snapshot.company?.id,
      'cc.company_name': snapshot.company?.companyName,
      'cc.owner_message': truncateText(input.text, 240),
      'cc.pm_response': truncateText(response, 240),
    },
  })

  await logHarnessWideEvent('cc_pm_decision_recorded', {
    repoRoot,
    repoId,
    state,
    metadata: {
      'cc.company_id': snapshot.company?.id,
      'cc.company_name': snapshot.company?.companyName,
      'cc.pm_decision_type': 'owner_response',
      'cc.pm_decision_summary': truncateText(response, 240),
    },
  })

  return {
    snapshot,
    response,
  }
}

export async function resolveOwnerException(
  repoRoot: string,
  input: {
    companyId?: string
    exceptionId: string
    resolution?: string
  },
): Promise<CompanyMissionControl> {
  const now = nowIso()
  const config = await readEffectiveHarnessConfig(repoRoot)
  const repoId = buildHarnessRepoId(repoRoot)
  const state = await withHostedHarnessState(state => {
    const hostedRepoId = ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      now: new Date(now),
    })
    const companyId =
      input.companyId ??
      Object.values(state.companyOps.companies)
        .find(company => company.repoId === hostedRepoId)
        ?.id
    if (!companyId) {
      throw new Error('No company is onboarded yet.')
    }
    const exception = state.companyOps.exceptions[input.exceptionId]
    if (!exception || exception.companyId !== companyId) {
      throw new Error(`Unknown owner exception: ${input.exceptionId}`)
    }
    exception.status = 'resolved'
    exception.resolvedAt = now
    exception.metadata = {
      ...exception.metadata,
      resolution: input.resolution ?? 'Resolved by PM action.',
    }
    const company = state.companyOps.companies[companyId]
    if (company) {
      const ownerTouchMetricId = createStableId(
        companyId,
        'owner-touch',
        exception.id,
        now,
      )
      state.companyOps.ownerTouchMetrics[ownerTouchMetricId] = {
        id: ownerTouchMetricId,
        companyId,
        laneId:
          typeof exception.metadata.laneId === 'string'
            ? exception.metadata.laneId
            : undefined,
        workstreamId:
          typeof exception.metadata.workstreamId === 'string'
            ? exception.metadata.workstreamId
            : undefined,
        source: 'exception_resolution',
        recordedAt: now,
        summary: truncateText(
          input.resolution ?? `Resolved ${exception.title}`,
          240,
        ),
        metadata: {},
      }
      if (!company.ownerTouchMetricIds.includes(ownerTouchMetricId)) {
        company.ownerTouchMetricIds.push(ownerTouchMetricId)
      }
      company.metrics.ownerTouchCount += 1
      const decisionId = createStableId(companyId, 'decision', 'exception', now)
      state.companyOps.pmDecisions[decisionId] = {
        id: decisionId,
        companyId,
        type: 'exception',
        summary: `Resolved owner exception: ${exception.title}`,
        rationale:
          input.resolution ??
          'The PM resolved this exception and resumed company work without exposing specialists.',
        linkedExceptionId: exception.id,
        createdAt: now,
        metadata: {},
      }
      if (!company.pmDecisionIds.includes(decisionId)) {
        company.pmDecisionIds.push(decisionId)
      }
      syncCompanyStateFromHarness(state, companyId, now)
      appendCompanyEventLedger(
        state,
        'cc_company_exception_resolved',
        companyId,
        now,
        {
          exceptionId: exception.id,
          ownerTouchMetricId,
        },
      )
    }
    return filterHarnessStateForRepo(state, hostedRepoId)
  })

  await logHarnessWideEvent('cc_company_exception_resolved', {
    repoRoot,
    repoId,
    state,
    metadata: {
      'cc.exception_id': input.exceptionId,
      'cc.company_id': input.companyId,
      'cc.resolution': truncateText(input.resolution ?? 'Resolved', 240),
    },
  })

  return getCompanyMissionControl(repoRoot, input.companyId)
}

export async function updateConnectorRecommendation(
  repoRoot: string,
  input: {
    companyId?: string
    recommendationId: string
    status: 'accepted' | 'dismissed'
  },
): Promise<CompanyMissionControl> {
  const now = nowIso()
  const config = await readEffectiveHarnessConfig(repoRoot)
  const repoId = buildHarnessRepoId(repoRoot)
  const state = await withHostedHarnessState(state => {
    const hostedRepoId = ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      now: new Date(now),
    })
    const companyId =
      input.companyId ??
      Object.values(state.companyOps.companies)
        .find(company => company.repoId === hostedRepoId)
        ?.id
    if (!companyId) {
      throw new Error('No company is onboarded yet.')
    }
    const recommendation =
      state.companyOps.connectorRecommendations[input.recommendationId]
    if (!recommendation || recommendation.companyId !== companyId) {
      throw new Error(`Unknown connector recommendation: ${input.recommendationId}`)
    }
    recommendation.status = input.status
    recommendation.metadata = {
      ...recommendation.metadata,
      updatedAt: now,
    }
    const company = state.companyOps.companies[companyId]
    if (company) {
      const policy = company.connectorPolicyIds
        .map(policyId => state.companyOps.connectorPolicies[policyId])
        .find(candidate => candidate?.connector === recommendation.connector)
      if (policy) {
        policy.status = input.status
        policy.updatedAt = now
      }
      const decisionId = createStableId(
        companyId,
        'decision',
        'connector',
        now,
        input.recommendationId,
      )
      state.companyOps.pmDecisions[decisionId] = {
        id: decisionId,
        companyId,
        type: 'connector_recommendation',
        summary: `${input.status === 'accepted' ? 'Accepted' : 'Dismissed'} connector recommendation: ${recommendation.connector}`,
        rationale: recommendation.reason,
        createdAt: now,
        metadata: {
          recommendationId: recommendation.id,
          status: input.status,
        },
      }
      if (!company.pmDecisionIds.includes(decisionId)) {
        company.pmDecisionIds.push(decisionId)
      }
      syncCompanyStateFromHarness(state, companyId, now)
      appendCompanyEventLedger(
        state,
        'cc_company_connector_recommendation_updated',
        companyId,
        now,
        {
          recommendationId: recommendation.id,
          connector: recommendation.connector,
          status: input.status,
        },
      )
    }
    return filterHarnessStateForRepo(state, hostedRepoId)
  })

  await logHarnessWideEvent('cc_company_connector_recommendation_updated', {
    repoRoot,
    repoId,
    state,
    metadata: {
      'cc.company_id': input.companyId,
      'cc.recommendation_id': input.recommendationId,
      'cc.recommendation_status': input.status,
    },
  })

  return getCompanyMissionControl(repoRoot, input.companyId)
}

export async function getCompanyMissionControlSnapshot(
  repoRoot: string,
  companyId?: string,
): Promise<MissionControlSnapshot> {
  return (await getCompanyMissionControl(repoRoot, companyId)).snapshot
}

export async function applyMissionControlAction(
  repoRoot: string,
  action: MissionControlAction,
): Promise<MissionControlActionResult> {
  switch (action.type) {
    case 'load_snapshot':
      return {
        actionType: action.type,
        snapshot: await getCompanyMissionControlSnapshot(repoRoot, action.companyId),
      }
    case 'send_pm_message': {
      const result = await recordOwnerMessage(repoRoot, {
        companyId: action.companyId,
        text: action.text,
      })
      return {
        actionType: action.type,
        snapshot: result.snapshot.snapshot,
        response: result.response,
      }
    }
    case 'refresh_brief': {
      const snapshot = await refreshCompanyBrief(repoRoot, action.companyId)
      return {
        actionType: action.type,
        snapshot: snapshot.snapshot,
        response: snapshot.summary,
      }
    }
    case 'resolve_exception': {
      const snapshot = await resolveOwnerException(repoRoot, {
        companyId: action.companyId,
        exceptionId: action.exceptionId,
        resolution: action.resolution,
      })
      return {
        actionType: action.type,
        snapshot: snapshot.snapshot,
        response: `Resolved exception ${action.exceptionId}.`,
      }
    }
    case 'update_connector_recommendation': {
      const snapshot = await updateConnectorRecommendation(repoRoot, {
        companyId: action.companyId,
        recommendationId: action.recommendationId,
        status: action.status,
      })
      return {
        actionType: action.type,
        snapshot: snapshot.snapshot,
        response: `${action.status === 'accepted' ? 'Accepted' : 'Dismissed'} connector recommendation ${action.recommendationId}.`,
      }
    }
  }
}
