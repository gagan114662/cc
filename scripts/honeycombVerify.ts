import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseSettingsFile } from 'src/utils/settings/settings.js'

type HoneycombConfig = {
  apiBaseUrl: string
  dataset: string
  serviceName: string
  ingestKey?: string
  queryKey?: string
}

type QuerySpec = {
  calculations: Array<Record<string, unknown>>
  breakdowns?: string[]
  filters?: Array<Record<string, unknown>>
  orders?: Array<Record<string, unknown>>
  limit?: number
  time_range: number
}

type QueryResultRow = {
  data: Record<string, string | number | boolean | null>
}

type HoneycombQueryResult = {
  complete: boolean
  id: string
  data?: {
    results?: QueryResultRow[]
  }
  query?: QuerySpec
  links?: {
    query_url?: string
    graph_image_url?: string
  }
}

type VerificationSummary = {
  authType: string
  authEnvironment?: string
  authTeam?: string
  dataset: string
  serviceName: string
  eventCounts: Array<{ eventName: string; count: number }>
  claudeSessionCounts: Array<{ eventType: string; count: number }>
  recentClaudeSessions: Array<{
    sessionId: string
    eventType: string
    count: number
    failureTags: string
    result: string
  }>
  hasClaudeSessionEvents: boolean
  verdict:
    | 'working'
    | 'no_claude_session_events'
    | 'query_key_missing'
    | 'wrong_key_type'
  queryUrl?: string
  generatedAt: string
}

function usage(): never {
  console.error(
    'Usage: bun ./scripts/honeycombVerify.ts [--json] [--html <output.html>] [--since-hours <n>]',
  )
  process.exit(1)
}

function parseArgs(argv: string[]): {
  json: boolean
  htmlPath?: string
  sinceHours: number
} {
  let json = false
  let htmlPath: string | undefined
  let sinceHours = 24 * 7

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--html') {
      htmlPath = argv[index + 1]
      index += 1
      if (!htmlPath) {
        usage()
      }
      continue
    }
    if (arg === '--since-hours') {
      const value = Number(argv[index + 1])
      index += 1
      if (!Number.isFinite(value) || value <= 0) {
        usage()
      }
      sinceHours = value
      continue
    }
    usage()
  }

  return { json, htmlPath, sinceHours }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function otlpHeadersToParts(value: string | undefined): Record<string, string> {
  if (!value) {
    return {}
  }
  return Object.fromEntries(
    value
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const [key, ...rest] = part.split('=')
        return [key, rest.join('=')]
      }),
  )
}

function loadHoneycombConfig(repoRoot: string): HoneycombConfig {
  const settingsPath = path.join(repoRoot, '.claude', 'settings.local.json')
  const { settings, errors } = parseSettingsFile(settingsPath)
  if (errors.length > 0) {
    throw new Error(
      `Failed to parse ${settingsPath}: ${errors.map(error => error.message).join('; ')}`,
    )
  }

  const env = settings?.env ?? {}
  const otlpParts = otlpHeadersToParts(env.OTEL_EXPORTER_OTLP_HEADERS)
  return {
    apiBaseUrl:
      env.HONEYCOMB_API_BASE_URL ??
      env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/:443$/, '') ??
      'https://api.honeycomb.io',
    dataset: env.HONEYCOMB_DATASET ?? otlpParts['x-honeycomb-dataset'] ?? '',
    serviceName: env.HONEYCOMB_SERVICE_NAME ?? env.OTEL_SERVICE_NAME ?? '',
    ingestKey: env.HONEYCOMB_INGEST_KEY ?? otlpParts['x-honeycomb-team'],
    queryKey: env.HONEYCOMB_QUERY_KEY,
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Keep raw text fallback.
  }
  return { status: response.status, body }
}

async function authenticateHoneycomb(
  apiBaseUrl: string,
  key: string,
): Promise<{
  type: string
  team?: string
  environment?: string
}> {
  const { status, body } = await fetchJson(`${apiBaseUrl}/1/auth`, {
    headers: {
      'X-Honeycomb-Team': key,
    },
  })
  if (status !== 200 || typeof body !== 'object' || body == null) {
    throw new Error(`Honeycomb auth failed with status ${status}.`)
  }
  const parsed = body as {
    type?: string
    team?: { slug?: string; name?: string }
    environment?: { slug?: string; name?: string }
  }
  return {
    type: parsed.type ?? 'unknown',
    team: parsed.team?.slug ?? parsed.team?.name,
    environment: parsed.environment?.slug ?? parsed.environment?.name,
  }
}

