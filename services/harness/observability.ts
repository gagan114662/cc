type HarnessObservabilityExportConfig = {
  apiBaseUrl: string
  dataset: string
  exportEndpoint?: string
  ingestKey: string
  queryKey?: string
}

type HarnessObservabilityHeartbeatResult = {
  ok: boolean
  exportedAt?: string
  error?: string
  config: HarnessObservabilityExportConfig | null
}

function parseOtlpHeaders(
  value: string | undefined,
): Record<string, string> {
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

function normalizeApiBaseUrl(endpoint: string | undefined): string {
  if (!endpoint) {
    return 'https://api.honeycomb.io'
  }
  return endpoint
    .replace(/\/v1\/(logs|metrics|traces).*$/i, '')
    .replace(/:443$/i, '')
    .replace(/\/$/, '')
}

export function loadHarnessObservabilityExportConfig(
  env: NodeJS.ProcessEnv = process.env,
): HarnessObservabilityExportConfig | null {
  if ((env.CLAUDE_CODE_ENABLE_TELEMETRY ?? '').toLowerCase() !== 'true') {
    return null
  }
  const otlpHeaders = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
  const ingestKey = env.HONEYCOMB_INGEST_KEY ?? otlpHeaders['x-honeycomb-team']
  const dataset = env.HONEYCOMB_DATASET ?? otlpHeaders['x-honeycomb-dataset']
  if (!ingestKey || !dataset) {
    return null
  }
  return {
    apiBaseUrl: normalizeApiBaseUrl(
      env.HONEYCOMB_API_BASE_URL ?? env.OTEL_EXPORTER_OTLP_ENDPOINT,
    ),
    dataset,
    exportEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    ingestKey,
    queryKey: env.HONEYCOMB_QUERY_KEY,
  }
}

export function isHarnessObservabilityEnvLoaded(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return loadHarnessObservabilityExportConfig(env) != null
}

export async function emitHarnessObservabilityHeartbeat(input: {
  eventName: string
  metadata: Record<string, string | number | boolean | undefined>
  env?: NodeJS.ProcessEnv
}): Promise<HarnessObservabilityHeartbeatResult> {
  const config = loadHarnessObservabilityExportConfig(input.env)
  if (!config) {
    return {
      ok: false,
      error: 'missing_honeycomb_export_config',
      config: null,
    }
  }

  const exportedAt = new Date().toISOString()
  const response = await fetch(
    `${config.apiBaseUrl}/1/events/${encodeURIComponent(config.dataset)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Honeycomb-Team': config.ingestKey,
      },
      body: JSON.stringify({
        timestamp: exportedAt,
        event_name: input.eventName,
        service_name: process.env.HONEYCOMB_SERVICE_NAME ?? 'cc-harness',
        ...Object.fromEntries(
          Object.entries(input.metadata).filter(([, value]) => value != null),
        ),
      }),
    },
  )

  if (response.ok) {
    return {
      ok: true,
      exportedAt,
      config,
    }
  }

  return {
    ok: false,
    error: `honeycomb_export_failed:${response.status}`,
    config,
  }
}

export async function authenticateHarnessObservability(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  ok: boolean
  authType?: string
  team?: string
  environment?: string
  error?: string
}> {
  const config = loadHarnessObservabilityExportConfig(env)
  if (!config) {
    return {
      ok: false,
      error: 'missing_honeycomb_export_config',
    }
  }

  const response = await fetch(`${config.apiBaseUrl}/1/auth`, {
    headers: {
      'X-Honeycomb-Team': config.ingestKey,
    },
  })
  if (!response.ok) {
    return {
      ok: false,
      error: `honeycomb_auth_failed:${response.status}`,
    }
  }

  const body = (await response.json()) as {
    type?: string
    team?: { slug?: string; name?: string }
    environment?: { slug?: string; name?: string }
  }
  return {
    ok: true,
    authType: body.type,
    team: body.team?.slug ?? body.team?.name,
    environment: body.environment?.slug ?? body.environment?.name,
  }
}
