import packCatalog from './packCatalog.json'
import {
  MissionControlPackViewSchema,
  PackManifestSchema,
} from './types.js'
import type {
  BusinessArchetype,
  CompanyGraph,
  HarnessAgentKind,
  MissionControlPackView,
  PackManifest,
} from './types.js'

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function lower(values: string[]): string[] {
  return values.map(value => value.toLowerCase())
}

function loadPackCatalog(): PackManifest[] {
  return PackManifestSchema()
    .array()
    .parse(structuredClone(packCatalog))
}

function hasTechnicalFootprint(graph: CompanyGraph): boolean {
  const signals = lower([
    graph.businessArchetype,
    ...graph.technicalSignals,
    ...graph.offers,
    ...graph.evidence,
  ])
  return signals.some(signal =>
    ['api', 'sdk', 'integration', 'developer', 'platform', 'cli', 'git'].some(
      token => signal.includes(token),
    ),
  )
}

function looksCommerce(graph: CompanyGraph): boolean {
  const signals = lower([
    graph.businessArchetype,
    ...graph.offers,
    ...graph.valueProps,
  ])
  return signals.some(signal =>
    ['ecommerce', 'shop', 'store', 'checkout', 'consumer'].some(token =>
      signal.includes(token),
    ),
  )
}

function looksSupportHeavy(graph: CompanyGraph): boolean {
  const signals = lower([
    ...graph.supportSurfaces,
    ...graph.operationalNeeds,
    ...graph.evidence,
  ])
  return signals.some(signal =>
    ['support', 'faq', 'docs', 'help', 'onboarding', 'customer'].some(token =>
      signal.includes(token),
    ),
  )
}

function looksRecruitingRelevant(graph: CompanyGraph): boolean {
  const signals = lower([
    ...graph.operationalNeeds,
    ...graph.evidence,
    ...graph.signals.flatMap(signal => signal.keywords),
  ])
  return signals.some(signal =>
    ['career', 'careers', 'hiring', 'recruit', 'jobs'].some(token =>
      signal.includes(token),
    ),
  )
}

function reasonForPackSelection(graph: CompanyGraph, pack: PackManifest): string {
  switch (pack.id) {
    case 'company-os-foundations':
      return 'Always selected so the PM can set the operating cadence and connector roadmap immediately.'
    case 'market-map':
      return 'Selected because every company onboard needs a public-web market and positioning baseline.'
    case 'gtm-sweep':
      return graph.icpRoles.length > 0 || graph.demandChannels.length > 0
        ? 'Selected because the public web signals show a real buyer/channel motion the PM can activate.'
        : 'Deferred until stronger ICP or channel evidence appears.'
    case 'content-engine':
      return graph.demandChannels.length > 0 || looksCommerce(graph)
        ? 'Selected because content, SEO, or commerce signals are strong enough to justify a backlog.'
        : 'Deferred because the current evidence is too thin for a content-heavy lane.'
    case 'support-ops-audit':
      return looksSupportHeavy(graph)
        ? 'Selected because the site shows support, FAQ, docs, or onboarding surface the PM can improve.'
        : 'Selected as a baseline operational audit even with limited public support signal.'
    case 'automation-blueprint':
      return hasTechnicalFootprint(graph)
        ? 'Selected because technical signals suggest automation and implementation work will compound.'
        : 'Deferred until stronger technical footprint or code/integration signals are present.'
    case 'customer-ops-playbook':
      return looksSupportHeavy(graph)
        ? 'Selected because customer operations signals are present and connectors will unlock compound value.'
        : 'Deferred until support or onboarding signals are clearer.'
    case 'recruiting-radar':
      return looksRecruitingRelevant(graph)
        ? 'Selected because public careers or hiring signals suggest recruiting work is active.'
        : 'Deferred because there is not enough hiring evidence yet.'
    default:
      return 'Selected by the PM from the current company evidence.'
  }
}

export function getDefaultPackRegistry(): PackManifest[] {
  return loadPackCatalog()
}

