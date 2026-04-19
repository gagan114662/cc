import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { isPolicyAllowed } from 'src/services/policyLimits/index.js'
import { parseGitRemote } from 'src/utils/detectRepository.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import {
  CCR_BYOC_BETA,
  getOAuthHeaders,
  prepareApiRequest,
  REMOTE_CLAUDE_CODE_REQUIRED_SCOPES,
} from 'src/utils/teleport/api.js'
import {
  createDefaultCloudEnvironment,
  fetchEnvironments,
  type EnvironmentResource,
} from 'src/utils/teleport/environments.js'
import type { ShellCommandRunner } from './shell.js'
import type { HarnessConfig, JobSpec, QueuedHarnessJob } from './types.js'
import { createStableId } from './utils.js'

const TRIGGERS_BETA = 'ccr-triggers-2026-01-30'
const DEFAULT_TRIGGER_CRON_EXPRESSION = '0 0 * * *'
const DEFAULT_REMOTE_TRIGGER_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
] as const

type RemoteTriggerRequestInput = {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  data?: unknown
}

type RemoteTriggerRequestOutput = {
  status: number
  data: unknown
}

type RemoteTriggerRequest = (
  input: RemoteTriggerRequestInput,
) => Promise<RemoteTriggerRequestOutput>

export type RemoteTriggerDispatchResult = {
  ok: boolean
  mode: 'shadow' | 'primary'
  summary: string
  backend?: 'session' | 'trigger'
  sessionId?: string
  triggerId?: string
  observationMode?: 'session' | 'trigger'
  persistSessionRequested?: boolean
  persistSessionObserved?: boolean | null
}

export type RemoteTriggerDependencies = {
  request?: RemoteTriggerRequest
  refreshAuth?: () => Promise<unknown>
  prepareApiRequest?: () => Promise<{ accessToken: string; orgUUID: string }>
  isFeatureEnabled?: () => boolean
  isPolicyAllowed?: () => boolean
  fetchEnvironments?: () => Promise<EnvironmentResource[]>
  createDefaultEnvironment?: (name: string) => Promise<EnvironmentResource>
  getDefaultEnvironmentId?: () => string | undefined
  uuid?: () => string
}

function createDefaultRequest(): RemoteTriggerRequest {
  return async input => {
    const response = await axios.request({
      method: input.method,
      url: input.url,
      headers: input.headers,
      data: input.data,
      timeout: 20_000,
      validateStatus: () => true,
    })
    return {
      status: response.status,
      data: response.data,
    }
  }
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'job'
}

function buildTriggerName(
  repoUrl: string,
  jobSpec: JobSpec,
  job: QueuedHarnessJob,
): string {
  const parsedRepo = parseGitRemote(repoUrl)
  const repoLabel = parsedRepo
    ? `${parsedRepo.owner}-${parsedRepo.name}`
    : repoUrl.split('/').filter(Boolean).slice(-2).join('-')
  const hash = createStableId(job.jobId, job.concurrencyKey)
  return slugify(`cc-harness-${repoLabel}-${jobSpec.id}-${hash}`).slice(0, 96)
}

function buildRemotePrompt(jobSpec: JobSpec, job: QueuedHarnessJob): string {
  const sections = [
    'You are the remote shadow execution for a CC harness job.',
    'A local harness lane may also be active. Execute autonomously and do not wait for human approval.',
    `Preferred runtime: ${jobSpec.agentKind}`,
    `Job: ${jobSpec.title}`,
    `Kind: ${jobSpec.kind}`,
    `Primary instructions:\n${job.prompt}`,
    jobSpec.verification.commands.length > 0
      ? `Verification commands to respect:\n- ${jobSpec.verification.commands.join('\n- ')}`
      : '',
  ]
  return sections.filter(Boolean).join('\n\n')
}

function buildSessionTitle(jobSpec: JobSpec, job: QueuedHarnessJob): string {
  return `Harness ${jobSpec.agentKind}: ${jobSpec.title} [${job.instanceId}]`.slice(
    0,
    120,
  )
}

