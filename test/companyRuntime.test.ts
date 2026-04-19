import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  __setHostedHarnessBackendOverrideForTests,
  withHostedHarnessState,
} from 'src/services/harness/controlPlane.js'
import {
  applyMissionControlAction,
  refreshCompanyBrief,
  onboardCompany,
  getCompanyMissionControl,
  recordOwnerMessage,
} from 'src/services/harness/company.js'
import {
  getDefaultHarnessConfig,
  writeHarnessConfig,
} from 'src/services/harness/config.js'
import { HarnessRuntimeStateSchema } from 'src/services/harness/types.js'

type HarnessBackend = NonNullable<
  Parameters<typeof __setHostedHarnessBackendOverrideForTests>[0]
>

function createInMemoryHarnessBackend(): HarnessBackend {
  let state = HarnessRuntimeStateSchema().parse({
    version: '2',
    tenant: {
      id: 'test-tenant',
      name: 'test-tenant',
      createdAt: '2026-04-19T00:00:00.000Z',
    },
  })

  return {
    kind: 'filesystem',
    async readState() {
      return structuredClone(state)
    },
    async writeState(nextState) {
      state = structuredClone(nextState)
    },
    async withLock<T>(mutator: () => Promise<T> | T): Promise<T> {
      return await mutator()
    },
  }
}

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-company-runtime-'))
  await mkdir(path.join(repoRoot, '.claude'), { recursive: true })
  await writeHarnessConfig(getDefaultHarnessConfig(), repoRoot)
  return repoRoot
}

const originalFetch = globalThis.fetch

type ExampleSiteMode = 'developer' | 'services' | 'instagram'