export function selectPacksForCompanyGraph(graph: CompanyGraph): PackManifest[] {
  const selected = [
    'company-os-foundations',
    'market-map',
    'gtm-sweep',
    'support-ops-audit',
  ]

  if (graph.demandChannels.length > 0 || graph.icpRoles.length > 0 || looksCommerce(graph)) {
    selected.push('content-engine')
  }

  if (hasTechnicalFootprint(graph)) {
    selected.push('automation-blueprint')
  }

  if (looksSupportHeavy(graph)) {
    selected.push('customer-ops-playbook')
  }

  if (looksRecruitingRelevant(graph)) {
    selected.push('recruiting-radar')
  }

  const registry = getDefaultPackRegistry()
  const ids = dedupe(selected)
  return registry.filter(pack => ids.includes(pack.id))
}

export function getPackCatalogForCompanyGraph(
  graph: CompanyGraph,
): MissionControlPackView[] {
  const activePackIds = new Set(selectPacksForCompanyGraph(graph).map(pack => pack.id))
  const catalog = getDefaultPackRegistry().map(pack =>
    MissionControlPackViewSchema().parse({
      pack,
      status: activePackIds.has(pack.id)
        ? 'active'
        : pack.requiredConnectors.length > 0 &&
            !pack.requiredConnectors.every(connector =>
              recommendedConnectorsForCompany(graph).includes(connector),
            )
          ? 'deferred'
          : 'available',
      reason: reasonForPackSelection(graph, pack),
    }),
  )

  return catalog.sort((left, right) => {
    const statusScore = { active: 0, available: 1, deferred: 2 } as const
    return (
      statusScore[left.status] - statusScore[right.status] ||
      right.pack.qualityScore - left.pack.qualityScore ||
      left.pack.title.localeCompare(right.pack.title)
    )
  })
}

export function choosePreferredRuntime(
  pack: PackManifest,
): Exclude<HarnessAgentKind, 'either'> | 'either' {
  if (pack.runtimeOwner === 'claude' || pack.runtimeOwner === 'codex') {
    return pack.runtimeOwner
  }
  if (pack.runtimeSupport.includes('claude')) {
    return 'claude'
  }
  if (pack.runtimeSupport.includes('codex')) {
    return 'codex'
  }
  return 'either'
}

export function recommendedConnectorsForCompany(graph: CompanyGraph): string[] {
  const connectors = ['email', 'calendar', 'docs-drive']
  const signals = lower([
    graph.businessArchetype,
    ...graph.demandChannels,
    ...graph.technicalSignals,
    ...graph.supportSurfaces,
    ...graph.operationalNeeds,
  ])

  if (
    signals.some(signal =>
      ['sales', 'pipeline', 'outbound', 'crm', 'lead'].some(token =>
        signal.includes(token),
      ),
    )
  ) {
    connectors.push('crm')
  }

  if (
    signals.some(signal =>
      ['content', 'seo', 'blog', 'social', 'commerce', 'shop'].some(token =>
        signal.includes(token),
      ),
    )
  ) {
    connectors.push('website-cms')
  }

  if (hasTechnicalFootprint(graph)) {
    connectors.push('github')
  }

  if (
    signals.some(signal =>
      ['support', 'help', 'faq', 'ticket'].some(token => signal.includes(token)),
    )
  ) {
    connectors.push('helpdesk')
  }

  return dedupe(connectors)
}

export function summarizePackTitles(packs: PackManifest[]): string {
  return packs.map(pack => pack.title).join(', ')
}

export function guessPackDomainFromArchetype(
  archetype: BusinessArchetype,
): 'market-intel' | 'gtm' | 'ops' | 'engineering' {
  switch (archetype) {
    case 'developer-tools':
    case 'saas':
      return 'engineering'
    case 'agency':
    case 'services':
      return 'ops'
    case 'ecommerce':
    case 'media':
    case 'marketplace':
      return 'gtm'
    default:
      return 'market-intel'
  }
}
