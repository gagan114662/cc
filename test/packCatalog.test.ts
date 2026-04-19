import { describe, expect, test } from 'bun:test'
import {
  getDefaultPackRegistry,
  getPackCatalogForCompanyGraph,
} from 'src/services/harness/packs.js'
import type { CompanyGraph } from 'src/services/harness/types.js'

function buildGraph(
  overrides: Partial<CompanyGraph> = {},
): CompanyGraph {
  return {
    id: 'graph-1',
    repoId: 'repo-1',
    websiteUrl: 'https://example.com',
    socialUrls: [],
    normalizedHost: 'example.com',
    companyName: 'AcmeFlow',
    businessArchetype: 'developer-tools',
    summary: 'Developer workflow automation for growing teams.',
    valueProps: ['API-first automation', 'Growth workflows'],
    offers: ['platform', 'software'],
    icpRoles: ['developers', 'marketers'],
    demandChannels: ['seo', 'content'],
    supportSurfaces: ['docs', 'support'],
    operationalNeeds: ['automation', 'analytics'],
    technicalSignals: ['api', 'sdk', 'github'],
    evidence: ['pricing', 'docs', 'careers'],
    signals: [],
    createdAt: '2026-04-19T00:00:00.000Z',
    updatedAt: '2026-04-19T00:00:00.000Z',
    metadata: {},
    ...overrides,
  }
}

describe('pack catalog', () => {
  test('loads the checked-in pack manifest', () => {
    const registry = getDefaultPackRegistry()

    expect(registry.length).toBeGreaterThan(4)
    expect(registry.some(pack => pack.id === 'company-os-foundations')).toBeTrue()
    expect(registry.some(pack => pack.id === 'market-map')).toBeTrue()
    expect(
      registry.every(
        pack =>
          pack.supportedLaneTypes.length > 0 &&
          pack.expectedArtifactKinds.length > 0 &&
          pack.validationRules.length > 0,
      ),
    ).toBeTrue()
  })

  test('returns active and deferred pack views from evidence-backed selection', () => {
    const catalog = getPackCatalogForCompanyGraph(buildGraph())

    expect(catalog.some(pack => pack.status === 'active')).toBeTrue()
    expect(
      catalog.some(
        pack =>
          pack.pack.id === 'automation-blueprint' &&
          pack.status === 'active',
      ),
    ).toBeTrue()

    const nonTechnicalCatalog = getPackCatalogForCompanyGraph(
      buildGraph({
        businessArchetype: 'services',
        technicalSignals: [],
        offers: ['consulting'],
        evidence: ['book a call'],
      }),
    )

    expect(
      nonTechnicalCatalog.find(pack => pack.pack.id === 'automation-blueprint')
        ?.status,
    ).toBe('deferred')
  })
})