function buildExamplePage(url: string, mode: ExampleSiteMode): Response {
  const pathname = new URL(url).pathname

  if (mode === 'instagram') {
    if (pathname === '/' || pathname === '/designgaga78/' || pathname === '/designgaga78') {
      return new Response(
        `
          <html>
            <head>
              <title>Design Gaga (&#064;designgaga78) &#x2022; Instagram photos and videos</title>
              <meta property="og:description" content="815 Followers, 1,313 Following, 68 Posts - Design-led brand studio for founder businesses." />
            </head>
            <body>
              <h1>Design Gaga</h1>
              <p>Design-led brand studio for founder businesses.</p>
            </body>
          </html>
        `,
        { status: 200, headers: { 'content-type': 'text/html' } },
      )
    }

    return new Response('<html><body>Unexpected social crawl target</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  }

  if (pathname === '/sitemap.xml') {
    return new Response(
      `
        <urlset>
          <url><loc>https://example.com/pricing</loc></url>
          <url><loc>https://example.com/about</loc></url>
          <url><loc>https://example.com/docs</loc></url>
          <url><loc>https://example.com/blog</loc></url>
          <url><loc>https://example.com/careers</loc></url>
          <url><loc>https://example.com/help</loc></url>
          <url><loc>https://example.com/contact</loc></url>
        </urlset>
      `,
      { status: 200, headers: { 'content-type': 'application/xml' } },
    )
  }

  const pages: Record<ExampleSiteMode, Record<string, string>> = {
    developer: {
      '/': `
        <html>
          <head>
            <title>AcmeFlow | AI workflow platform for growing SaaS teams</title>
            <meta name="description" content="AcmeFlow helps marketers, sales teams, and support teams automate pipeline, content, and customer operations." />
          </head>
          <body>
            <h1>Automate growth, support, and ops</h1>
            <h2>Book a demo</h2>
            <h2>Integrations, API, and docs</h2>
            <h2>Pricing for modern revenue teams</h2>
            <a href="/pricing">Pricing</a>
            <a href="/about">About</a>
            <a href="/docs">Docs</a>
            <a href="/blog">Blog</a>
            <a href="/careers">Careers</a>
            <a href="/help">Help</a>
            <a href="/contact">Contact</a>
          </body>
        </html>
      `,
      '/pricing': `
        <html><body>
          <h1>Pricing</h1>
          <p>Free trial for founders, marketers, sales teams, and support teams.</p>
        </body></html>
      `,
      '/about': `
        <html><body>
          <h1>About AcmeFlow</h1>
          <p>We help operations teams, marketers, and founders move faster with automation.</p>
        </body></html>
      `,
      '/docs': `
        <html><body>
          <h1>Developer docs</h1>
          <p>API, SDK, webhook, integration, CLI, and GitHub guides for engineering teams.</p>
        </body></html>
      `,
      '/blog': `
        <html><body>
          <h1>Blog</h1>
          <p>SEO, content, outbound, and partnership playbooks for growth teams.</p>
        </body></html>
      `,
      '/careers': `
        <html><body>
          <h1>Careers</h1>
          <p>We are hiring engineers, customer support leads, and recruiters.</p>
        </body></html>
      `,
      '/help': `
        <html><body>
          <h1>Help center</h1>
          <p>Support, FAQ, onboarding docs, and customer success workflows.</p>
        </body></html>
      `,
      '/contact': `
        <html><body>
          <h1>Contact sales</h1>
          <p>Email, calendar booking, and enterprise contact options.</p>
        </body></html>
      `,
    },
    services: {
      '/': `
        <html>
          <head>
            <title>AcmeFlow | Fractional growth and operations partner</title>
            <meta name="description" content="AcmeFlow helps founders with positioning, content, outbound, and business operations as a services partner." />
          </head>
          <body>
            <h1>Growth and operations for founder-led companies</h1>
            <h2>Book a call</h2>
            <h2>Content, SEO, and outbound systems</h2>
            <a href="/pricing">Pricing</a>
            <a href="/about">About</a>
            <a href="/blog">Blog</a>
            <a href="/contact">Contact</a>
          </body>
        </html>
      `,
      '/pricing': `
        <html><body>
          <h1>Retainers</h1>
          <p>Consulting, agency, and operating partner engagements.</p>
        </body></html>
      `,
      '/about': `
        <html><body>
          <h1>About</h1>
          <p>Agency support for founders, marketers, and operations teams.</p>
        </body></html>
      `,
      '/blog': `
        <html><body>
          <h1>Insights</h1>
          <p>Content strategy, referrals, and community-led growth ideas.</p>
        </body></html>
      `,
      '/contact': `
        <html><body>
          <h1>Contact</h1>
          <p>Book an appointment for consulting support.</p>
        </body></html>
      `,
    },
  }

  return new Response(
    pages[mode][pathname] ?? '<html><body>Unknown</body></html>',
    {
      status: 200,
      headers: { 'content-type': 'text/html' },
    },
  )
}

describe('company runtime', () => {
  beforeEach(() => {
    __setHostedHarnessBackendOverrideForTests(createInMemoryHarnessBackend())
    let mode: ExampleSiteMode = 'developer'
    const requestedUrls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      requestedUrls.push(url)
      if (url.includes('example.com')) {
        return buildExamplePage(url, mode)
      }
      if (url.includes('instagram.com')) {
        return buildExamplePage(url, mode)
      }
      if (url.includes('linkedin.com')) {
        return new Response(
          `
            <html>
              <head><title>AcmeFlow | LinkedIn</title></head>
              <body>
                Helping founders and marketers scale outbound, SEO, and support with automation.
              </body>
            </html>
          `,
          { status: 200, headers: { 'content-type': 'text/html' } },
        )
      }
      return new Response('<html><body>Unknown</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }) as typeof fetch
    Reflect.set(globalThis, '__ccCompanyTestSetMode', (nextMode: ExampleSiteMode) => {
      mode = nextMode
    })
    Reflect.set(globalThis, '__ccCompanyTestRequestedUrls', requestedUrls)
  })

  afterEach(() => {
    __setHostedHarnessBackendOverrideForTests(null)
    globalThis.fetch = originalFetch
    Reflect.deleteProperty(globalThis, '__ccCompanyTestSetMode')
    Reflect.deleteProperty(globalThis, '__ccCompanyTestRequestedUrls')
  })

  test('onboards a company into a PM-led org with queued workstreams', async () => {
    const repoRoot = await createTempRepo()

    const snapshot = await onboardCompany(repoRoot, {
      websiteUrl: 'https://example.com',
      socialUrls: ['https://linkedin.com/company/acmeflow'],
    })

    expect(snapshot.company?.companyName).toBe('AcmeFlow')
    expect(snapshot.company?.businessArchetype).toBe('developer-tools')
    expect(snapshot.pmAgent?.visibility).toBe('owner')
    expect(snapshot.specialistAgents.length).toBeGreaterThan(0)
    expect(snapshot.workstreams.length).toBeGreaterThan(0)
    expect(snapshot.workstreams.some(workstream => workstream.status === 'queued')).toBeTrue()
    expect(
      snapshot.workstreams.some(workstream =>
        workstream.title.includes('Executive brief'),
      ),
    ).toBeTrue()
    expect(snapshot.standingLanes.length).toBeGreaterThanOrEqual(3)
    expect(
      snapshot.standingLanes.some(lane => lane.lane.type === 'GrowthLane'),
    ).toBeTrue()
    expect(snapshot.connectorRecommendations.length).toBeGreaterThan(0)
    expect(snapshot.queuedCount).toBeGreaterThan(0)
    expect(snapshot.snapshot.company?.graph.signals.length).toBeGreaterThan(4)
    expect(snapshot.packs.some(pack => pack.status === 'active')).toBeTrue()
    expect(snapshot.snapshot.metrics.activeWorkstreamCount).toBeGreaterThan(0)
  })

  test('syncs failed workstreams into platform gaps and keeps owner messaging at the PM layer', async () => {
    const repoRoot = await createTempRepo()
    const onboarded = await onboardCompany(repoRoot, {
      websiteUrl: 'https://example.com',
    })

    const failedWorkstream = onboarded.workstreams[0]
    expect(failedWorkstream?.jobInstanceId).toBeDefined()

    await withHostedHarnessState(async state => {
      const job = state.jobs[failedWorkstream!.jobInstanceId!]
      job.status = 'failed'
      job.outcomeSummary = 'Bootstrap failed because bun was missing on the worker.'
      job.failureTags = ['bootstrap_failed']
      job.completedAt = '2026-04-19T12:00:00.000Z'
      return state
    })

    const mission = await getCompanyMissionControl(repoRoot, onboarded.company?.id)
    expect(mission.gaps.length).toBeGreaterThan(0)
    expect(mission.gaps[0]?.kind).toBe('platform')

    const message = await recordOwnerMessage(repoRoot, {
      companyId: onboarded.company?.id,
      text: 'Keep moving and only interrupt me for real exceptions.',
    })

    expect(message.response).toContain('Current lanes:')
    expect(message.snapshot.company?.metrics.ownerTouchCount).toBe(1)
  })

  test('refresh updates the existing company in place and retires roles that lose evidence', async () => {
    const repoRoot = await createTempRepo()
    const onboarded = await onboardCompany(repoRoot, {
      websiteUrl: 'https://example.com',
      socialUrls: ['https://linkedin.com/company/acmeflow'],
    })

    const setMode = Reflect.get(
      globalThis,
      '__ccCompanyTestSetMode',
    ) as ((mode: ExampleSiteMode) => void) | undefined
    setMode?.('services')

    const refreshed = await refreshCompanyBrief(repoRoot, onboarded.company?.id)

    expect(refreshed.company?.id).toBe(onboarded.company?.id)
    expect(refreshed.company?.companyName).toBe('AcmeFlow')
    expect(refreshed.company?.businessArchetype).toBe('agency')
    expect(
      refreshed.specialistAgents.some(role => role.status === 'retired'),
    ).toBeTrue()
    expect(refreshed.metrics.pmRetiredAgentCount).toBeGreaterThan(0)

    const companyCount = await withHostedHarnessState(state => {
      return Object.keys(state.companyOps.companies).length
    })
    expect(companyCount).toBe(1)
  })

  test('refresh requeues failed workstreams and resolves stale gaps after a successful rerun', async () => {
    const repoRoot = await createTempRepo()
    const onboarded = await onboardCompany(repoRoot, {
      websiteUrl: 'https://example.com',
    })
    const companyId = onboarded.company?.id
    const failedWorkstream = onboarded.workstreams.find(workstream =>
      workstream.title.includes('Growth lane sprint'),
    )

    expect(companyId).toBeDefined()
    expect(failedWorkstream?.jobInstanceId).toBeDefined()

    await withHostedHarnessState(async state => {
      const job = state.jobs[failedWorkstream!.jobInstanceId!]
      job.status = 'failed'
      job.outcomeSummary = 'Local PM runner exited before producing the deliverable.'
      job.failureTags = ['product_bug']
      job.completedAt = '2026-04-19T12:10:00.000Z'
      return state
    })

    const refreshed = await refreshCompanyBrief(repoRoot, companyId)
    const refreshedWorkstream = refreshed.workstreams.find(
      workstream => workstream.id === failedWorkstream!.id,
    )

    expect(refreshedWorkstream?.status).toBe('queued')
    expect(refreshedWorkstream?.jobInstanceId).not.toBe(failedWorkstream?.jobInstanceId)
    expect(refreshed.gaps.some(gap => gap.workstreamId === failedWorkstream?.id)).toBeTrue()

    await withHostedHarnessState(async state => {
      const rerunJob =
        state.jobs[state.companyOps.workstreams[failedWorkstream!.id]!.jobInstanceId!]
      rerunJob.status = 'completed'
      rerunJob.outcomeSummary = `Market opportunity refresh:

- Competitor positioning remains fragmented across outbound automation and support ops.
- The clearest market opportunity is packaging growth and customer-ops together for lean teams.
- Recommended next actions: tighten positioning, build a growth campaign around this wedge, and create an outreach sequence for founder-led pipeline motion.`
      rerunJob.completedAt = '2026-04-19T12:20:00.000Z'
      return state
    })

    const mission = await getCompanyMissionControl(repoRoot, companyId)
    const rerunGap = mission.gaps.find(gap => gap.workstreamId === failedWorkstream?.id)
    const settledWorkstream = mission.workstreams.find(
      workstream => workstream.id === failedWorkstream?.id,
    )

    expect(settledWorkstream?.status).toBe('completed')
    expect(rerunGap?.status).toBe('resolved')
  })

  test('demotes intake-only completions into product gaps and requeues them on refresh', async () => {
    const repoRoot = await createTempRepo()
    const onboarded = await onboardCompany(repoRoot, {
      websiteUrl: 'https://example.com',
    })
    const companyId = onboarded.company?.id
    const marketMap = onboarded.workstreams.find(workstream =>
      workstream.title.includes('Growth lane sprint'),
    )

    expect(companyId).toBeDefined()
    expect(marketMap?.jobInstanceId).toBeDefined()

    await withHostedHarnessState(async state => {
      const job = state.jobs[marketMap!.jobInstanceId!]
      job.status = 'completed'
      job.outcomeSummary = `\`\`\`json
{
  "phase": "intake",
  "summary": "Cold-start intake only.",
  "proposedActions": ["Discover the market"],
  "nextPhase": "discover"
}
\`\`\``
      job.completedAt = '2026-04-19T12:12:00.000Z'
      return state
    })

    const mission = await getCompanyMissionControl(repoRoot, companyId)
    const hollowWorkstream = mission.workstreams.find(
      workstream => workstream.id === marketMap!.id,
    )
    const productGap = mission.gaps.find(gap => gap.workstreamId === marketMap?.id)

    expect(hollowWorkstream?.status).toBe('blocked')
    expect(hollowWorkstream?.lastOutcome).toContain('intake-phase planning')
    expect(productGap?.kind).toBe('product')
    expect(
      mission.metrics.successCountsByDomain['market-intel'] ?? 0,
    ).toBe(0)

    const refreshed = await refreshCompanyBrief(repoRoot, companyId)
    const requeued = refreshed.workstreams.find(
      workstream => workstream.id === marketMap!.id,
    )

    expect(requeued?.status).toBe('queued')
    expect(requeued?.jobInstanceId).not.toBe(marketMap?.jobInstanceId)
  })

  test('treats social-profile URLs as bounded social evidence instead of same-host website crawls', async () => {
    const repoRoot = await createTempRepo()
    const setMode = Reflect.get(
      globalThis,
      '__ccCompanyTestSetMode',
    ) as ((mode: ExampleSiteMode) => void) | undefined
    const requestedUrls = Reflect.get(
      globalThis,
      '__ccCompanyTestRequestedUrls',
    ) as string[] | undefined
    setMode?.('instagram')

    const onboarded = await onboardCompany(repoRoot, {
      websiteUrl: 'https://www.instagram.com/designgaga78/',
    })

    expect(onboarded.company?.companyName).toBe('Design Gaga')
    expect(onboarded.company?.businessArchetype).toBe('agency')
    expect(onboarded.company?.graph.signals).toHaveLength(1)
    expect(onboarded.company?.graph.demandChannels).toContain('social')
    expect(
      onboarded.company?.graph.evidence.some(line =>
        line.toLowerCase().includes('pricing'),
      ),
    ).toBeFalse()
    expect(
      requestedUrls?.some(url =>
        url.includes('/pricing') ||
        url.includes('/docs') ||
        url.includes('/careers'),
      ),
    ).toBeFalse()
  })

  test('synthesizes an owner-usable executive brief instead of keeping the review-only placeholder', async () => {
    const repoRoot = await createTempRepo()
    const onboarded = await onboardCompany(repoRoot, {
      websiteUrl: 'https://example.com',
    })
    const executiveBrief = onboarded.workstreams.find(workstream =>
      workstream.title.includes('Executive brief'),
    )

    expect(executiveBrief?.jobInstanceId).toBeDefined()

    await withHostedHarnessState(async state => {
      const job = state.jobs[executiveBrief!.jobInstanceId!]
      job.status = 'completed'
      job.outcomeSummary = 'review-only job executed without worker session'
      job.completedAt = '2026-04-19T12:40:00.000Z'
      return state
    })

    const mission = await getCompanyMissionControl(repoRoot, onboarded.company?.id)
    const refreshedBrief = mission.workstreams.find(
      workstream => workstream.id === executiveBrief!.id,
    )

    expect(refreshedBrief?.status).toBe('completed')
    expect(refreshedBrief?.lastOutcome).toContain('# Executive Brief')
    expect(refreshedBrief?.lastOutcome).not.toBe(
      'review-only job executed without worker session',
    )
  })

  test('applies mission control actions through the PM-only snapshot/action layer', async () => {
    const repoRoot = await createTempRepo()
    const onboarded = await onboardCompany(repoRoot, {
      websiteUrl: 'https://example.com',
    })
    const companyId = onboarded.company?.id
    const blockedWorkstream = onboarded.workstreams[0]

    await withHostedHarnessState(async state => {
      const job = state.jobs[blockedWorkstream!.jobInstanceId!]
      job.status = 'blocked'
      job.outcomeSummary = 'Waiting for the owner to authorize CRM access.'
      job.failureTags = ['owner_action_required', 'connector_required']
      job.completedAt = '2026-04-19T12:30:00.000Z'
      return state
    })

    const loaded = await applyMissionControlAction(repoRoot, {
      type: 'load_snapshot',
      companyId,
    })
    expect(loaded.snapshot.company?.id).toBe(companyId)
    expect(loaded.snapshot.exceptions.length).toBeGreaterThan(0)
    expect(loaded.snapshot.gaps.length).toBe(0)

    const message = await applyMissionControlAction(repoRoot, {
      type: 'send_pm_message',
      companyId,
      text: 'Keep me out of the weeds unless you need a real decision.',
    })
    expect(message.response).toContain('Current lanes:')
    expect(message.snapshot.metrics.ownerTouchCount).toBe(1)

    const resolved = await applyMissionControlAction(repoRoot, {
      type: 'resolve_exception',
      companyId,
      exceptionId: loaded.snapshot.exceptions[0]!.id,
      resolution: 'Owner approved CRM access later.',
    })
    expect(
      resolved.snapshot.exceptions.every(exception => exception.status !== 'open'),
    ).toBeTrue()

    const connector = loaded.snapshot.connectorRecommendations[0]
    expect(connector).toBeDefined()
    const connectorUpdate = await applyMissionControlAction(repoRoot, {
      type: 'update_connector_recommendation',
      companyId,
      recommendationId: connector!.id,
      status: 'accepted',
    })
    expect(
      connectorUpdate.snapshot.connectorRecommendations.find(
        recommendation => recommendation.id === connector!.id,
      )?.status,
    ).toBe('accepted')
    expect(connectorUpdate.snapshot.packs.length).toBeGreaterThan(0)
  })
})