async function createQuery(
  config: HoneycombConfig,
  queryKey: string,
  query: QuerySpec,
): Promise<string> {
  const { status, body } = await fetchJson(
    `${config.apiBaseUrl}/1/queries/${config.dataset}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Honeycomb-Team': queryKey,
      },
      body: JSON.stringify(query),
    },
  )

  if (status !== 200 || typeof body !== 'object' || body == null) {
    throw new Error(`Honeycomb query creation failed with status ${status}.`)
  }

  const queryId = (body as { id?: string }).id
  if (!queryId) {
    throw new Error('Honeycomb query creation did not return a query id.')
  }
  return queryId
}

async function runQuery(
  config: HoneycombConfig,
  queryKey: string,
  queryId: string,
): Promise<HoneycombQueryResult> {
  const createResult = await fetchJson(
    `${config.apiBaseUrl}/1/query_results/${config.dataset}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Honeycomb-Team': queryKey,
      },
      body: JSON.stringify({
        query_id: queryId,
        disable_series: true,
        disable_total_by_aggregate: true,
        disable_other_by_aggregate: true,
        limit: 1000,
      }),
    },
  )

  if (
    createResult.status !== 201 ||
    typeof createResult.body !== 'object' ||
    createResult.body == null
  ) {
    throw new Error(
      `Honeycomb query result creation failed with status ${createResult.status}.`,
    )
  }

  const resultId = (createResult.body as { id?: string }).id
  if (!resultId) {
    throw new Error('Honeycomb query result creation did not return a result id.')
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const fetched = await fetchJson(
      `${config.apiBaseUrl}/1/query_results/${config.dataset}/${resultId}`,
      {
        headers: {
          'X-Honeycomb-Team': queryKey,
        },
      },
    )
    if (
      fetched.status === 200 &&
      typeof fetched.body === 'object' &&
      fetched.body != null
    ) {
      const result = fetched.body as HoneycombQueryResult
      if (result.complete) {
        return result
      }
    }
    await Bun.sleep(500)
  }

  throw new Error('Honeycomb query result did not complete in time.')
}