function extractTriggerId(
  value: unknown,
  depth: number = 0,
): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (!value || typeof value !== 'object' || depth > 2) {
    return null
  }

  const record = value as Record<string, unknown>
  const direct =
    (typeof record.trigger_id === 'string' && record.trigger_id) ||
    (typeof record.id === 'string' && record.id) ||
    null
  if (direct) {
    return direct
  }

  for (const nested of Object.values(record)) {
    const candidate = extractTriggerId(nested, depth + 1)
    if (candidate) {
      return candidate
    }
  }

  return null
}

function extractTriggerResource(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const trigger =
    record.trigger && typeof record.trigger === 'object'
      ? (record.trigger as Record<string, unknown>)
      : record
  return trigger
}

function extractSessionId(
  value: unknown,
  depth: number = 0,
): string | null {
  if (!value || typeof value !== 'object' || depth > 2) {
    return null
  }
  const record = value as Record<string, unknown>
  const direct =
    (typeof record.session_id === 'string' && record.session_id) ||
    (typeof record.id === 'string' && record.id) ||
    null
  if (direct) {
    return direct
  }

  for (const nested of Object.values(record)) {
    const candidate = extractSessionId(nested, depth + 1)
    if (candidate) {
      return candidate
    }
  }

  return null
}

async function resolveRepositoryUrl(
  repoRoot: string,
  runner: ShellCommandRunner,
): Promise<string | null> {
  const result = await runner('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
  })
  if (result.code !== 0) {
    return null
  }

  const parsed = parseGitRemote(result.stdout.trim())
  if (!parsed) {
    return null
  }

  return `https://${parsed.host}/${parsed.owner}/${parsed.name}`
}

async function resolveRepositoryRevision(
  repoRoot: string,
  runner: ShellCommandRunner,
): Promise<string | undefined> {
  const result = await runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
  })
  if (result.code !== 0) {
    return undefined
  }

  const revision = result.stdout.trim()
  if (!revision || revision === 'HEAD') {
    return undefined
  }
  return revision
}

async function resolveEnvironmentId(
  config: HarnessConfig,
  deps: Required<RemoteTriggerDependencies>,
): Promise<string> {
  const preferredEnvironmentId =
    config.sources.remoteTriggers.environmentId ??
    deps.getDefaultEnvironmentId()

  let environments: EnvironmentResource[]
  try {
    environments = await deps.fetchEnvironments()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const looksAuthLike =
      message.includes('401') ||
      message.toLowerCase().includes('authentication') ||
      message.toLowerCase().includes('unauthorized')
    if (!looksAuthLike) {
      throw error
    }
    await deps.refreshAuth()
    environments = await deps.fetchEnvironments()
  }
  if (preferredEnvironmentId) {
    const matched = environments.find(
      environment => environment.environment_id === preferredEnvironmentId,
    )
    if (matched) {
      return matched.environment_id
    }
  }

  const selected =
    environments.find(environment => environment.kind !== 'bridge') ??
    environments[0]
  if (selected) {
    return selected.environment_id
  }

  const created = await deps.createDefaultEnvironment('cc-harness-default')
  return created.environment_id
}

function getDefaultDependencies(): Required<RemoteTriggerDependencies> {
  return {
    request: createDefaultRequest(),
    refreshAuth: async () => {},
    prepareApiRequest: () =>
      prepareApiRequest({
        requiredScopes: REMOTE_CLAUDE_CODE_REQUIRED_SCOPES,
      }),
    isFeatureEnabled: () =>
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_surreal_dali', false),
    isPolicyAllowed: () => isPolicyAllowed('allow_remote_sessions'),
    fetchEnvironments,
    createDefaultEnvironment: createDefaultCloudEnvironment,
    getDefaultEnvironmentId: () =>
      getSettings_DEPRECATED()?.remote?.defaultEnvironmentId,
    uuid: () => randomUUID(),
  }
}

function buildRemoteTriggerBody(input: {
  config: HarnessConfig
  repoUrl: string
  environmentId: string
  jobSpec: JobSpec
  job: QueuedHarnessJob
  eventUuid: string
}): Record<string, unknown> {
  return {
    name: buildTriggerName(input.repoUrl, input.jobSpec, input.job),
    cron_expression: DEFAULT_TRIGGER_CRON_EXPRESSION,
    enabled: false,
    // Keep harness-triggered shadow runs observable in CCR so the daemon can
    // inspect, compare, and debug unattended work after dispatch.
    persist_session: true,
    job_config: {
      ccr: {
        environment_id: input.environmentId,
        session_context: {
          model: input.config.sources.remoteTriggers.model,
          sources: [
            {
              git_repository: {
                url: input.repoUrl,
              },
            },
          ],
          allowed_tools: [...DEFAULT_REMOTE_TRIGGER_TOOLS],
        },
        events: [
          {
            data: {
              uuid: input.eventUuid,
              session_id: '',
              type: 'user',
              parent_tool_use_id: null,
              message: {
                content: buildRemotePrompt(input.jobSpec, input.job),
                role: 'user',
              },
            },
          },
        ],
      },
    },
  }
}

