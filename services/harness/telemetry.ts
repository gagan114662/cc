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

export async function logHarnessWideEvent(
  eventName:
    | 'cc_harness_poll_snapshot'
    | 'cc_harness_job_leased'
    | 'cc_harness_job_outcome'
    | 'cc_harness_repo_state'
    | 'cc_harness_webhook_ingested'
    | 'cc_harness_worker_lifecycle'
    | 'cc_harness_control_plane_doctor',
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
  const controlPlane = getHostedHarnessControlPlaneInfo()
  const repoId = input.repoId ?? input.job?.repoId
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
    'harness.job_status': input.job?.status ?? input.outcome?.status,
    'harness.job_source_kind': input.job?.sourceKind,
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
  )
}

export async function logHarnessAgentSessionObservation(
  observation: AgentSessionObservation,
): Promise<void> {
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
  }
  await logOTelEvent('cc_agent_session_observed', basePayload)
  if (observation.agentKind === 'codex') {
    await logOTelEvent('autoresearch_codex_session_observed', {
      'autoresearch.codex_session_id': observation.sessionId,
      'autoresearch.codex_result': observation.result,
      'autoresearch.codex_failure_tags': stringifyValue(observation.failureTags),
      'autoresearch.codex_runtime_ms': stringifyValue(observation.runtimeMs),
      'autoresearch.codex_token_cost': stringifyValue(observation.tokenCost),
      'autoresearch.codex_summary': observation.summary,
      'autoresearch.runner_id': observation.runnerId,
      'autoresearch.worker_id': observation.workerId,
      'autoresearch.recorded_at': observation.recordedAt,
    })
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