function readCountRow(
  row: QueryResultRow,
  key: string,
): number {
  const value = row.data[key]
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function buildHtml(summary: VerificationSummary): string {
  const verdictText =
    summary.verdict === 'working'
      ? 'Honeycomb can see the Claude-session lane.'
      : summary.verdict === 'no_claude_session_events'
        ? 'Honeycomb query access works, but Claude-session events have not shown up yet.'
        : summary.verdict === 'wrong_key_type'
          ? 'Honeycomb access is configured with the wrong key type. A configuration key is required for queries.'
          : 'Honeycomb query access is not configured yet.'

  const eventRows = summary.eventCounts
    .map(
      row =>
        `<tr><td>${escapeHtml(row.eventName)}</td><td>${row.count}</td></tr>`,
    )
    .join('')
  const claudeRows = summary.claudeSessionCounts
    .map(
      row => `<tr><td>${escapeHtml(row.eventType)}</td><td>${row.count}</td></tr>`,
    )
    .join('')
  const recentRows = summary.recentClaudeSessions
    .map(
      row =>
        `<tr><td>${escapeHtml(row.sessionId)}</td><td>${escapeHtml(row.eventType)}</td><td>${row.count}</td><td>${escapeHtml(row.result)}</td><td>${escapeHtml(row.failureTags || 'none')}</td></tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Honeycomb Autoresearch Proof</title>
    <style>
      :root {
        --bg: #f7f4ed;
        --ink: #1d1b18;
        --muted: #6d665e;
        --line: #d4c6b6;
        --panel: #fffaf2;
        --accent: #0f766e;
        --warn: #9a3412;
      }
      body {
        margin: 0;
        font-family: Georgia, 'Times New Roman', serif;
        background: radial-gradient(circle at top, #fffaf2 0%, var(--bg) 60%);
        color: var(--ink);
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 40px 24px 80px;
      }
      h1, h2 {
        margin: 0 0 12px;
      }
      p {
        line-height: 1.5;
      }
      .hero, section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 24px;
        box-shadow: 0 12px 40px rgba(29, 27, 24, 0.06);
      }
      .hero {
        margin-bottom: 20px;
      }
      .meta {
        color: var(--muted);
        font-size: 14px;
      }
      .verdict {
        display: inline-block;
        margin-top: 12px;
        padding: 10px 14px;
        border-radius: 999px;
        background: ${summary.verdict === 'working' ? 'rgba(15,118,110,0.12)' : 'rgba(154,52,18,0.12)'};
        color: ${summary.verdict === 'working' ? 'var(--accent)' : 'var(--warn)'};
        font-weight: 600;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 20px;
        margin-top: 20px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 10px 8px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      th {
        font-size: 13px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .stack {
        display: grid;
        gap: 20px;
      }
      code {
        font-family: 'SFMono-Regular', Menlo, monospace;
        font-size: 13px;
      }
      a {
        color: var(--accent);
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero" id="overview">
        <p class="meta">Generated ${escapeHtml(summary.generatedAt)}</p>
        <h1>Honeycomb Autoresearch Proof</h1>
        <p>${escapeHtml(verdictText)}</p>
        <div class="verdict">${escapeHtml(summary.verdict)}</div>
      </section>
      <div class="grid">
        <section>
          <h2>Config</h2>
          <p><strong>Dataset:</strong> <code>${escapeHtml(summary.dataset)}</code></p>
          <p><strong>Service:</strong> <code>${escapeHtml(summary.serviceName)}</code></p>
          <p><strong>Auth Type:</strong> <code>${escapeHtml(summary.authType)}</code></p>
          <p><strong>Team:</strong> <code>${escapeHtml(summary.authTeam ?? 'unknown')}</code></p>
          <p><strong>Environment:</strong> <code>${escapeHtml(summary.authEnvironment ?? 'unknown')}</code></p>
          ${
            summary.queryUrl
              ? `<p><a href="${escapeHtml(summary.queryUrl)}">Open Honeycomb Query</a></p>`
              : ''
          }
        </section>
        <section>
          <h2>Claude Lane</h2>
          <p><strong>Claude-session events present:</strong> ${summary.hasClaudeSessionEvents ? 'yes' : 'no'}</p>
          <p><strong>Event types seen:</strong> ${escapeHtml(summary.claudeSessionCounts.map(row => row.eventType).join(', ') || 'none')}</p>
        </section>
      </div>
      <div class="stack" style="margin-top: 20px;">
        <section>
          <h2>Event Counts</h2>
          <table>
            <thead><tr><th>Event Name</th><th>Count</th></tr></thead>
            <tbody>${eventRows || '<tr><td colspan="2">No matching events found.</td></tr>'}</tbody>
          </table>
        </section>
        <section>
          <h2>Claude Session Event Types</h2>
          <table>
            <thead><tr><th>Claude Event Type</th><th>Count</th></tr></thead>
            <tbody>${claudeRows || '<tr><td colspan="2">No Claude-session events found.</td></tr>'}</tbody>
          </table>
        </section>
        <section>
          <h2>Recent Claude Sessions</h2>
          <table>
            <thead><tr><th>Session ID</th><th>Event Type</th><th>Count</th><th>Result</th><th>Failure Tags</th></tr></thead>
            <tbody>${recentRows || '<tr><td colspan="5">No recent Claude-session events found.</td></tr>'}</tbody>
          </table>
        </section>
      </div>
    </main>
  </body>
</html>`
}

async function writeHtmlReport(filePath: string, summary: VerificationSummary) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${buildHtml(summary)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, '..')
  const args = parseArgs(process.argv.slice(2))
  const config = loadHoneycombConfig(repoRoot)

  if (!config.dataset || !config.serviceName) {
    throw new Error(
      'Missing Honeycomb dataset or service name. Check .claude/settings.local.json.',
    )
  }

  const queryKey = config.queryKey || config.ingestKey
  if (!queryKey) {
    const summary: VerificationSummary = {
      authType: 'missing',
      dataset: config.dataset,
      serviceName: config.serviceName,
      eventCounts: [],
      claudeSessionCounts: [],
      recentClaudeSessions: [],
      hasClaudeSessionEvents: false,
      verdict: 'query_key_missing',
      generatedAt: new Date().toISOString(),
    }
    if (args.htmlPath) {
      await writeHtmlReport(path.resolve(repoRoot, args.htmlPath), summary)
    }
    console.log(JSON.stringify(summary, null, 2))
    process.exit(1)
  }

  const auth = await authenticateHoneycomb(config.apiBaseUrl, queryKey)
  if (auth.type !== 'configuration') {
    const summary: VerificationSummary = {
      authType: auth.type,
      authEnvironment: auth.environment,
      authTeam: auth.team,
      dataset: config.dataset,
      serviceName: config.serviceName,
      eventCounts: [],
      claudeSessionCounts: [],
      recentClaudeSessions: [],
      hasClaudeSessionEvents: false,
      verdict: 'wrong_key_type',
      generatedAt: new Date().toISOString(),
    }
    if (args.htmlPath) {
      await writeHtmlReport(path.resolve(repoRoot, args.htmlPath), summary)
    }
    console.log(JSON.stringify(summary, null, 2))
    process.exit(1)
  }

  const timeRange = Math.round(args.sinceHours * 60 * 60)
  const baseFilters = [
    { column: 'service.name', op: '=', value: config.serviceName },
  ]

  const eventsQueryId = await createQuery(config, queryKey, {
    calculations: [{ op: 'COUNT' }],
    breakdowns: ['event.name'],
    filters: baseFilters,
    orders: [{ op: 'COUNT', order: 'descending' }],
    limit: 100,
    time_range: timeRange,
  })
  const eventsResult = await runQuery(config, queryKey, eventsQueryId)
  const eventCounts =
    eventsResult.data?.results?.map(row => ({
      eventName: normalizeString(row.data['event.name']),
      count: readCountRow(row, 'COUNT'),
    })) ?? []

  const claudeTypeQueryId = await createQuery(config, queryKey, {
    calculations: [{ op: 'COUNT' }],
    breakdowns: ['autoresearch.claude_code_event_type'],
    filters: [
      ...baseFilters,
      {
        column: 'event.name',
        op: '=',
        value: 'autoresearch_claude_code_session_observed',
      },
    ],
    orders: [{ op: 'COUNT', order: 'descending' }],
    limit: 20,
    time_range: timeRange,
  })
  const claudeTypeResult = await runQuery(config, queryKey, claudeTypeQueryId)
  const claudeSessionCounts =
    claudeTypeResult.data?.results?.map(row => ({
      eventType: normalizeString(row.data['autoresearch.claude_code_event_type']),
      count: readCountRow(row, 'COUNT'),
    })) ?? []

  const claudeRecentQueryId = await createQuery(config, queryKey, {
    calculations: [{ op: 'COUNT' }],
    breakdowns: [
      'autoresearch.claude_code_session_id',
      'autoresearch.claude_code_event_type',
      'autoresearch.claude_code_failure_tags',
      'autoresearch.claude_code_result',
    ],
    filters: [
      ...baseFilters,
      {
        column: 'event.name',
        op: '=',
        value: 'autoresearch_claude_code_session_observed',
      },
    ],
    orders: [{ op: 'COUNT', order: 'descending' }],
    limit: 20,
    time_range: timeRange,
  })
  const claudeRecentResult = await runQuery(config, queryKey, claudeRecentQueryId)
  const recentClaudeSessions =
    claudeRecentResult.data?.results?.map(row => ({
      sessionId: normalizeString(row.data['autoresearch.claude_code_session_id']),
      eventType: normalizeString(
        row.data['autoresearch.claude_code_event_type'],
      ),
      failureTags: normalizeString(
        row.data['autoresearch.claude_code_failure_tags'],
      ),
      result: normalizeString(row.data['autoresearch.claude_code_result']),
      count: readCountRow(row, 'COUNT'),
    })) ?? []

  const hasClaudeSessionEvents = recentClaudeSessions.length > 0
  const summary: VerificationSummary = {
    authType: auth.type,
    authEnvironment: auth.environment,
    authTeam: auth.team,
    dataset: config.dataset,
    serviceName: config.serviceName,
    eventCounts,
    claudeSessionCounts,
    recentClaudeSessions,
    hasClaudeSessionEvents,
    verdict: hasClaudeSessionEvents ? 'working' : 'no_claude_session_events',
    queryUrl: claudeRecentResult.links?.query_url ?? eventsResult.links?.query_url,
    generatedAt: new Date().toISOString(),
  }

  if (args.htmlPath) {
    await writeHtmlReport(path.resolve(repoRoot, args.htmlPath), summary)
  }

  if (args.json || !args.htmlPath) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`wrote ${path.resolve(repoRoot, args.htmlPath)}`)
  }
}

await main()