function buildRemoteSessionBody(input: {
  config: HarnessConfig
  repoUrl: string
  revision?: string
  environmentId: string
  jobSpec: JobSpec
  job: QueuedHarnessJob
  eventUuid: string
  accessToken: string
}): Record<string, unknown> {
  const source: Record<string, unknown> = {
    type: 'git_repository',
    url: input.repoUrl,
  }
  if (input.revision) {
    source.revision = input.revision
  }

  return {
    title: buildSessionTitle(input.jobSpec, input.job),
    events: [
      {
        type: 'event',
        data: {
          uuid: input.eventUuid,
          session_id: '',
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: buildRemotePrompt(input.jobSpec, input.job),
          },
        },
      },
    ],
    session_context: {
      sources: [source],
      outcomes: [],
      model: input.config.sources.remoteTriggers.model,
      environment_variables: {
        CLAUDE_CODE_OAUTH_TOKEN: input.accessToken,
        CLAUDE_CODE_HARNESS_JOB_ID: input.job.instanceId,
        CLAUDE_CODE_HARNESS_REMOTE_SHADOW: '1',
        CLAUDE_CODE_HARNESS_AGENT_KIND: input.jobSpec.agentKind,
      },
    },
    environment_id: input.environmentId,
    source: 'remote-control',
  }
}

