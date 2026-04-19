import { logOTelEvent } from 'src/utils/telemetry/events.js'
import { getHostedHarnessControlPlaneInfo } from './controlPlane.js'
import type {
  AgentSessionObservation,
  HarnessConfig,
  HarnessAgentKind,
  HarnessRuntimeState,
  JobOutcome,
  QueuedHarnessJob,
} from './types.js'

type HarnessEventSeverity = 'INFO' | 'WARN' | 'ERROR'
type HarnessSystemState =
  | 'cold_start'
  | 'warming'
  | 'idle'
  | 'busy'
  | 'degraded'

function getSeverityNumber(severity: HarnessEventSeverity): number {
  switch (severity) {
    case 'ERROR':
      return 17
    case 'WARN':
      return 13
    default:
      return 9
  }
}

function includesAnyToken(
  value: string | undefined,
  tokens: string[],
): boolean {
  if (!value) {
    return false
  }
  const lower = value.toLowerCase()
  return tokens.some(token => lower.includes(token))
}

export function classifyHarnessTrafficClass(input: {
  job?: QueuedHarnessJob
  metadata?: Record<string, unknown>
}): 'system' | 'event-driven' | 'scheduled' | 'manual' | 'synthetic' {
  const metadata = input.job?.metadata ?? {}
  const requestedBy =
    typeof metadata.requestedBy === 'string' ? metadata.requestedBy.toLowerCase() : ''
  const webhookSource =
    typeof metadata.webhookSource === 'string'
      ? metadata.webhookSource.toLowerCase()
      : typeof input.metadata?.['harness.webhook_source'] === 'string'
        ? String(input.metadata['harness.webhook_source']).toLowerCase()
        : ''
  const explicitTrafficClass =
    typeof metadata.trafficClass === 'string' ? metadata.trafficClass.toLowerCase() : ''

  if (explicitTrafficClass === 'synthetic') {
    return 'synthetic'
  }
  if (
    includesAnyToken(requestedBy, ['smoke', 'demo', 'synthetic']) ||
    webhookSource === 'cli'
  ) {
    return 'synthetic'
  }

  switch (input.job?.sourceKind) {
    case 'webhook':
    case 'github':
      return 'event-driven'
    case 'cron':
      return 'scheduled'
    case 'manual':
      return requestedBy.startsWith('pm-') ? 'system' : 'manual'
    case 'remoteTrigger':
      return 'system'
    default:
      return 'system'
  }
}

export function classifyHarnessEventSeverity(input: {
  eventName: string
  outcome?: JobOutcome
  metadata?: Record<string, unknown>
}): HarnessEventSeverity {
  if (input.eventName === 'cc_harness_job_outcome') {
    if (input.outcome?.status === 'failed') {
      return 'ERROR'
    }
    if (input.outcome?.status === 'blocked') {
      return 'WARN'
    }
  }

  const failureCount = Number(input.metadata?.['cc.failure_count'] ?? '0')
  if (Number.isFinite(failureCount) && failureCount > 0) {
    return 'ERROR'
  }

  return 'INFO'
}

export function classifyAgentSessionSeverity(
  observation: AgentSessionObservation,
): HarnessEventSeverity {
  switch (observation.result) {
    case 'failure':
      return 'ERROR'
    case 'blocked':
      return 'WARN'
    default:
      return 'INFO'
  }
}

function stringifyValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value
      .map(item => stringifyValue(item))
      .filter((item): item is string => Boolean(item))
      .join(',')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function countQueued(state: HarnessRuntimeState, repoId: string): number {
  return state.queue.filter(instanceId => state.jobs[instanceId]?.repoId === repoId)
    .length
}

function countActive(state: HarnessRuntimeState, repoId: string): number {
  return Object.values(state.jobs).filter(
    job =>
      job.repoId === repoId &&
      (job.status === 'leased' || job.status === 'running'),
  ).length
}

function countHealthyWorkers(state: HarnessRuntimeState): number {
  return Object.values(state.workerHeartbeats).filter(heartbeat => heartbeat.healthy)
    .length
}