export async function dispatchHarnessJobToRemoteTrigger(
  input: {
    repoRoot: string
    config: HarnessConfig
    jobSpec: JobSpec
    job: QueuedHarnessJob
    commandRunner: ShellCommandRunner
    existingTriggerId?: string
  },
  overrides: RemoteTriggerDependencies = {},
): Promise<RemoteTriggerDispatchResult> {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  }

  if (input.config.sources.remoteTriggers.remoteApi !== 'ccr') {
    return {
      ok: false,
      mode: input.config.sources.remoteTriggers.dispatchMode,
      summary:
        'remote shadow dispatch unavailable: only the ccr remote trigger backend is supported',
    }
  }
  if (
    !['shadow', 'primary'].includes(
      input.config.sources.remoteTriggers.dispatchMode,
    )
  ) {
    return {
      ok: false,
      mode: input.config.sources.remoteTriggers.dispatchMode,
      summary:
        'remote shadow dispatch unavailable: unsupported remote trigger dispatch mode',
    }
  }
  if (!deps.isPolicyAllowed()) {
    return {
      ok: false,
      mode: input.config.sources.remoteTriggers.dispatchMode,
      summary:
        'remote shadow dispatch unavailable: remote sessions are not allowed by policy',
    }
  }

  try {
    const repoUrl = await resolveRepositoryUrl(input.repoRoot, input.commandRunner)
    if (!repoUrl) {
      return {
        ok: false,
        mode: input.config.sources.remoteTriggers.dispatchMode,
        summary:
          'remote shadow dispatch unavailable: could not resolve an origin repository URL',
      }
    }
    const revision = await resolveRepositoryRevision(
      input.repoRoot,
      input.commandRunner,
    )

    await deps.refreshAuth()
    let apiCreds: { accessToken: string; orgUUID: string }
    try {
      apiCreds = await deps.prepareApiRequest()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        mode: input.config.sources.remoteTriggers.dispatchMode,
        summary: `remote shadow dispatch unavailable: ${message}`,
      }
    }

    const environmentId = await resolveEnvironmentId(input.config, deps)
    const baseHeaders = {
      ...getOAuthHeaders(apiCreds.accessToken),
      'x-organization-uuid': apiCreds.orgUUID,
    }
    const sessionHeaders = {
      ...baseHeaders,
      'anthropic-beta': CCR_BYOC_BETA,
    }
    const headers = {
      ...baseHeaders,
      'anthropic-beta': TRIGGERS_BETA,
    }
    const sessionsUrl = `${getOauthConfig().BASE_API_URL}/v1/sessions`
    const baseUrl = `${getOauthConfig().BASE_API_URL}/v1/code/triggers`
    const sessionCreate = await deps.request({
      method: 'POST',
      url: sessionsUrl,
      headers: sessionHeaders,
      data: buildRemoteSessionBody({
        config: input.config,
        repoUrl,
        revision,
        environmentId,
        jobSpec: input.jobSpec,
        job: input.job,
        eventUuid: deps.uuid(),
        accessToken: apiCreds.accessToken,
      }),
    })
    if (sessionCreate.status >= 200 && sessionCreate.status < 300) {
      const sessionId = extractSessionId(sessionCreate.data)
      if (sessionId) {
        return {
          ok: true,
          mode: input.config.sources.remoteTriggers.dispatchMode,
          backend: 'session',
          sessionId,
          summary: `remote shadow dispatched via CCR session ${sessionId}`,
          observationMode: 'session',
        }
      }
    }

    const sessionFailureSummary =
      sessionCreate.status >= 200 && sessionCreate.status < 300
        ? 'CCR session create succeeded without returning an id'
        : `CCR session create returned ${sessionCreate.status}`
    const body = buildRemoteTriggerBody({
      config: input.config,
      repoUrl,
      environmentId,
      jobSpec: input.jobSpec,
      job: input.job,
      eventUuid: deps.uuid(),
    })

    const upsert = await deps.request({
      method: 'POST',
      url: input.existingTriggerId
        ? `${baseUrl}/${input.existingTriggerId}`
        : baseUrl,
      headers,
      data: body,
    })
    if (upsert.status < 200 || upsert.status >= 300) {
      return {
        ok: false,
        mode: input.config.sources.remoteTriggers.dispatchMode,
        triggerId: input.existingTriggerId,
        backend: 'trigger',
        summary: `remote shadow dispatch unavailable: ${sessionFailureSummary}; CCR trigger ${input.existingTriggerId ? 'update' : 'create'} returned ${upsert.status}`,
      }
    }

    const triggerId =
      extractTriggerId(upsert.data) ?? input.existingTriggerId ?? undefined
    if (!triggerId) {
      return {
        ok: false,
        mode: input.config.sources.remoteTriggers.dispatchMode,
        backend: 'trigger',
        summary: `remote shadow dispatch unavailable: ${sessionFailureSummary}; CCR trigger response did not include an id`,
      }
    }

    let persistSessionObserved: boolean | null = null
    const triggerSnapshot = await deps.request({
      method: 'GET',
      url: `${baseUrl}/${triggerId}`,
      headers,
    })
    if (triggerSnapshot.status >= 200 && triggerSnapshot.status < 300) {
      const triggerRecord = extractTriggerResource(triggerSnapshot.data)
      const persisted = triggerRecord?.persist_session
      if (typeof persisted === 'boolean') {
        persistSessionObserved = persisted
      }
    }

    const run = await deps.request({
      method: 'POST',
      url: `${baseUrl}/${triggerId}/run`,
      headers,
      data: {},
    })
    if (run.status < 200 || run.status >= 300) {
      return {
        ok: false,
        mode: input.config.sources.remoteTriggers.dispatchMode,
        triggerId,
        backend: 'trigger',
        summary: `remote shadow dispatch unavailable: ${sessionFailureSummary}; CCR trigger run returned ${run.status}`,
      }
    }

    const observationMode =
      persistSessionObserved === false ? 'trigger' : 'session'
    const summary =
      observationMode === 'trigger'
        ? `remote shadow fell back to CCR trigger ${triggerId} after ${sessionFailureSummary} (backend retained trigger-only visibility)`
        : `remote shadow fell back to CCR trigger ${triggerId} after ${sessionFailureSummary}`

    return {
      ok: true,
      mode: input.config.sources.remoteTriggers.dispatchMode,
      backend: 'trigger',
      triggerId,
      summary,
      observationMode,
      persistSessionRequested: true,
      persistSessionObserved,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      mode: input.config.sources.remoteTriggers.dispatchMode,
      summary: `remote shadow dispatch unavailable: ${message}`,
    }
  }
}