function countHealthyRunners(state: HarnessRuntimeState): number {
  return Object.values(state.runners).filter(runner => runner.healthy).length
}

export function classifyHarnessSystemState(input: {
  state?: HarnessRuntimeState
  repoId?: string
}): HarnessSystemState {
  if (!input.state || !input.repoId) {
    return 'cold_start'
  }

  const healthyWorkers = countHealthyWorkers(input.state)
  const healthyRunners = countHealthyRunners(input.state)
  const queueCount = countQueued(input.state, input.repoId)
  const activeCount = countActive(input.state, input.repoId)
  const repoHealth = input.state.repoHealth[input.repoId]?.status
  const exportFresh = input.state.observability.exportFresh
  const staleTelemetryWorkers =
    input.state.observability.telemetryStaleWorkers.length

  if (healthyWorkers === 0 || healthyRunners === 0) {
    return 'cold_start'
  }
  if (repoHealth === 'red' || repoHealth === 'paused' || staleTelemetryWorkers > 0) {
    return 'degraded'
  }
  if (!exportFresh) {
    return 'warming'
  }
  if (queueCount > 0 || activeCount > 0) {
    return 'busy'
  }
  return 'idle'
}

export async function logHarnessWideEvent(
  eventName:
    | 'cc_harness_poll_snapshot'
    | 'cc_harness_job_leased'
    | 'cc_harness_job_outcome'
    | 'cc_harness_repo_state'
    | 'cc_harness_webhook_ingested'
    | 'cc_harness_worker_lifecycle'
    | 'cc_harness_control_plane_doctor'
    | 'cc_company_onboarded'
    | 'cc_company_graph_refreshed'
    | 'cc_pm_decision_recorded'
    | 'cc_company_workstream_opened'
    | 'cc_company_workstream_updated'
    | 'cc_company_workstream_completed'
    | 'cc_company_exception_created'
    | 'cc_company_exception_resolved'
    | 'cc_company_gap_created'
    | 'cc_company_owner_message'
    | 'cc_company_connector_recommendation_updated'
    | 'cc_company_mission_snapshot',
  input: {
    repoRoot?: string
    repoId?: string
    config?: HarnessConfig
    state?: HarnessRuntimeState
    job?: QueuedHarnessJob
    outcome?: JobOutcome
    workerId?: string
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  const trafficClass = classifyHarnessTrafficClass({
    job: input.job,
    metadata: input.metadata,
  })
  const severity = classifyHarnessEventSeverity({
    eventName,
    outcome: input.outcome,
    metadata: input.metadata,
  })
  const controlPlane = getHostedHarnessControlPlaneInfo()
  const repoId = input.repoId ?? input.job?.repoId
  const systemState = classifyHarnessSystemState({
    state: input.state,
    repoId,
  })
  const repo = repoId != null ? input.state?.repos[repoId] : undefined
  const repoHealth = repoId != null ? input.state?.repoHealth[repoId] : undefined
  const repoBudget = repoId != null ? input.state?.budgets[repoId] : undefined
  const runner = input.workerId
    ? Object.values(input.state?.runners ?? {}).find(candidate =>
        candidate.workerIds.includes(input.workerId!),
      )
    : undefined
  const slotSummary = input.state
    ? Object.values(input.state.runners).reduce(
        (summary, candidate) => {
          summary.total += candidate.slotCapacity
          if (candidate.agentKind === 'claude' || candidate.agentKind === 'codex') {
            summary[candidate.agentKind] += candidate.slotCapacity
          }
          return summary
        },
        {
          total: 0,
          claude: 0,
          codex: 0,
        } satisfies Record<'total' | Exclude<HarnessAgentKind, 'either'>, number>,
      )
    : undefined
  const blockerIds = input.outcome?.reviewerDecisions
    .filter(decision => decision.status === 'block' && decision.blocking)
    .map(decision => decision.reviewerId)
  const verificationFailures = input.outcome?.verificationResults.filter(
    result => result.code !== 0,
  ).length

  const metadata = {
    'harness.control_plane_kind': controlPlane.kind,
    'harness.tenant_id': controlPlane.tenantId,
    'harness.repo_root': input.repoRoot,
    'harness.repo_id': repoId,
    'harness.repo_name_with_owner': repo?.repoNameWithOwner,
    'harness.default_branch': repo?.defaultBranch,
    'harness.remote_execution':
      repo?.remoteExecution ?? input.config?.sources.remoteTriggers.dispatchMode,
    'harness.fleet_target_slots': repo?.fleetTargetSlots,
    'harness.repo_health': repoHealth?.status ?? 'healthy',
    'harness.pause_reason': repoHealth?.pauseReason,
    'harness.system_state': systemState,
    'harness.cold_start': systemState === 'cold_start',
    'harness.worker_count': input.state
      ? Object.keys(input.state.workerHeartbeats).length
      : undefined,
    'harness.healthy_worker_count': input.state
      ? countHealthyWorkers(input.state)
      : undefined,
    'harness.runner_count': input.state
      ? Object.keys(input.state.runners).length
      : undefined,
    'harness.healthy_runner_count': input.state
      ? countHealthyRunners(input.state)
      : undefined,
    'harness.queue_count':
      repoId != null && input.state ? countQueued(input.state, repoId) : undefined,
    'harness.active_count':
      repoId != null && input.state ? countActive(input.state, repoId) : undefined,
    'harness.spent_usd': repoBudget?.spentUsd,
    'harness.budget_max_usd': repoBudget?.maxUsd,
    'harness.budget_warn_usd': repoBudget?.warnUsd,
    'harness.budget_blocked': repoBudget?.blocked,
    'harness.worker_id': input.workerId,
    'harness.runner_id': runner?.runnerId,
    'harness.runner_agent_kind': runner?.agentKind,
    'harness.runner_slot_capacity': runner?.slotCapacity,
    'harness.runner_labels': runner?.labels,
    'harness.total_slot_capacity': slotSummary?.total,
    'harness.claude_slot_capacity': slotSummary?.claude,
    'harness.codex_slot_capacity': slotSummary?.codex,
    'harness.job_instance_id': input.job?.instanceId,
    'harness.job_id': input.job?.jobId ?? input.outcome?.jobId,
    'harness.job_agent_kind': input.job?.agentKind,
    'harness.job_status': input.outcome?.status ?? input.job?.status,
    'harness.job_source_kind': input.job?.sourceKind,
    'harness.traffic_class': trafficClass,
    'harness.severity': severity,
    'harness.job_priority': input.job?.priority,
    'harness.job_attempt': input.job?.attempt ?? input.outcome?.attempt,
    'harness.job_concurrency_key': input.job?.concurrencyKey,
    'harness.execution_backend': input.outcome?.executionBackend,
    'harness.failure_tags': input.outcome?.failureTags,
    'harness.blocking_reviewers': blockerIds,
    'harness.verification_failure_count': verificationFailures,
    'harness.auto_merge_requested': input.outcome?.autoMergeRequested,
    'harness.auto_merge_result': input.outcome?.autoMergeResult,
    'harness.human_touch_count': input.outcome?.humanTouchCount,
    'harness.total_cost_usd': input.outcome?.totalCostUsd,
    'harness.regression_detected': input.outcome?.regressionDetected,
    'harness.summary': input.outcome?.summary ?? input.job?.outcomeSummary,
    'harness.internal_query_live': input.state?.observability.internalQueryLive,
    'harness.honeycomb_export_live': input.state?.observability.honeycombExportLive,
    'harness.honeycomb_query_live': input.state?.observability.honeycombQueryLive,
    'harness.export_last_success_at': input.state?.observability.exportLastSuccessAt,
    'harness.export_fresh': input.state?.observability.exportFresh,
    'harness.daemon_started_at': input.state?.daemon.startedAt,
    'harness.last_polled_at': input.state?.lastPolledAt,
    'harness.observability_loaded_workers':
      input.state?.observability.observabilityEnvLoadedWorkers.length,
    'harness.telemetry_stale_workers':
      input.state?.observability.telemetryStaleWorkers.length,
    ...input.metadata,
  }

  await logOTelEvent(
    eventName,
    Object.fromEntries(
      Object.entries(metadata)
        .map(([key, value]) => [key, stringifyValue(value)])
        .filter(([, value]) => value !== undefined),
    ),
    {
      severityText: severity,
      severityNumber: getSeverityNumber(severity),
    },
  )
}

export async function logHarnessAgentSessionObservation(
  observation: AgentSessionObservation,
): Promise<void> {
  const severity = classifyAgentSessionSeverity(observation)
  const basePayload = {
    'cc.agent_kind': observation.agentKind,
    'cc.session_id': observation.sessionId,
    'cc.job_instance_id': observation.jobInstanceId,
    'cc.runner_id': observation.runnerId,
    'cc.worker_id': observation.workerId,
    'cc.execution_backend': observation.executionBackend,
    'cc.model': observation.model,
    'cc.result': observation.result,
    'cc.failure_tags': stringifyValue(observation.failureTags),
    'cc.human_touch_count': stringifyValue(observation.humanTouchCount),
    'cc.tool_call_count': stringifyValue(observation.toolCallCount),
    'cc.runtime_ms': stringifyValue(observation.runtimeMs),
    'cc.token_cost': stringifyValue(observation.tokenCost),
    'cc.recorded_at': observation.recordedAt,
    'cc.summary': observation.summary,
    'cc.severity': severity,
  }
  await logOTelEvent('cc_agent_session_observed', basePayload, {
    severityText: severity,
    severityNumber: getSeverityNumber(severity),
  })
  if (observation.agentKind === 'codex') {
    await logOTelEvent(
      'autoresearch_codex_session_observed',
      {
        'autoresearch.codex_session_id': observation.sessionId,
        'autoresearch.codex_result': observation.result,
        'autoresearch.codex_failure_tags': stringifyValue(observation.failureTags),
        'autoresearch.codex_runtime_ms': stringifyValue(observation.runtimeMs),
        'autoresearch.codex_token_cost': stringifyValue(observation.tokenCost),
        'autoresearch.codex_summary': observation.summary,
        'autoresearch.runner_id': observation.runnerId,
        'autoresearch.worker_id': observation.workerId,
        'autoresearch.recorded_at': observation.recordedAt,
      },
      {
        severityText: severity,
        severityNumber: getSeverityNumber(severity),
      },
    )
  }
}

export async function logHarnessAgentSessionTrend(input: {
  totalObservationCount: number
  claudeObservationCount: number
  codexObservationCount: number
  successCount: number
  failureCount: number
  blockedCount: number
  repeatedFailureTags: string[]
  lastRecordedAt?: string
}): Promise<void> {
  const payload = {
    'cc.total_observation_count': stringifyValue(input.totalObservationCount),
    'cc.claude_observation_count': stringifyValue(input.claudeObservationCount),
    'cc.codex_observation_count': stringifyValue(input.codexObservationCount),
    'cc.success_count': stringifyValue(input.successCount),
    'cc.failure_count': stringifyValue(input.failureCount),
    'cc.blocked_count': stringifyValue(input.blockedCount),
    'cc.repeated_failure_tags': stringifyValue(input.repeatedFailureTags),
    'cc.last_recorded_at': input.lastRecordedAt,
  }
  await logOTelEvent('cc_agent_session_trend_snapshot', payload)
  await logOTelEvent('autoresearch_codex_session_trend_snapshot', {
    'autoresearch.codex_observation_count': stringifyValue(
      input.codexObservationCount,
    ),
    'autoresearch.total_observation_count': stringifyValue(
      input.totalObservationCount,
    ),
    'autoresearch.success_count': stringifyValue(input.successCount),
    'autoresearch.failure_count': stringifyValue(input.failureCount),
    'autoresearch.blocked_count': stringifyValue(input.blockedCount),
    'autoresearch.repeated_failure_tags': stringifyValue(
      input.repeatedFailureTags,
    ),
    'autoresearch.last_recorded_at': input.lastRecordedAt,
  })
}
