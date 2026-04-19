import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { extractTextContent } from 'src/utils/messages.js'
import { safeParseJSON } from 'src/utils/json.js'
import { logError } from 'src/utils/log.js'
import { withTimeout } from 'src/utils/sleep.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { pollRemoteSessionEvents } from 'src/utils/teleport.js'
import { computeNextCronRun, parseCronExpression } from 'src/utils/cron.js'
import { recordHarnessOutcomeObservation } from './autoresearch.js'
import {
  buildHarnessRepoId,
  ensureHostedRepoRegistration,
  filterHarnessStateForRepo,
  getHostedHarnessControlPlaneInfo,
  getHostedHarnessPaths,
  readHostedHarnessState,
  withHostedHarnessState,
} from './controlPlane.js'
import { readEffectiveHarnessConfig } from './config.js'
import {
  pollGitHubDiscovery,
  readRemoteTriggerEvents,
  tryAutoMergePullRequest,
  type GitHubDiscovery,
} from './github.js'
import { buildLearningContext, updateLearningState, writeCompiledLearning } from './learning.js'
import {
  annotateManualIncident,
  getPullRequestQualityStatus,
  getRepoQualityStatus,
  ingestGstackQualityArtifacts,
  recordDefaultBranchFailureIncident,
  recordGitHubRequestedChangesFinding,
  recordOutcomeQualitySignals,
  refreshRepoQualitySnapshots,
  syncPullRequestQualityFromGitHub,
} from './quality.js'
import {
  emitHarnessObservabilityHeartbeat,
  isHarnessObservabilityEnvLoaded,
  loadHarnessObservabilityExportConfig,
} from './observability.js'
import { dispatchHarnessJobToRemoteTrigger } from './remoteTriggers.js'
import { runReviewerSuites } from './reviewers.js'
import {
  computeHarnessRunnerManifestSummary,
  readHarnessRunnerManifest,
} from './runners.js'
import {
  createDefaultCommandRunner,
  type ShellCommandRunner,
} from './shell.js'
import {
  logHarnessAgentSessionObservation,
  logHarnessAgentSessionTrend,
  logHarnessWideEvent,
} from './telemetry.js'
import type {
  AgentSessionObservation,
  HarnessConfig,
  HarnessExecutionBackend,
  HarnessAgentKind,
  HarnessRuntimeState,
  JobOutcome,
  JobSpec,
  QueuedHarnessJob,
  RunnerRegistration,
} from './types.js'
import {
  HarnessRuntimeStateSchema,
  type ReviewDecision,
  type VerificationResult,
} from './types.js'
import {
  createJobInstanceId,
  createStableId,
  nowIso,
  renderTemplate,
  resolveRepoPath,
  truncateText,
} from './utils.js'

const DEFAULT_DAEMON_TICK_MS = 15_000
const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_REMOTE_POLL_INTERVAL_MS = 3_000
const RUNNER_HEARTBEAT_STALE_MS = 120_000
const TELEMETRY_EXPORT_STALE_MS = 120_000
const WORKER_HEARTBEAT_RETENTION_MS = 10 * RUNNER_HEARTBEAT_STALE_MS

type WorkerExecutionResult = {
  success: boolean
  stdout: string
  stderr: string
  summary: string
  outputPath?: string
  humanTouchCount: number
  totalCostUsd: number
  executionBackend: HarnessExecutionBackend
  sessionId?: string
  model?: string
  toolCallCount?: number
}

export type HarnessWorkerExecutor = (input: {
  repoRoot: string
  config: HarnessConfig
  jobSpec: JobSpec
  job: QueuedHarnessJob
  agentKind: Exclude<HarnessAgentKind, 'either'>
  runnerId: string
  workerId: string
}) => Promise<WorkerExecutionResult>

export type HarnessDependencies = {
  commandRunner: ShellCommandRunner
  workerExecutor: HarnessWorkerExecutor
  now: () => Date
  sleep: (ms: number) => Promise<void>
  workerId?: string
  runnerId?: string
  agentKind?: Exclude<HarnessAgentKind, 'either'>
  workerSlots?: number
  runnerLabels?: string[]
  leaseLimit?: number
}

type DaemonControlState = {
  pid?: number
  workerPids?: number[]
  startedAt?: string
  lastHeartbeatAt?: string
  mode?: 'local' | 'hosted'
}

type RemotePrimaryExecutionResult = {
  dispatched: boolean
  completed: boolean
  dispatchSummary: string
  workerResult?: WorkerExecutionResult
  sessionId?: string
  triggerId?: string
}

type RunnerExecutionContext = {
  repoId: string
  runnerId: string
  workerId: string
  agentKind: Exclude<HarnessAgentKind, 'either'>
  slotCapacity: number
  labels: string[]
}

function getHarnessDaemonControlPath(repoRoot: string): string {
  const repoId = buildHarnessRepoId(repoRoot)
  return path.join(getHostedHarnessPaths().root, `${repoId}-daemon.json`)
}

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = safeParseJSON(raw, false)
    return (parsed as T | null) ?? fallback
  } catch {
    return fallback
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureParent(filePath)
  await writeFile(filePath, `${jsonStringify(value, null, 2)}\n`, 'utf-8')
}

export async function readHarnessState(
  repoRoot: string,
): Promise<HarnessRuntimeState> {
  const state = await readHostedHarnessState()
  return filterHarnessStateForRepo(state, buildHarnessRepoId(repoRoot))
}

export async function writeHarnessState(
  repoRoot: string,
  partialState: HarnessRuntimeState,
): Promise<void> {
  const repoId = buildHarnessRepoId(repoRoot)
  await withHostedHarnessState(state => {
    state.queue = [
      ...state.queue.filter(instanceId => state.jobs[instanceId]?.repoId !== repoId),
      ...partialState.queue,
    ]

    for (const [instanceId, job] of Object.entries(state.jobs)) {
      if (job.repoId === repoId) {
        delete state.jobs[instanceId]
      }
    }
    Object.assign(state.jobs, partialState.jobs)

    for (const [instanceId, lease] of Object.entries(state.leases)) {
      if (lease.repoId === repoId) {
        delete state.leases[instanceId]
      }
    }
    Object.assign(state.leases, partialState.leases)

    if (partialState.repos[repoId]) {
      state.repos[repoId] = partialState.repos[repoId]
    }
    if (partialState.repoHealth[repoId]) {
      state.repoHealth[repoId] = partialState.repoHealth[repoId]
    }
    if (partialState.budgets[repoId]) {
      state.budgets[repoId] = partialState.budgets[repoId]
    }

    Object.assign(state.attempts, partialState.attempts)
    Object.assign(state.runners, partialState.runners)
    Object.assign(state.workerHeartbeats, partialState.workerHeartbeats)
    Object.assign(state.agentSessions, partialState.agentSessions)
    Object.assign(state.quality.pullRequests, partialState.quality.pullRequests)
    Object.assign(state.quality.findings, partialState.quality.findings)
    Object.assign(state.quality.deployments, partialState.quality.deployments)
    Object.assign(state.quality.incidents, partialState.quality.incidents)
    Object.assign(state.quality.recoveries, partialState.quality.recoveries)
    Object.assign(state.quality.reverts, partialState.quality.reverts)
    Object.assign(
      state.quality.logicalChangeSizes,
      partialState.quality.logicalChangeSizes,
    )
    Object.assign(state.quality.snapshots, partialState.quality.snapshots)
    state.eventLedger = [...partialState.eventLedger, ...state.eventLedger].slice(0, 500)
    state.observability = partialState.observability
    state.history = [
      ...partialState.history,
      ...state.history.filter(outcome => {
        const job = state.jobs[outcome.jobInstanceId]
        return job?.repoId !== repoId
      }),
    ].slice(0, 100)
    state.learning = partialState.learning
    state.remoteMirror = {
      ...state.remoteMirror,
      ...partialState.remoteMirror,
    }
    state.sourceCursors = partialState.sourceCursors
    state.lastPolledAt = partialState.lastPolledAt
  })
}

export async function readDaemonControl(
  repoRoot: string,
): Promise<DaemonControlState> {
  return readJsonFile<DaemonControlState>(getHarnessDaemonControlPath(repoRoot), {})
}

export async function writeDaemonControl(
  repoRoot: string,
  control: DaemonControlState,
): Promise<void> {
  await writeJsonFile(getHarnessDaemonControlPath(repoRoot), control)
}

function createDefaultWorkerExecutor(
  runner: ShellCommandRunner,
  now: () => Date,
): HarnessWorkerExecutor {
  return async ({ repoRoot, config, jobSpec, job, agentKind, runnerId, workerId }) => {
    const outputDir = resolveRepoPath(repoRoot, '.claude/harness/runs')
    const outputPath = path.join(outputDir, `${job.instanceId}.log`)
    const learningContext = await buildLearningContext(repoRoot, config)
    const promptSections = [
      'You are running inside the unattended CC harness.',
      'No human approval is available for this job. Plan, execute, verify, and conclude on your own.',
      'Before deeper work, ensure the environment is bootstrapped: confirm `bun` is available, run `bun run repo:bootstrap` when the repo exposes it, and run `bin/setup_workspace` when present.',
      `Runtime: ${agentKind}`,
      `Job: ${jobSpec.title}`,
      `Kind: ${jobSpec.kind}`,
      `Source: ${job.sourceKind}`,
      `Primary instructions:\n${job.prompt}`,
      learningContext,
      jobSpec.verification.commands.length > 0
        ? `Verification commands to respect:\n- ${jobSpec.verification.commands.join('\n- ')}`
        : '',
      jobSpec.autoCommit
        ? 'If you make code changes and the work is ready, create the commit yourself.'
        : 'Do not create a git commit unless the task itself truly requires one.',
    ]
      .filter(Boolean)
      .join('\n\n')

    const commandOptions = {
      cwd: repoRoot,
      timeout: Math.min(
        DEFAULT_EXECUTION_TIMEOUT_MS,
        jobSpec.timeoutSeconds * 1000,
      ),
      env: {
        ...process.env,
        CLAUDE_CODE_HARNESS_JOB_ID: job.instanceId,
        CLAUDE_CODE_HARNESS_MODE: '1',
        CLAUDE_CODE_HARNESS_AGENT_KIND: agentKind,
        CLAUDE_CODE_HARNESS_RUNNER_ID: runnerId,
        CLAUDE_CODE_HARNESS_WORKER_ID: workerId,
      },
    } as const

    const result =
      agentKind === 'codex'
        ? await runner(
            process.env.CLAUDE_CODE_HARNESS_CODEX_COMMAND ?? 'codex',
            [
              'exec',
              '--skip-git-repo-check',
              '--sandbox',
              'danger-full-access',
              promptSections,
            ],
            commandOptions,
          )
        : await runner(
            process.execPath,
            [
              process.argv[1]!,
              '-p',
              '--agent',
              jobSpec.targetAgent,
              '--output-format',
              'text',
              '--dangerously-skip-permissions',
              '--workload',
              'harness',
              promptSections,
            ],
            commandOptions,
          )

    await mkdir(outputDir, { recursive: true })
    await writeFile(
      outputPath,
      [
        '# Harness run',
        `jobInstanceId=${job.instanceId}`,
        `timestamp=${nowIso(now())}`,
        `agentKind=${agentKind}`,
        `runnerId=${runnerId}`,
        `workerId=${workerId}`,
        '',
        '## stdout',
        result.stdout,
        '',
        '## stderr',
        result.stderr,
      ].join('\n'),
      'utf-8',
    )

    return {
      success: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: truncateText(
        result.stdout.trim() || result.stderr.trim() || `worker exit ${result.code}`,
        280,
      ),
      outputPath,
      humanTouchCount: 0,
      totalCostUsd: 0,
      executionBackend: 'local',
      model: agentKind === 'codex' ? 'codex' : jobSpec.targetAgent,
    }
  }
}

export function createHarnessDependencies(
  repoRoot: string,
): HarnessDependencies {
  const commandRunner = createDefaultCommandRunner(repoRoot)
  return {
    commandRunner,
    workerExecutor: createDefaultWorkerExecutor(commandRunner, () => new Date()),
    now: () => new Date(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
}

function getEffectiveRunnerContext(
  deps: HarnessDependencies,
  repoId: string,
): RunnerExecutionContext {
  return {
    repoId,
    runnerId: deps.runnerId ?? `runner-${repoId.slice(-6)}`,
    workerId: deps.workerId ?? `harness-worker-${randomUUID().slice(0, 8)}`,
    agentKind: deps.agentKind ?? 'claude',
    slotCapacity: Math.max(1, deps.workerSlots ?? deps.leaseLimit ?? 1),
    labels: deps.runnerLabels ?? [],
  }
}

function shouldRunHarnessDiscovery(workerId?: string): boolean {
  if (!workerId) {
    return true
  }
  return workerId === 'foreground-worker' || workerId.endsWith('-worker-1')
}

function isAgentKindRunnableOnRunner(
  requestedAgentKind: HarnessAgentKind,
  runnerAgentKind: Exclude<HarnessAgentKind, 'either'>,
): boolean {
  return requestedAgentKind === 'either' || requestedAgentKind === runnerAgentKind
}

function countRunnerActiveLeases(
  state: HarnessRuntimeState,
  runnerId: string,
): number {
  return Object.values(state.leases).filter(lease => lease.runnerId === runnerId).length
}

function countRunnerActiveLeasesByAgentKind(
  state: HarnessRuntimeState,
): Record<Exclude<HarnessAgentKind, 'either'>, number> {
  return Object.values(state.leases).reduce(
    (totals, lease) => {
      if (lease.agentKind === 'claude' || lease.agentKind === 'codex') {
        totals[lease.agentKind] += 1
      }
      return totals
    },
    { claude: 0, codex: 0 } as Record<Exclude<HarnessAgentKind, 'either'>, number>,
  )
}

function collectRunnerCapacitySummary(
  state: HarnessRuntimeState,
): {
  totalSlotCapacity: number
  slotCapacityByAgentKind: Record<Exclude<HarnessAgentKind, 'either'>, number>
  healthyRunnerCount: number
} {
  return Object.values(state.runners).reduce(
    (summary, runner) => {
      if (!runner.healthy) {
        return summary
      }
      summary.healthyRunnerCount += 1
      if (runner.agentKind === 'claude' || runner.agentKind === 'codex') {
        summary.slotCapacityByAgentKind[runner.agentKind] += runner.slotCapacity
      }
      summary.totalSlotCapacity += runner.slotCapacity
      return summary
    },
    {
      totalSlotCapacity: 0,
      slotCapacityByAgentKind: { claude: 0, codex: 0 },
      healthyRunnerCount: 0,
    } as {
      totalSlotCapacity: number
      slotCapacityByAgentKind: Record<Exclude<HarnessAgentKind, 'either'>, number>
      healthyRunnerCount: number
    },
  )
}

function computeQueuedCapacityShortfalls(
  state: HarnessRuntimeState,
): Record<Exclude<HarnessAgentKind, 'either'>, number> {
  const healthyKinds = new Set(
    Object.values(state.runners)
      .filter(runner => runner.healthy)
      .map(runner => runner.agentKind)
      .filter(
        (kind): kind is Exclude<HarnessAgentKind, 'either'> =>
          kind === 'claude' || kind === 'codex',
      ),
  )

  return Object.values(state.jobs).reduce(
    (summary, job) => {
      if (job.status !== 'queued') {
        return summary
      }
      if (
        (job.agentKind === 'claude' || job.agentKind === 'codex') &&
        !healthyKinds.has(job.agentKind)
      ) {
        summary[job.agentKind] += 1
      }
      return summary
    },
    { claude: 0, codex: 0 } as Record<Exclude<HarnessAgentKind, 'either'>, number>,
  )
}

function appendEventLedger(
  state: HarnessRuntimeState,
  eventName: string,
  metadata: {
    repoId?: string
    runnerId?: string
    workerId?: string
    agentKind?: HarnessAgentKind
    jobInstanceId?: string
    metadata?: Record<string, unknown>
  },
  recordedAt: string,
): void {
  state.eventLedger = [
    {
      id: createStableId(eventName, metadata.jobInstanceId ?? '', recordedAt),
      eventName,
      recordedAt,
      repoId: metadata.repoId,
      runnerId: metadata.runnerId,
      workerId: metadata.workerId,
      agentKind: metadata.agentKind,
      jobInstanceId: metadata.jobInstanceId,
      metadata: metadata.metadata ?? {},
    },
    ...state.eventLedger,
  ].slice(0, 500)
}

export function buildNextWorkerHeartbeat(
  existing: HarnessRuntimeState['workerHeartbeats'][string] | undefined,
  input: {
    workerId: string
    pid: number
    runnerId: string
    agentKind: Exclude<HarnessAgentKind, 'either'>
    labels: string[]
    slotCapacity: number
    repoId: string
    lastHeartbeatAt: string
    observabilityEnvLoaded: boolean
  },
): HarnessRuntimeState['workerHeartbeats'][string] {
  return {
    ...existing,
    workerId: input.workerId,
    pid: input.pid,
    runnerId: input.runnerId,
    agentKind: input.agentKind,
    labels: input.labels,
    slotCapacity: input.slotCapacity,
    healthy: true,
    observabilityEnvLoaded:
      existing?.observabilityEnvLoaded ?? input.observabilityEnvLoaded,
    lastTelemetryExportAt: existing?.lastTelemetryExportAt,
    repoId: input.repoId,
    lastHeartbeatAt: input.lastHeartbeatAt,
  }
}

function refreshObservabilityHealth(state: HarnessRuntimeState, now: Date): void {
  refreshRunnerHealth(state, now)
  const exportConfig = loadHarnessObservabilityExportConfig()
  const healthyWorkers = Object.values(state.workerHeartbeats).filter(heartbeat => {
    const lastHeartbeatMs = new Date(heartbeat.lastHeartbeatAt).getTime()
    return now.getTime() - lastHeartbeatMs <= RUNNER_HEARTBEAT_STALE_MS
  })
  const observabilityEnvLoadedWorkers = healthyWorkers
    .filter(heartbeat => heartbeat.observabilityEnvLoaded)
    .map(heartbeat => heartbeat.workerId)
    .sort()
  const telemetryStaleWorkers = healthyWorkers
    .filter(heartbeat => {
      if (!heartbeat.observabilityEnvLoaded) {
        return true
      }
      if (!heartbeat.lastTelemetryExportAt) {
        return true
      }
      return (
        now.getTime() - new Date(heartbeat.lastTelemetryExportAt).getTime() >
        TELEMETRY_EXPORT_STALE_MS
      )
    })
    .map(heartbeat => heartbeat.workerId)
    .sort()
  const exportLastSuccessAt = Object.values(state.workerHeartbeats)
    .map(heartbeat => heartbeat.lastTelemetryExportAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)
  const exportFresh =
    exportLastSuccessAt != null &&
    now.getTime() - new Date(exportLastSuccessAt).getTime() <=
      TELEMETRY_EXPORT_STALE_MS
  state.observability = {
    internalQueryLive: true,
    honeycombExportLive:
      exportConfig != null &&
      exportFresh &&
      observabilityEnvLoadedWorkers.length > 0,
    honeycombQueryLive: Boolean(process.env.HONEYCOMB_QUERY_KEY),
    lastCheckedAt: now.toISOString(),
    exportLastSuccessAt,
    exportFresh: Boolean(exportFresh),
    exportEndpoint: exportConfig?.exportEndpoint,
    dataset: exportConfig?.dataset,
    observabilityEnvLoadedWorkers,
    telemetryStaleWorkers,
  }
}

function refreshRunnerHealth(state: HarnessRuntimeState, now: Date): void {
  for (const [workerId, heartbeat] of Object.entries(state.workerHeartbeats)) {
    const ageMs = now.getTime() - new Date(heartbeat.lastHeartbeatAt).getTime()
    heartbeat.healthy = ageMs <= RUNNER_HEARTBEAT_STALE_MS
    if (ageMs > WORKER_HEARTBEAT_RETENTION_MS) {
      delete state.workerHeartbeats[workerId]
    }
  }

  for (const [runnerId, runner] of Object.entries(state.runners)) {
    const runnerWorkerHeartbeats = Object.values(state.workerHeartbeats).filter(
      heartbeat => heartbeat.runnerId === runner.runnerId,
    )
    const liveRunnerWorkerHeartbeats = runnerWorkerHeartbeats.filter(
      heartbeat => heartbeat.healthy,
    )
    runner.workerIds = liveRunnerWorkerHeartbeats
      .map(heartbeat => heartbeat.workerId)
      .sort()
    runner.healthy = liveRunnerWorkerHeartbeats.length > 0
    const latestHeartbeat = (
      liveRunnerWorkerHeartbeats.length > 0
        ? liveRunnerWorkerHeartbeats
        : runnerWorkerHeartbeats
    )
      .map(heartbeat => heartbeat.lastHeartbeatAt)
      .sort()
      .at(-1)
    if (latestHeartbeat) {
      runner.lastHeartbeatAt = latestHeartbeat
    }
    runner.activeLeaseCount = countRunnerActiveLeases(state, runner.runnerId)
    const runnerAgeMs = runner.lastHeartbeatAt
      ? now.getTime() - new Date(runner.lastHeartbeatAt).getTime()
      : Infinity
    if (
      !runner.healthy &&
      runner.activeLeaseCount === 0 &&
      runnerAgeMs > WORKER_HEARTBEAT_RETENTION_MS
    ) {
      delete state.runners[runnerId]
    }
  }
}

function summarizeAgentSessions(
  sessions: AgentSessionObservation[],
): {
  totalObservationCount: number
  claudeObservationCount: number
  codexObservationCount: number
  successCount: number
  failureCount: number
  blockedCount: number
  repeatedFailureTags: string[]
  lastRecordedAt?: string
} {
  const failureTagCounts = new Map<string, number>()
  let lastRecordedAt: string | undefined
  let successCount = 0
  let failureCount = 0
  let blockedCount = 0
  let claudeObservationCount = 0
  let codexObservationCount = 0

  for (const session of sessions) {
    if (session.agentKind === 'claude') {
      claudeObservationCount += 1
    } else if (session.agentKind === 'codex') {
      codexObservationCount += 1
    }
    if (!lastRecordedAt || session.recordedAt > lastRecordedAt) {
      lastRecordedAt = session.recordedAt
    }
    switch (session.result) {
      case 'success':
        successCount += 1
        break
      case 'blocked':
        blockedCount += 1
        break
      default:
        failureCount += 1
        break
    }
    for (const failureTag of session.failureTags) {
      failureTagCounts.set(failureTag, (failureTagCounts.get(failureTag) ?? 0) + 1)
    }
  }

  return {
    totalObservationCount: sessions.length,
    claudeObservationCount,
    codexObservationCount,
    successCount,
    failureCount,
    blockedCount,
    repeatedFailureTags: [...failureTagCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([tag]) => tag)
      .sort(),
    lastRecordedAt,
  }
}

async function emitHarnessExportHeartbeat(input: {
  repoId: string
  runnerId: string
  workerId: string
  agentKind: Exclude<HarnessAgentKind, 'either'>
  stage: 'worker_started' | 'worker_heartbeat' | 'job_outcome'
  jobInstanceId?: string
}): Promise<void> {
  const result = await emitHarnessObservabilityHeartbeat({
    eventName: 'cc_harness_export_heartbeat',
    metadata: {
      'cc.repo_id': input.repoId,
      'cc.runner_id': input.runnerId,
      'cc.worker_id': input.workerId,
      'cc.agent_kind': input.agentKind,
      'cc.stage': input.stage,
      'cc.job_instance_id': input.jobInstanceId,
    },
  })

  if (!result.ok || !result.exportedAt) {
    return
  }

  await withHostedHarnessState(state => {
    const heartbeat = state.workerHeartbeats[input.workerId]
    if (heartbeat) {
      heartbeat.observabilityEnvLoaded = true
      heartbeat.lastTelemetryExportAt = result.exportedAt
    }
    state.observability.exportLastSuccessAt = result.exportedAt
    refreshObservabilityHealth(state, new Date(result.exportedAt))
  })
}

async function runBestEffortHarnessStartupTask(
  task: Promise<unknown>,
  description: string,
): Promise<void> {
  try {
    await withTimeout(task, 5_000, `${description} timed out`)
  } catch (error) {
    logError(
      `Harness startup side effect failed: ${description} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

async function syncRepoQualityState(
  repoRoot: string,
  repoId: string,
  state: HarnessRuntimeState,
  discovery: GitHubDiscovery,
  runner: ShellCommandRunner,
  now: Date,
): Promise<void> {
  for (const pr of discovery.pullRequests) {
    await syncPullRequestQualityFromGitHub({
      repoRoot,
      repoId,
      prNumber: pr.number,
      state,
      runner,
      now,
    })
  }
  await ingestGstackQualityArtifacts(repoRoot, repoId, state, now)
  refreshRepoQualitySnapshots(state, repoId, now.toISOString())
}

function buildAgentSessionObservation(input: {
  outcome: JobOutcome
  attempt: HarnessRuntimeState['attempts'][string] | undefined
  lease: HarnessRuntimeState['leases'][string] | undefined
  job: QueuedHarnessJob
  recordedAt: string
}): AgentSessionObservation {
  const agentKind =
    input.attempt?.agentKind === 'claude' || input.attempt?.agentKind === 'codex'
      ? input.attempt.agentKind
      : input.lease?.agentKind === 'codex'
        ? 'codex'
        : input.job.agentKind === 'codex'
          ? 'codex'
          : 'claude'
  const runtimeMs =
    input.attempt?.startedAt != null
      ? Math.max(
          0,
          new Date(input.recordedAt).getTime() -
            new Date(input.attempt.startedAt).getTime(),
        )
      : 0

  return {
    id: createStableId(input.outcome.jobInstanceId, input.recordedAt, agentKind),
    agentKind,
    sessionId: input.attempt?.sessionId ?? input.outcome.jobInstanceId,
    jobInstanceId: input.outcome.jobInstanceId,
    runnerId: input.attempt?.runnerId ?? input.lease?.runnerId ?? 'unknown-runner',
    workerId: input.attempt?.workerId ?? input.lease?.workerId ?? 'unknown-worker',
    executionBackend: input.outcome.executionBackend,
    model: agentKind === 'codex' ? 'codex' : 'claude',
    result:
      input.outcome.status === 'completed'
        ? 'success'
        : input.outcome.status === 'blocked'
          ? 'blocked'
          : 'failure',
    failureTags: input.outcome.failureTags,
    humanTouchCount: input.outcome.humanTouchCount,
    toolCallCount: 0,
    runtimeMs,
    tokenCost: input.outcome.totalCostUsd,
    summary: input.outcome.summary,
    recordedAt: input.recordedAt,
  }
}

function normalizeWorkerResult(
  workerResult: Partial<WorkerExecutionResult> & Pick<WorkerExecutionResult, 'success'>,
): WorkerExecutionResult {
  return {
    stdout: workerResult.stdout ?? '',
    stderr: workerResult.stderr ?? '',
    summary: workerResult.summary ?? '',
    outputPath: workerResult.outputPath,
    humanTouchCount: workerResult.humanTouchCount ?? 0,
    totalCostUsd: workerResult.totalCostUsd ?? 0,
    executionBackend: workerResult.executionBackend ?? 'local',
    sessionId: workerResult.sessionId,
    model: workerResult.model,
    toolCallCount: workerResult.toolCallCount ?? 0,
    success: workerResult.success,
  }
}

function findJobSpec(config: HarnessConfig, jobId: string): JobSpec | undefined {
  return config.jobs.find(job => job.id === jobId)
}

function buildPromptVariables(
  repoRoot: string,
  metadata: Record<string, string>,
): Record<string, string> {
  return {
    repoRoot,
    ...metadata,
  }
}

function namespaceCursor(repoId: string, key: string): string {
  return `${repoId}:${key}`
}

function enqueueJob(
  state: HarnessRuntimeState,
  repoId: string,
  jobSpec: JobSpec,
  sourceKind: QueuedHarnessJob['sourceKind'],
  dedupeKey: string,
  promptVariables: Record<string, string>,
  metadata: Record<string, unknown>,
  now: Date,
): { state: HarnessRuntimeState; instanceId: string | null } {
  const existing = Object.values(state.jobs).find(
    job => job.repoId === repoId && job.dedupeKey === dedupeKey,
  )
  if (existing) {
    return {
      state,
      instanceId: null,
    }
  }

  const instanceId = createJobInstanceId(jobSpec.id)
  const renderedPrompt = renderTemplate(jobSpec.promptTemplate, promptVariables)
  const concurrencyKey = renderTemplate(jobSpec.concurrencyKey, promptVariables)
  const timestamp = nowIso(now)

  state.jobs[instanceId] = {
    instanceId,
    repoId,
    jobId: jobSpec.id,
    agentKind: jobSpec.agentKind,
    sourceKind,
    dedupeKey,
    concurrencyKey,
    prompt: renderedPrompt,
    status: 'queued',
    priority: jobSpec.priority,
    timeoutSeconds: jobSpec.timeoutSeconds,
    maxParallelism: jobSpec.maxParallelism,
    metadata,
    promptVariables,
    createdAt: timestamp,
    updatedAt: timestamp,
    attempt: 1,
    reviewerDecisions: [],
    verificationResults: [],
    failureTags: [],
  }
  state.queue.push(instanceId)
  return {
    state,
    instanceId,
  }
}

function isJobRunnable(job: QueuedHarnessJob, now: Date): boolean {
  if (job.status !== 'queued') {
    return false
  }
  if (!job.nextAttemptAt) {
    return true
  }
  return new Date(job.nextAttemptAt).getTime() <= now.getTime()
}

function recoverExpiredLeases(
  state: HarnessRuntimeState,
  now: Date,
): void {
  const nowMs = now.getTime()
  for (const lease of Object.values(state.leases)) {
    if (!lease.expiresAt) {
      continue
    }
    if (new Date(lease.expiresAt).getTime() > nowMs) {
      continue
    }
    const job = state.jobs[lease.instanceId]
    if (!job) {
      delete state.leases[lease.instanceId]
      continue
    }
    if (job.status === 'leased' || job.status === 'running') {
      job.status = 'queued'
      job.updatedAt = now.toISOString()
      job.failureTags = [...new Set([...job.failureTags, 'lease_expired'])]
    }
    delete state.leases[lease.instanceId]
  }
}

function canRunWhileRepoPaused(jobSpec: JobSpec): boolean {
  return (
    jobSpec.kind === 'repair' || jobSpec.repoHealthImpact === 'default-branch'
  )
}

function upsertRunnerRegistration(
  state: HarnessRuntimeState,
  runnerContext: RunnerExecutionContext,
  now: Date,
): RunnerRegistration {
  const existing = state.runners[runnerContext.runnerId]
  const activeLeaseCount = countRunnerActiveLeases(state, runnerContext.runnerId)
  const workerIds = new Set(existing?.workerIds ?? [])
  workerIds.add(runnerContext.workerId)
  const runner: RunnerRegistration = {
    runnerId: runnerContext.runnerId,
    repoId: runnerContext.repoId,
    agentKind: runnerContext.agentKind,
    slotCapacity: runnerContext.slotCapacity,
    labels: runnerContext.labels,
    lastHeartbeatAt: now.toISOString(),
    healthy: true,
    workerIds: [...workerIds].sort(),
    activeLeaseCount,
  }
  state.runners[runnerContext.runnerId] = runner
  return runner
}

function leaseNextJobs(
  state: HarnessRuntimeState,
  config: HarnessConfig,
  repoId: string,
  now: Date,
  runnerContext: RunnerExecutionContext,
  limit: number,
): QueuedHarnessJob[] {
  recoverExpiredLeases(state, now)

  const repo = state.repos[repoId]
  const repoHealth = state.repoHealth[repoId]
  const repoBudget = state.budgets[repoId]
  if (!repo) {
    return []
  }

  const activeJobs = Object.values(state.jobs).filter(
    job =>
      job.repoId === repoId &&
      (job.status === 'leased' || job.status === 'running'),
  )
  const activeConcurrencyKeys = new Map<string, number>()
  const activeJobIds = new Map<string, number>()
  for (const job of activeJobs) {
    activeConcurrencyKeys.set(
      job.concurrencyKey,
      (activeConcurrencyKeys.get(job.concurrencyKey) ?? 0) + 1,
    )
    activeJobIds.set(job.jobId, (activeJobIds.get(job.jobId) ?? 0) + 1)
  }

  const queuedCandidates = state.queue
    .map(instanceId => state.jobs[instanceId])
    .filter(
      (job): job is QueuedHarnessJob =>
        job != null && job.repoId === repoId && isJobRunnable(job, now),
    )
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority
      }
      return left.createdAt.localeCompare(right.createdAt)
    })

  const leased: QueuedHarnessJob[] = []
  const repoActiveLimit = repo.maxParallelism
  const runnerActiveLeaseCount = countRunnerActiveLeases(
    state,
    runnerContext.runnerId,
  )
  const runnerRemainingSlots = Math.max(
    0,
    runnerContext.slotCapacity - runnerActiveLeaseCount,
  )

  for (const job of queuedCandidates) {
    if (leased.length >= limit) {
      break
    }
    if (leased.length >= runnerRemainingSlots) {
      break
    }
    if (activeJobs.length + leased.length >= repoActiveLimit) {
      break
    }

    const jobSpec = findJobSpec(config, job.jobId)
    if (!jobSpec) {
      continue
    }

    if (
      (repoHealth?.status === 'paused' || repoHealth?.status === 'red') &&
      !canRunWhileRepoPaused(jobSpec)
    ) {
      continue
    }
    if (repoBudget?.blocked || (repoBudget?.spentUsd ?? 0) >= (repoBudget?.maxUsd ?? Infinity)) {
      continue
    }
    if ((activeConcurrencyKeys.get(job.concurrencyKey) ?? 0) >= job.maxParallelism) {
      continue
    }
    if ((activeJobIds.get(job.jobId) ?? 0) >= jobSpec.maxParallelism) {
      continue
    }
    if (!isAgentKindRunnableOnRunner(job.agentKind, runnerContext.agentKind)) {
      continue
    }

    const timestamp = now.toISOString()
    const expiresAt = new Date(
      now.getTime() + Math.max(60_000, job.timeoutSeconds * 1000),
    ).toISOString()
    job.status = 'leased'
    job.updatedAt = timestamp
    state.leases[job.instanceId] = {
      instanceId: job.instanceId,
      repoId,
      workerId: runnerContext.workerId,
      runnerId: runnerContext.runnerId,
      agentKind: runnerContext.agentKind,
      leasedAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt,
    }

    const attemptId = createStableId(job.instanceId, job.attempt, timestamp)
    state.attempts[attemptId] = {
      attemptId,
      jobInstanceId: job.instanceId,
      repoId,
      workerId: runnerContext.workerId,
      runnerId: runnerContext.runnerId,
      agentKind: runnerContext.agentKind,
      executionBackend: 'local',
      startedAt: timestamp,
      status: 'running',
      totalCostUsd: 0,
    }
    job.metadata = {
      ...job.metadata,
      executionAttemptId: attemptId,
    }

    activeConcurrencyKeys.set(
      job.concurrencyKey,
      (activeConcurrencyKeys.get(job.concurrencyKey) ?? 0) + 1,
    )
    activeJobIds.set(job.jobId, (activeJobIds.get(job.jobId) ?? 0) + 1)
    leased.push(job)
  }

  return leased
}

function removeFromQueue(state: HarnessRuntimeState, instanceId: string): void {
  state.queue = state.queue.filter(id => id !== instanceId)
  delete state.leases[instanceId]
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return ''
  }
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) {
    return ''
  }
  return extractTextContent(
    content as Array<{ readonly type: string; readonly text?: string }>,
    '\n',
  ).trim()
}

async function executeRemotePrimaryWorker(
  repoRoot: string,
  config: HarnessConfig,
  jobSpec: JobSpec,
  job: QueuedHarnessJob,
  deps: HarnessDependencies,
  existingTriggerId?: string,
): Promise<RemotePrimaryExecutionResult> {
  const dispatch = await dispatchHarnessJobToRemoteTrigger({
    repoRoot,
    config,
    jobSpec,
    job,
    commandRunner: deps.commandRunner,
    existingTriggerId,
  })

  if (!dispatch.ok) {
    return {
      dispatched: false,
      completed: false,
      dispatchSummary: dispatch.summary,
      triggerId: dispatch.triggerId,
    }
  }

  if (dispatch.backend !== 'session' || !dispatch.sessionId) {
    return {
      dispatched: true,
      completed: false,
      dispatchSummary: dispatch.summary,
      triggerId: dispatch.triggerId,
    }
  }

  const deadline = deps.now().getTime() + jobSpec.timeoutSeconds * 1000
  let cursor: string | null = null
  let lastAssistantText = ''
  let lastStdout = ''

  while (Date.now() < deadline) {
    const response = await pollRemoteSessionEvents(dispatch.sessionId, cursor)
    cursor = response.lastEventId

    for (const event of response.newEvents) {
      if (event.type === 'assistant') {
        const text = extractAssistantText(event)
        if (text) {
          lastAssistantText = text
          lastStdout = text
        }
      }
      if (event.type === 'result') {
        const totalCostUsd =
          typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0
        const errors = Array.isArray(event.errors) ? event.errors.join('\n') : ''
        if (event.is_error || event.subtype !== 'success') {
          return {
            dispatched: true,
            completed: true,
            dispatchSummary: dispatch.summary,
            sessionId: dispatch.sessionId,
            workerResult: {
              success: false,
              stdout: lastStdout,
              stderr: errors || `remote session ended with ${event.subtype}`,
              summary:
                lastAssistantText ||
                `remote session ${dispatch.sessionId} failed (${event.subtype})`,
              humanTouchCount:
                response.sessionStatus === 'requires_action' ? 1 : 0,
              totalCostUsd,
              executionBackend: 'remote-session',
              sessionId: dispatch.sessionId,
              model: config.sources.remoteTriggers.model,
            },
          }
        }
        return {
          dispatched: true,
          completed: true,
          dispatchSummary: dispatch.summary,
          sessionId: dispatch.sessionId,
          workerResult: {
            success: true,
            stdout: lastStdout,
            stderr: '',
            summary:
              lastAssistantText ||
              `remote session ${dispatch.sessionId} completed successfully`,
            humanTouchCount: 0,
            totalCostUsd,
            executionBackend: 'remote-session',
            sessionId: dispatch.sessionId,
            model: config.sources.remoteTriggers.model,
          },
        }
      }
    }

    if (response.sessionStatus === 'requires_action') {
      return {
        dispatched: true,
        completed: true,
        dispatchSummary: dispatch.summary,
        sessionId: dispatch.sessionId,
        workerResult: {
          success: false,
          stdout: lastStdout,
          stderr: 'remote session is waiting on human input',
          summary:
            lastAssistantText ||
            `remote session ${dispatch.sessionId} requires human input`,
          humanTouchCount: 1,
          totalCostUsd: 0,
          executionBackend: 'remote-session',
          sessionId: dispatch.sessionId,
          model: config.sources.remoteTriggers.model,
        },
      }
    }

    if (response.sessionStatus === 'idle' && lastAssistantText) {
      return {
        dispatched: true,
        completed: true,
        dispatchSummary: dispatch.summary,
        sessionId: dispatch.sessionId,
        workerResult: {
          success: true,
          stdout: lastStdout,
          stderr: '',
          summary: lastAssistantText,
          humanTouchCount: 0,
          totalCostUsd: 0,
          executionBackend: 'remote-session',
          sessionId: dispatch.sessionId,
          model: config.sources.remoteTriggers.model,
        },
      }
    }

    await deps.sleep(DEFAULT_REMOTE_POLL_INTERVAL_MS)
  }

  return {
    dispatched: true,
    completed: true,
    dispatchSummary: dispatch.summary,
    sessionId: dispatch.sessionId,
    workerResult: {
      success: false,
      stdout: lastStdout,
      stderr: 'remote session timed out',
      summary:
        lastAssistantText ||
        `remote session ${dispatch.sessionId} timed out before completion`,
      humanTouchCount: 0,
      totalCostUsd: 0,
      executionBackend: 'remote-session',
      sessionId: dispatch.sessionId,
      model: config.sources.remoteTriggers.model,
    },
  }
}

function buildFailureTags(
  decisions: Array<{ reviewerId: string; status: string }>,
  verificationResults: Array<{
    command: string
    code: number
    phase?: 'bootstrap' | 'verification'
  }>,
  mergeResult: { ok: boolean; summary: string } | null,
): string[] {
  const tags = new Set<string>()
  for (const decision of decisions) {
    if (decision.status !== 'pass') {
      tags.add(`reviewer:${decision.reviewerId}`)
    }
  }
  for (const result of verificationResults) {
    if (result.code !== 0) {
      tags.add(
        `${result.phase === 'bootstrap' ? 'bootstrap' : 'verify'}:${result.command}`,
      )
    }
  }
  if (mergeResult && !mergeResult.ok) {
    tags.add('merge_failed')
  }
  return [...tags]
}

async function processLeasedJob(
  repoRoot: string,
  repoId: string,
  config: HarnessConfig,
  state: HarnessRuntimeState,
  job: QueuedHarnessJob,
  deps: HarnessDependencies,
): Promise<JobOutcome> {
  const jobSpec = findJobSpec(config, job.jobId)
  if (!jobSpec) {
    throw new Error(`unknown harness job: ${job.jobId}`)
  }

  const startedAt = nowIso(deps.now())
  job.status = 'running'
  job.startedAt = startedAt
  job.updatedAt = startedAt
  const lease = state.leases[job.instanceId]
  if (lease) {
    lease.heartbeatAt = startedAt
  }
  const executionAgentKind =
    lease?.agentKind === 'claude' || lease?.agentKind === 'codex'
      ? lease.agentKind
      : job.agentKind === 'codex'
        ? 'codex'
        : 'claude'
  const runnerId = lease?.runnerId ?? deps.runnerId ?? `runner-${repoId.slice(-6)}`
  const workerId = lease?.workerId ?? deps.workerId ?? `harness-worker-${randomUUID().slice(0, 8)}`

  let workerResult: WorkerExecutionResult = {
    success: true,
    stdout: '',
    stderr: '',
    summary: 'review-only job executed without worker session',
    humanTouchCount: 0,
    totalCostUsd: 0,
    executionBackend: 'local',
  }

  let remoteDispatchSummary: string | undefined
  const remoteMirrorKey = namespaceCursor(repoId, job.concurrencyKey)

  if (jobSpec.executionMode === 'lead-session') {
    if (
      executionAgentKind === 'claude' &&
      config.sources.remoteTriggers.enabled &&
      config.sources.remoteTriggers.dispatchMode === 'primary'
    ) {
      const remotePrimary = await executeRemotePrimaryWorker(
        repoRoot,
        config,
        jobSpec,
        job,
        deps,
        state.remoteMirror[remoteMirrorKey] ?? job.remoteMirrorId,
      )
      remoteDispatchSummary = remotePrimary.dispatchSummary
      job.metadata = {
        ...job.metadata,
        remoteDispatch: {
          mode: config.sources.remoteTriggers.dispatchMode,
          ok: remotePrimary.dispatched,
          summary: remotePrimary.dispatchSummary,
          sessionId: remotePrimary.sessionId,
          triggerId: remotePrimary.triggerId,
        },
      }
      if (remotePrimary.triggerId) {
        job.remoteMirrorId = remotePrimary.triggerId
        state.remoteMirror[remoteMirrorKey] = remotePrimary.triggerId
      }
      if (remotePrimary.completed && remotePrimary.workerResult) {
        workerResult = remotePrimary.workerResult
      } else if (!config.sources.remoteTriggers.localFallback) {
        workerResult = {
          success: false,
          stdout: '',
          stderr: remotePrimary.dispatchSummary,
          summary: remotePrimary.dispatchSummary,
          humanTouchCount: 0,
          totalCostUsd: 0,
          executionBackend:
            remotePrimary.triggerId != null ? 'remote-trigger' : 'remote-session',
        }
      } else {
        workerResult = await deps.workerExecutor({
          repoRoot,
          config,
          jobSpec,
          job,
          agentKind: executionAgentKind,
          runnerId,
          workerId,
        })
      }
    } else {
      if (
        config.sources.remoteTriggers.enabled &&
        config.sources.remoteTriggers.mirrorEnabled &&
        config.sources.remoteTriggers.dispatchMode === 'shadow'
      ) {
        const remoteDispatch = await dispatchHarnessJobToRemoteTrigger({
          repoRoot,
          config,
          jobSpec,
          job,
          commandRunner: deps.commandRunner,
          existingTriggerId:
            state.remoteMirror[remoteMirrorKey] ?? job.remoteMirrorId,
        })
        remoteDispatchSummary = remoteDispatch.summary
        job.metadata = {
          ...job.metadata,
          remoteDispatch: {
            mode: remoteDispatch.mode,
            ok: remoteDispatch.ok,
            backend: remoteDispatch.backend,
            summary: remoteDispatch.summary,
            sessionId: remoteDispatch.sessionId,
            triggerId: remoteDispatch.triggerId,
            observationMode: remoteDispatch.observationMode,
            persistSessionRequested: remoteDispatch.persistSessionRequested,
            persistSessionObserved: remoteDispatch.persistSessionObserved,
          },
        }
        if (remoteDispatch.triggerId) {
          job.remoteMirrorId = remoteDispatch.triggerId
          state.remoteMirror[remoteMirrorKey] = remoteDispatch.triggerId
        }
      }

      workerResult = await deps.workerExecutor({
        repoRoot,
        config,
        jobSpec,
        job,
        agentKind: executionAgentKind,
        runnerId,
        workerId,
      })
    }
  }

  workerResult = normalizeWorkerResult(workerResult)

  const reviewResult = await runReviewerSuites(
    repoRoot,
    jobSpec,
    job,
    deps.commandRunner,
    { paused: state.repoHealth[repoId]?.status !== 'healthy' },
  )
  job.reviewerDecisions = reviewResult.decisions
  job.verificationResults = reviewResult.verificationResults

  const blockingDecision = reviewResult.decisions.find(
    decision => decision.status === 'block' && decision.blocking,
  )

  let mergeResult: { ok: boolean; summary: string } | null = null
  const prNumber =
    job.promptVariables.prNumber != null
      ? Number(job.promptVariables.prNumber)
      : null
  if (
    blockingDecision == null &&
    workerResult.success &&
    config.autonomy.autoMerge &&
    jobSpec.autoMerge &&
    prNumber != null &&
    Number.isFinite(prNumber) &&
    state.repoHealth[repoId]?.status === 'healthy'
  ) {
    mergeResult = await tryAutoMergePullRequest(
      repoRoot,
      prNumber,
      deps.commandRunner,
    )
  }

  const completedAt = nowIso(deps.now())
  const failureTags = buildFailureTags(
    reviewResult.decisions,
    reviewResult.verificationResults,
    mergeResult,
  )
  const status =
    !workerResult.success
      ? 'failed'
      : blockingDecision
        ? 'blocked'
        : 'completed'
  const summaryParts = [remoteDispatchSummary, workerResult.summary]
  if (blockingDecision) {
    summaryParts.push(`blocked by ${blockingDecision.reviewerId}`)
  }
  if (mergeResult) {
    summaryParts.push(mergeResult.summary)
  }

  const outcome: JobOutcome = {
    jobInstanceId: job.instanceId,
    jobId: job.jobId,
    status,
    summary: summaryParts.filter(Boolean).join(' | '),
    startedAt,
    completedAt,
    attempt: job.attempt,
    reviewerDecisions: reviewResult.decisions,
    verificationResults: reviewResult.verificationResults,
    autoMergeRequested: mergeResult != null,
    autoMergeResult: mergeResult?.summary,
    failureTags,
    humanTouchCount: workerResult.humanTouchCount,
    totalCostUsd: workerResult.totalCostUsd,
    executionBackend: workerResult.executionBackend,
    regressionDetected: Boolean(job.metadata.regressionDetected),
    outputPath: workerResult.outputPath,
  }

  const attemptId = typeof job.metadata.executionAttemptId === 'string'
    ? job.metadata.executionAttemptId
    : undefined
  if (attemptId && state.attempts[attemptId]) {
    state.attempts[attemptId]!.sessionId = workerResult.sessionId
  }

  return outcome
}

function updateAttemptRecord(
  state: HarnessRuntimeState,
  job: QueuedHarnessJob,
  outcome: JobOutcome,
): void {
  const attemptId =
    typeof job.metadata.executionAttemptId === 'string'
      ? job.metadata.executionAttemptId
      : null
  if (!attemptId) {
    return
  }
  const attempt = state.attempts[attemptId]
  if (!attempt) {
    return
  }
  attempt.completedAt = outcome.completedAt
  attempt.status = outcome.status
  attempt.totalCostUsd = outcome.totalCostUsd
  attempt.summary = outcome.summary
  switch (outcome.executionBackend) {
    case 'remote-session':
      attempt.executionBackend = 'remote-session'
      break
    case 'remote-trigger':
      attempt.executionBackend = 'remote-trigger'
      break
    default:
      attempt.executionBackend = 'local'
      break
  }
}

async function getDefaultBranchHealth(
  repoRoot: string,
  defaultBranch: string,
  runner: ShellCommandRunner,
): Promise<boolean> {
  const result = await runner(
    'gh',
    [
      'run',
      'list',
      '--branch',
      defaultBranch,
      '--limit',
      '1',
      '--json',
      'headSha,status,conclusion',
    ],
    { cwd: repoRoot },
  )
  if (result.code !== 0) {
    return false
  }
  const parsed = safeParseJSON(result.stdout, false)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return false
  }
  const latest = parsed[0] as { status?: string; conclusion?: string }
  return (
    latest.status === 'completed' &&
    (latest.conclusion ?? '').toLowerCase() === 'success'
  )
}

function applyCronJobs(
  repoRoot: string,
  repoId: string,
  config: HarnessConfig,
  state: HarnessRuntimeState,
  now: Date,
): void {
  if (!config.sources.cron.enabled) {
    return
  }

  for (const jobSpec of config.jobs) {
    for (const binding of jobSpec.sourceBindings) {
      if (binding.type !== 'cron') {
        continue
      }
      const parsed = parseCronExpression(binding.cron)
      if (!parsed) {
        continue
      }
      const cursorKey = namespaceCursor(repoId, `${jobSpec.id}:${binding.cron}`)
      const lastFire = state.sourceCursors.cronFires[cursorKey]
      const anchor = lastFire ? new Date(lastFire) : new Date(now.getTime() - 60_000)
      const nextFire = computeNextCronRun(parsed, anchor)
      if (!nextFire || nextFire.getTime() > now.getTime()) {
        continue
      }
      const promptVariables = buildPromptVariables(repoRoot, {
        scheduledAt: nextFire.toISOString(),
      })
      const dedupeKey = createStableId(
        jobSpec.id,
        'cron',
        binding.cron,
        nextFire.toISOString(),
      )
      enqueueJob(
        state,
        repoId,
        jobSpec,
        'cron',
        dedupeKey,
        promptVariables,
        {
          cron: binding.cron,
          scheduledAt: nextFire.toISOString(),
        },
        now,
      )
      state.sourceCursors.cronFires[cursorKey] = nextFire.toISOString()
    }
  }
}

function applyGitHubDiscovery(
  repoRoot: string,
  repoId: string,
  config: HarnessConfig,
  state: HarnessRuntimeState,
  discovery: GitHubDiscovery,
  now: Date,
): void {
  if (discovery.defaultBranch) {
    state.sourceCursors.defaultBranches[repoId] = discovery.defaultBranch
  }
  if (state.repos[repoId]) {
    state.repos[repoId] = {
      ...state.repos[repoId]!,
      repoNameWithOwner:
        discovery.repoNameWithOwner ?? state.repos[repoId]!.repoNameWithOwner,
      defaultBranch: discovery.defaultBranch ?? state.repos[repoId]!.defaultBranch,
    }
  }

  for (const jobSpec of config.jobs) {
    for (const binding of jobSpec.sourceBindings) {
      if (binding.type !== 'github') {
        continue
      }

      if (
        binding.event === 'pull_request_opened' ||
        binding.event === 'pull_request_push' ||
        binding.event === 'pull_request_reopened'
      ) {
        for (const pr of discovery.pullRequests) {
          const cursorKey = namespaceCursor(repoId, String(pr.number))
          const previousHead = state.sourceCursors.githubPrHeads[cursorKey]
          const isFirstSeen = previousHead == null
          const hasChanged = previousHead != null && previousHead !== pr.headSha

          const shouldEnqueue =
            (binding.event === 'pull_request_opened' && isFirstSeen) ||
            (binding.event === 'pull_request_push' && hasChanged)

          if (!shouldEnqueue || !pr.headSha) {
            if (pr.headSha) {
              state.sourceCursors.githubPrHeads[cursorKey] = pr.headSha
            }
            continue
          }

          const variables = buildPromptVariables(repoRoot, {
            prNumber: String(pr.number),
            prTitle: pr.title,
            prUrl: pr.url,
            headSha: pr.headSha,
            headRefName: pr.headRefName ?? '',
            baseRefName: pr.baseRefName ?? '',
            repo: discovery.repoNameWithOwner ?? '',
          })
          const dedupeKey = createStableId(
            jobSpec.id,
            'github',
            pr.number,
            pr.headSha,
          )
          enqueueJob(
            state,
            repoId,
            jobSpec,
            'github',
            dedupeKey,
            variables,
            {
              event: binding.event,
              prNumber: pr.number,
              prUrl: pr.url,
              headSha: pr.headSha,
            },
            now,
          )
          state.sourceCursors.githubPrHeads[cursorKey] = pr.headSha
        }
      }

      if (
        binding.event === 'default_branch_failure' &&
        discovery.failingDefaultBranchRun
      ) {
        const run = discovery.failingDefaultBranchRun
        const failingRunKey = `${run.databaseId}:${run.headSha}:${run.conclusion}`
        if (state.sourceCursors.failingRunKeys[repoId] === failingRunKey) {
          continue
        }
        const variables = buildPromptVariables(repoRoot, {
          defaultBranch: discovery.defaultBranch ?? '',
          headSha: run.headSha,
          workflowName: run.workflowName,
          runUrl: run.url ?? '',
        })
        const lastAutoMergeHeadSha = state.repoHealth[repoId]?.lastAutoMergeHeadSha
        const regressionDetected =
          lastAutoMergeHeadSha != null && lastAutoMergeHeadSha === run.headSha
        const dedupeKey = createStableId(
          jobSpec.id,
          'github',
          discovery.defaultBranch ?? 'main',
          run.headSha,
          run.databaseId,
        )
        enqueueJob(
          state,
          repoId,
          jobSpec,
          'github',
          dedupeKey,
          variables,
          {
            event: 'default_branch_failure',
            databaseId: run.databaseId,
            headSha: run.headSha,
            workflowName: run.workflowName,
            runUrl: run.url,
            regressionDetected,
          },
          now,
        )
        state.sourceCursors.failingRunKeys[repoId] = failingRunKey
        state.sourceCursors.defaultBranchHeads[repoId] = run.headSha
        state.repoHealth[repoId] = {
          ...state.repoHealth[repoId],
          repoId,
          status: config.autonomy.pauseOnMainRed ? 'red' : 'healthy',
          pauseReason: config.autonomy.pauseOnMainRed
            ? `default branch ${discovery.defaultBranch ?? 'main'} is red at ${run.headSha}`
            : undefined,
          lastFailureAt: now.toISOString(),
          lastObservedFailureHeadSha: run.headSha,
        }
      }
    }
  }
}

function applyRemoteTriggerJobs(
  repoRoot: string,
  repoId: string,
  config: HarnessConfig,
  state: HarnessRuntimeState,
  now: Date,
  events: Awaited<ReturnType<typeof readRemoteTriggerEvents>>,
): void {
  if (!config.sources.remoteTriggers.enabled) {
    return
  }
  for (const event of events) {
    const cursorKey = namespaceCursor(repoId, event.id)
    if (state.sourceCursors.remoteEvents[cursorKey] != null) {
      continue
    }
    const jobSpec = findJobSpec(config, event.jobId)
    if (!jobSpec) {
      continue
    }
    enqueueJob(
      state,
      repoId,
      jobSpec,
      'remoteTrigger',
      event.dedupeKey,
      buildPromptVariables(repoRoot, event.promptVariables),
      event.metadata,
      now,
    )
    state.sourceCursors.remoteEvents[cursorKey] = event.createdAt
  }
}

function computeRepoScopedQueuedCount(
  state: HarnessRuntimeState,
  repoId: string,
): number {
  return state.queue.filter(instanceId => state.jobs[instanceId]?.repoId === repoId).length
}

function computeRepoScopedActiveCount(
  state: HarnessRuntimeState,
  repoId: string,
): number {
  return Object.values(state.jobs).filter(
    job =>
      job.repoId === repoId &&
      (job.status === 'leased' || job.status === 'running'),
  ).length
}

async function finalizeOutcome(
  repoRoot: string,
  repoId: string,
  config: HarnessConfig,
  job: QueuedHarnessJob,
  outcome: JobOutcome,
  runner: ShellCommandRunner,
): Promise<HarnessRuntimeState> {
  return withHostedHarnessState(async state => {
    const persistedJob = state.jobs[job.instanceId]
    const jobSpec = findJobSpec(config, job.jobId)
    if (!persistedJob || !jobSpec) {
      refreshObservabilityHealth(state, new Date())
      return filterHarnessStateForRepo(state, repoId)
    }

    const lease = state.leases[job.instanceId]

    persistedJob.status = outcome.status
    persistedJob.updatedAt = outcome.completedAt
    persistedJob.completedAt = outcome.completedAt
    persistedJob.outputPath = outcome.outputPath
    persistedJob.outcomeSummary = outcome.summary
    persistedJob.failureTags = outcome.failureTags
    persistedJob.reviewerDecisions = outcome.reviewerDecisions
    persistedJob.verificationResults = outcome.verificationResults

    updateAttemptRecord(state, persistedJob, outcome)
    const attemptId =
      typeof persistedJob.metadata.executionAttemptId === 'string'
        ? persistedJob.metadata.executionAttemptId
        : undefined
    const attempt = attemptId ? state.attempts[attemptId] : undefined

    const repoBudget = state.budgets[repoId]
    if (repoBudget) {
      repoBudget.spentUsd += outcome.totalCostUsd || jobSpec.budget.defaultAttemptUsd
      repoBudget.updatedAt = outcome.completedAt
      repoBudget.blocked = repoBudget.spentUsd >= repoBudget.maxUsd
    }

    if (outcome.autoMergeRequested && outcome.autoMergeResult && outcome.status === 'completed') {
      state.repoHealth[repoId] = {
        ...state.repoHealth[repoId],
        repoId,
        status: 'healthy',
        pauseReason: undefined,
        lastHealthyAt: outcome.completedAt,
        lastAutoMergeHeadSha: persistedJob.promptVariables.headSha,
        lastAutoMergePrNumber:
          persistedJob.promptVariables.prNumber != null
            ? Number(persistedJob.promptVariables.prNumber)
            : undefined,
      }
    }

    if (persistedJob.metadata.regressionDetected) {
      state.repoHealth[repoId] = {
        ...state.repoHealth[repoId],
        repoId,
        status: 'red',
        pauseReason:
          state.repoHealth[repoId]?.pauseReason ??
          'default branch regressed after auto-merge',
        lastFailureAt: outcome.completedAt,
      }
    }

    if (outcome.status === 'failed' && jobSpec.retryPolicy.maxAttempts > persistedJob.attempt) {
      persistedJob.attempt += 1
      persistedJob.status = 'queued'
      persistedJob.nextAttemptAt = nowIso(
        new Date(Date.now() + jobSpec.retryPolicy.backoffSeconds * 1000),
      )
      persistedJob.updatedAt = nowIso()
      delete state.leases[persistedJob.instanceId]
    } else {
      removeFromQueue(state, persistedJob.instanceId)
    }

    state.history = [outcome, ...state.history].slice(0, 100)
    const observation = buildAgentSessionObservation({
      outcome,
      attempt,
      lease,
      job: persistedJob,
      recordedAt: outcome.completedAt,
    })
    state.agentSessions[observation.id] = observation
    appendEventLedger(
      state,
      'cc_harness_job_outcome',
      {
        repoId,
        runnerId: observation.runnerId,
        workerId: observation.workerId,
        agentKind: observation.agentKind,
        jobInstanceId: outcome.jobInstanceId,
        metadata: {
          status: outcome.status,
          failureTags: outcome.failureTags,
        },
      },
      outcome.completedAt,
    )
    const nextState = updateLearningState(
      state,
      outcome,
      outcome.reviewerDecisions,
    )
    state.learning = nextState.learning
    const prNumber = Number(persistedJob.promptVariables.prNumber ?? '')
    if (Number.isFinite(prNumber) && prNumber > 0) {
      recordOutcomeQualitySignals(state, repoId, persistedJob, outcome)
      await syncPullRequestQualityFromGitHub({
        repoRoot,
        repoId,
        prNumber,
        state,
        runner,
        now: new Date(outcome.completedAt),
      })
    }
    if (
      outcome.regressionDetected &&
      state.repoHealth[repoId]?.lastAutoMergePrNumber != null
    ) {
      recordDefaultBranchFailureIncident(state, repoId, {
        prNumber: state.repoHealth[repoId]!.lastAutoMergePrNumber!,
        headSha: state.repoHealth[repoId]!.lastObservedFailureHeadSha,
        detectedAt: outcome.completedAt,
        summary:
          outcome.summary ||
          'default branch regression detected after unattended merge',
      })
    }
    await ingestGstackQualityArtifacts(
      repoRoot,
      repoId,
      state,
      new Date(outcome.completedAt),
    )
    refreshRepoQualitySnapshots(state, repoId, outcome.completedAt)
    if (observation.runnerId !== 'unknown-runner' && state.runners[observation.runnerId]) {
      state.runners[observation.runnerId]!.activeLeaseCount = countRunnerActiveLeases(
        state,
        observation.runnerId,
      )
      state.runners[observation.runnerId]!.lastHeartbeatAt = outcome.completedAt
    }
    refreshObservabilityHealth(state, new Date(outcome.completedAt))

    return filterHarnessStateForRepo(state, repoId)
  })
}

export async function pollHarnessOnce(
  repoRoot: string,
  injectedDeps?: Partial<HarnessDependencies>,
): Promise<{
  config: HarnessConfig
  state: HarnessRuntimeState
  processedJobId?: string
}> {
  const deps = { ...createHarnessDependencies(repoRoot), ...injectedDeps }
  const config = await readEffectiveHarnessConfig(repoRoot)
  const now = deps.now()
  const discoveryWorker = shouldRunHarnessDiscovery(injectedDeps?.workerId)
  const discovery = discoveryWorker
    ? await pollGitHubDiscovery(repoRoot, config, deps.commandRunner)
    : {
        repoNameWithOwner: undefined,
        defaultBranch: config.sources.github.defaultBranch,
        pullRequests: [],
        failingDefaultBranchRun: null,
      }
  const remoteEvents = discoveryWorker
    ? await readRemoteTriggerEvents(repoRoot, config)
    : []

  const {
    repoId,
    leasedJobs,
    stateBeforeWork,
    workerId,
    runnerId,
    agentKind,
    leaseLimit,
  } = await withHostedHarnessState(
    async state => {
      const scopedRepoId = ensureHostedRepoRegistration(state, {
        repoRoot,
        config,
        repoNameWithOwner: discovery.repoNameWithOwner,
        defaultBranch: discovery.defaultBranch,
        now,
      })

      if (discoveryWorker) {
        applyCronJobs(repoRoot, scopedRepoId, config, state, now)
        applyGitHubDiscovery(repoRoot, scopedRepoId, config, state, discovery, now)
        applyRemoteTriggerJobs(repoRoot, scopedRepoId, config, state, now, remoteEvents)
      }

      const runnerContext = getEffectiveRunnerContext(deps, scopedRepoId)
      const leaseLimit =
        deps.leaseLimit ??
        (injectedDeps?.workerId ? 1 : runnerContext.slotCapacity)

      state.lastPolledAt = nowIso(now)
      refreshObservabilityHealth(state, now)
      if (!injectedDeps?.workerId) {
        state.workerHeartbeats[runnerContext.workerId] = buildNextWorkerHeartbeat(
          state.workerHeartbeats[runnerContext.workerId],
          {
            workerId: runnerContext.workerId,
            pid: process.pid,
            runnerId: runnerContext.runnerId,
            agentKind: runnerContext.agentKind,
            labels: runnerContext.labels,
            slotCapacity: runnerContext.slotCapacity,
            repoId: scopedRepoId,
            lastHeartbeatAt: nowIso(now),
            observabilityEnvLoaded: isHarnessObservabilityEnvLoaded(),
          },
        )
        upsertRunnerRegistration(state, runnerContext, now)
      }
      appendEventLedger(
        state,
        'cc_harness_poll_snapshot',
        {
          repoId: scopedRepoId,
          runnerId: runnerContext.runnerId,
          workerId: runnerContext.workerId,
          agentKind: runnerContext.agentKind,
          metadata: {
            pullRequestCount: discovery.pullRequests.length,
            remoteEventCount: remoteEvents.length,
          },
        },
        nowIso(now),
      )

      const leased = leaseNextJobs(
        state,
        config,
        scopedRepoId,
        now,
        runnerContext,
        Math.max(1, leaseLimit),
      )

      return {
        repoId: scopedRepoId,
        workerId: runnerContext.workerId,
        runnerId: runnerContext.runnerId,
        agentKind: runnerContext.agentKind,
        leaseLimit,
        leasedJobs: leased.map(job => structuredClone(job)),
        stateBeforeWork: filterHarnessStateForRepo(state, scopedRepoId),
      }
    },
  )
  await logHarnessWideEvent('cc_harness_poll_snapshot', {
    repoRoot,
    repoId,
    config,
    state: stateBeforeWork,
    workerId,
    metadata: {
      'harness.runner_id': runnerId,
      'harness.agent_kind': agentKind,
      'harness.discovery_pull_request_count': discovery.pullRequests.length,
      'harness.discovery_remote_event_count': remoteEvents.length,
      'harness.discovery_default_branch': discovery.defaultBranch,
      'harness.discovery_repo': discovery.repoNameWithOwner,
      'harness.discovery_default_branch_red':
        discovery.failingDefaultBranchRun != null,
      'harness.discovery_worker': discoveryWorker,
      'harness.leased_count': leasedJobs.length,
      'harness.lease_limit': leaseLimit,
    },
  })
  await emitHarnessExportHeartbeat({
    repoId,
    runnerId,
    workerId,
    agentKind,
    stage: 'worker_heartbeat',
  })

  let processedJobId: string | undefined
  let finalState = stateBeforeWork

  const workItems =
    leasedJobs.length > 1
      ? leasedJobs
      : leasedJobs.length === 1
        ? leasedJobs
        : []

  for (const leased of workItems) {
    await logHarnessWideEvent('cc_harness_job_leased', {
      repoRoot,
      repoId,
      config,
      state: finalState,
      job: leased,
      workerId,
    })

    try {
      const outcome = await processLeasedJob(
        repoRoot,
        repoId,
        config,
        finalState,
        leased,
        deps,
      )
      processedJobId = outcome.jobInstanceId
      finalState = await finalizeOutcome(
        repoRoot,
        repoId,
        config,
        leased,
        outcome,
        deps.commandRunner,
      )
      await logHarnessWideEvent('cc_harness_job_outcome', {
        repoRoot,
        repoId,
        config,
        state: finalState,
        job: leased,
        outcome,
        workerId,
      })
      await emitHarnessExportHeartbeat({
        repoId,
        runnerId,
        workerId,
        agentKind,
        stage: 'job_outcome',
        jobInstanceId: outcome.jobInstanceId,
      })
      const sessionObservation = Object.values(finalState.agentSessions).find(
        observation => observation.jobInstanceId === outcome.jobInstanceId,
      )
      if (sessionObservation) {
        await logHarnessAgentSessionObservation(sessionObservation)
      }
      await logHarnessAgentSessionTrend(
        summarizeAgentSessions(Object.values(finalState.agentSessions)),
      )
      await writeCompiledLearning(repoRoot, config, finalState)
      await recordHarnessOutcomeObservation(
        repoRoot,
        outcome,
        outcome.reviewerDecisions,
      )
    } catch (error) {
      logError(error)
      const failedOutcome: JobOutcome = {
        jobInstanceId: leased.instanceId,
        jobId: leased.jobId,
        status: 'failed',
        summary:
          error instanceof Error ? error.message : `runtime error: ${String(error)}`,
        startedAt: leased.startedAt ?? nowIso(now),
        completedAt: nowIso(deps.now()),
        attempt: leased.attempt,
        reviewerDecisions: [],
        verificationResults: [],
        autoMergeRequested: false,
        failureTags: ['runtime_error'],
        humanTouchCount: 0,
        totalCostUsd: 0,
        executionBackend: 'local',
        regressionDetected: Boolean(leased.metadata.regressionDetected),
      }
      processedJobId = failedOutcome.jobInstanceId
      finalState = await finalizeOutcome(
        repoRoot,
        repoId,
        config,
        leased,
        failedOutcome,
        deps.commandRunner,
      )
      await logHarnessWideEvent('cc_harness_job_outcome', {
        repoRoot,
        repoId,
        config,
        state: finalState,
        job: leased,
        outcome: failedOutcome,
        workerId,
      })
      await emitHarnessExportHeartbeat({
        repoId,
        runnerId,
        workerId,
        agentKind,
        stage: 'job_outcome',
        jobInstanceId: failedOutcome.jobInstanceId,
      })
    }
  }

  if (
    finalState.repoHealth[repoId]?.status !== 'healthy' &&
    finalState.sourceCursors.defaultBranches[repoId]
  ) {
    const healthy = await getDefaultBranchHealth(
      repoRoot,
      finalState.sourceCursors.defaultBranches[repoId]!,
      deps.commandRunner,
    )
    if (healthy) {
      finalState = await withHostedHarnessState(state => {
        state.repoHealth[repoId] = {
          ...state.repoHealth[repoId],
          repoId,
          status: 'healthy',
          pauseReason: undefined,
          lastHealthyAt: nowIso(deps.now()),
        }
        delete state.sourceCursors.failingRunKeys[repoId]
        return filterHarnessStateForRepo(state, repoId)
      })
    }
  }

  return {
    config,
    state: finalState,
    processedJobId,
  }
}

export async function ingestGitHubWebhookEvent(
  repoRoot: string,
  eventName: string,
  payload: Record<string, unknown>,
): Promise<{
  enqueued: string[]
  state: HarnessRuntimeState
}> {
  const config = await readEffectiveHarnessConfig(repoRoot)
  const now = new Date()
  const runner = createDefaultCommandRunner(repoRoot)

  const result = await withHostedHarnessState(async state => {
    const repo = payload.repository as
      | {
          full_name?: string
          default_branch?: string
        }
      | undefined
    const repoId = ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      repoNameWithOwner: repo?.full_name,
      defaultBranch: repo?.default_branch,
      now,
    })

    const enqueued: string[] = []
    const pullRequest = payload.pull_request as
      | {
          number?: number
          title?: string
          html_url?: string
          head?: { sha?: string; ref?: string }
          base?: { ref?: string }
        }
      | undefined
    const action = typeof payload.action === 'string' ? payload.action : ''

    const maybeEnqueue = (
      event: JobSpec['sourceBindings'][number] extends { event: infer T } ? T : string,
      promptVariables: Record<string, string>,
      metadata: Record<string, unknown>,
    ): void => {
      for (const jobSpec of config.jobs) {
        for (const binding of jobSpec.sourceBindings) {
          if (binding.type !== 'github' || binding.event !== event) {
            continue
          }
          if (
            binding.event === 'issue_labeled_automation' &&
            binding.label &&
            binding.label !== metadata.label
          ) {
            continue
          }
          const dedupeKey = createStableId(
            jobSpec.id,
            event,
            JSON.stringify(metadata),
          )
          const result = enqueueJob(
            state,
            repoId,
            jobSpec,
            'webhook',
            dedupeKey,
            buildPromptVariables(repoRoot, promptVariables),
            metadata,
            now,
          )
          if (result.instanceId) {
            enqueued.push(result.instanceId)
          }
        }
      }
    }

    if (eventName === 'pull_request' && pullRequest) {
      const commonVariables = {
        prNumber: String(pullRequest.number ?? ''),
        prTitle: pullRequest.title ?? '',
        prUrl: pullRequest.html_url ?? '',
        headSha: pullRequest.head?.sha ?? '',
        headRefName: pullRequest.head?.ref ?? '',
        baseRefName: pullRequest.base?.ref ?? '',
        repo: repo?.full_name ?? '',
      }
      if (action === 'opened') {
        maybeEnqueue('pull_request_opened', commonVariables, {
          eventName,
          action,
          prNumber: pullRequest.number,
          headSha: pullRequest.head?.sha,
        })
      } else if (action === 'synchronize') {
        maybeEnqueue('pull_request_push', commonVariables, {
          eventName,
          action,
          prNumber: pullRequest.number,
          headSha: pullRequest.head?.sha,
        })
      } else if (action === 'reopened') {
        maybeEnqueue('pull_request_reopened', commonVariables, {
          eventName,
          action,
          prNumber: pullRequest.number,
          headSha: pullRequest.head?.sha,
        })
      }
    }

    if (eventName === 'pull_request_review') {
      const review = payload.review as { state?: string } | undefined
      if ((review?.state ?? '').toLowerCase() === 'changes_requested' && pullRequest) {
        if (pullRequest.number != null) {
          recordGitHubRequestedChangesFinding(state, repoId, {
            prNumber: pullRequest.number,
            headSha: pullRequest.head?.sha,
            detectedAt: now.toISOString(),
          })
        }
        maybeEnqueue(
          'review_requested_changes',
          {
            prNumber: String(pullRequest.number ?? ''),
            prTitle: pullRequest.title ?? '',
            prUrl: pullRequest.html_url ?? '',
            headSha: pullRequest.head?.sha ?? '',
            headRefName: pullRequest.head?.ref ?? '',
            baseRefName: pullRequest.base?.ref ?? '',
            repo: repo?.full_name ?? '',
          },
          {
            eventName,
            action,
            prNumber: pullRequest.number,
            headSha: pullRequest.head?.sha,
            reviewState: review?.state,
          },
        )
      }
    }

    if (eventName === 'issues') {
      const issue = payload.issue as
        | { number?: number; title?: string; html_url?: string }
        | undefined
      const label = payload.label as { name?: string } | undefined
      if (action === 'labeled' && issue && label?.name) {
        maybeEnqueue(
          'issue_labeled_automation',
          {
            prNumber: String(issue.number ?? ''),
            prTitle: issue.title ?? '',
            prUrl: issue.html_url ?? '',
            repo: repo?.full_name ?? '',
          },
          {
            eventName,
            action,
            label: label.name,
            prNumber: issue.number,
          },
        )
      }
    }

    if (eventName === 'workflow_run') {
      const workflowRun = payload.workflow_run as
        | {
            id?: number
            head_sha?: string
            head_branch?: string
            conclusion?: string
            name?: string
            html_url?: string
          }
        | undefined
      if (
        workflowRun?.head_branch &&
        repo?.default_branch &&
        workflowRun.head_branch === repo.default_branch &&
        !['success', 'neutral', 'skipped'].includes(
          (workflowRun.conclusion ?? '').toLowerCase(),
        )
      ) {
        maybeEnqueue(
          'default_branch_failure',
          {
            defaultBranch: repo.default_branch,
            headSha: workflowRun.head_sha ?? '',
            workflowName: workflowRun.name ?? 'workflow',
            runUrl: workflowRun.html_url ?? '',
          },
          {
            eventName,
            action,
            databaseId: workflowRun.id,
            headSha: workflowRun.head_sha,
            workflowName: workflowRun.name,
            runUrl: workflowRun.html_url,
          },
        )
        state.repoHealth[repoId] = {
          ...state.repoHealth[repoId],
          repoId,
          status: config.autonomy.pauseOnMainRed ? 'red' : 'healthy',
          pauseReason: config.autonomy.pauseOnMainRed
            ? `default branch ${repo.default_branch} is red at ${workflowRun.head_sha ?? 'unknown'}`
            : undefined,
          lastFailureAt: now.toISOString(),
          lastObservedFailureHeadSha: workflowRun.head_sha,
        }
        if (
          state.repoHealth[repoId]?.lastAutoMergePrNumber != null &&
          state.repoHealth[repoId]?.lastAutoMergeHeadSha === workflowRun.head_sha
        ) {
          recordDefaultBranchFailureIncident(state, repoId, {
            prNumber: state.repoHealth[repoId]!.lastAutoMergePrNumber!,
            headSha: workflowRun.head_sha,
            detectedAt: now.toISOString(),
            summary: `Default branch workflow ${workflowRun.name ?? 'workflow'} failed after merging PR #${state.repoHealth[repoId]!.lastAutoMergePrNumber!}.`,
          })
        }
      }
    }

    if (pullRequest?.number != null) {
      await syncPullRequestQualityFromGitHub({
        repoRoot,
        repoId,
        prNumber: pullRequest.number,
        state,
        runner,
        now,
      })
    }
    await ingestGstackQualityArtifacts(repoRoot, repoId, state, now)
    refreshRepoQualitySnapshots(state, repoId, now.toISOString())
    state.lastPolledAt = now.toISOString()
    return {
      enqueued,
      state: filterHarnessStateForRepo(state, repoId),
    }
  })

  await logHarnessWideEvent('cc_harness_webhook_ingested', {
    repoRoot,
    repoId: buildHarnessRepoId(repoRoot),
    config,
    state: result.state,
    metadata: {
      'harness.webhook_event_name': eventName,
      'harness.webhook_action':
        typeof payload.action === 'string' ? payload.action : undefined,
      'harness.webhook_enqueued_count': result.enqueued.length,
    },
  })

  return result
}

export async function getHarnessStatus(
  repoRoot: string,
): Promise<{
  config: HarnessConfig
  state: HarnessRuntimeState
  controlPlane: ReturnType<typeof getHostedHarnessControlPlaneInfo>
  queuedCount: number
  activeCount: number
  runners: RunnerRegistration[]
  totalSlotCapacity: number
  slotCapacityByAgentKind: Record<Exclude<HarnessAgentKind, 'either'>, number>
  activeByAgentKind: Record<Exclude<HarnessAgentKind, 'either'>, number>
  queuedCapacityShortfalls: Record<Exclude<HarnessAgentKind, 'either'>, number>
  fleet: {
    expectedRunners: string[]
    registeredRunners: string[]
    expectedSlotCapacity: number
    registeredSlotCapacity: number
    missingRunners: string[]
    missingSlots: number
  }
  observability: HarnessRuntimeState['observability'] & {
    agentSessionTrend: ReturnType<typeof summarizeAgentSessions>
  }
}> {
  const config = await readEffectiveHarnessConfig(repoRoot)
  const runnerManifest = await readHarnessRunnerManifest(repoRoot)
  const runner = createDefaultCommandRunner(repoRoot)
  const now = new Date()
  const discovery = await pollGitHubDiscovery(repoRoot, config, runner)
  const { state, globalState, queuedCount, activeCount } = await withHostedHarnessState(
    async globalState => {
      const repoId = ensureHostedRepoRegistration(globalState, {
        repoRoot,
        config,
        repoNameWithOwner: discovery.repoNameWithOwner,
        defaultBranch: discovery.defaultBranch,
        now,
      })
      await syncRepoQualityState(
        repoRoot,
        repoId,
        globalState,
        discovery,
        runner,
        now,
      )
      refreshObservabilityHealth(globalState, now)
      return {
        state: filterHarnessStateForRepo(globalState, repoId),
        globalState: structuredClone(globalState),
        queuedCount: computeRepoScopedQueuedCount(globalState, repoId),
        activeCount: computeRepoScopedActiveCount(globalState, repoId),
      }
    },
  )
  const capacitySummary = collectRunnerCapacitySummary(globalState)
  const agentSessionTrend = summarizeAgentSessions(Object.values(state.agentSessions))
  const manifestSummary = computeHarnessRunnerManifestSummary(runnerManifest)
  const registeredRunners = Object.values(globalState.runners)
    .filter(runner => runner.healthy)
    .map(runner => runner.runnerId)
    .sort()
  const missingRunners = manifestSummary.expectedRunners.filter(
    runnerId => !registeredRunners.includes(runnerId),
  )

  return {
    config,
    state,
    controlPlane: getHostedHarnessControlPlaneInfo(),
    queuedCount,
    activeCount,
    runners: Object.values(globalState.runners).sort((left, right) =>
      left.runnerId.localeCompare(right.runnerId),
    ),
    totalSlotCapacity: capacitySummary.totalSlotCapacity,
    slotCapacityByAgentKind: capacitySummary.slotCapacityByAgentKind,
    activeByAgentKind: countRunnerActiveLeasesByAgentKind(globalState),
    queuedCapacityShortfalls: computeQueuedCapacityShortfalls(globalState),
    fleet: {
      expectedRunners: manifestSummary.expectedRunners,
      registeredRunners,
      expectedSlotCapacity: manifestSummary.expectedSlotCapacity,
      registeredSlotCapacity: capacitySummary.totalSlotCapacity,
      missingRunners,
      missingSlots: Math.max(
        0,
        manifestSummary.expectedSlotCapacity - capacitySummary.totalSlotCapacity,
      ),
    },
    observability: {
      ...state.observability,
      agentSessionTrend,
    },
  }
}

export async function getHarnessQualityStatus(
  repoRoot: string,
): Promise<{
  config: HarnessConfig
  state: HarnessRuntimeState
  quality: ReturnType<typeof getRepoQualityStatus>
}> {
  const status = await getHarnessStatus(repoRoot)
  const repoId = Object.keys(status.state.repos)[0]
  if (!repoId) {
    return {
      config: status.config,
      state: status.state,
      quality: {
        repoId: 'unknown',
        snapshots: [],
        openIncidentCount: 0,
        openCriticalIncidentCount: 0,
        recentPrs: [],
      },
    }
  }
  return {
    config: status.config,
    state: status.state,
    quality: getRepoQualityStatus(status.state, repoId),
  }
}

export async function getHarnessPullRequestQuality(
  repoRoot: string,
  prNumber: number,
): Promise<{
  config: HarnessConfig
  state: HarnessRuntimeState
  quality: ReturnType<typeof getPullRequestQualityStatus>
}> {
  const status = await getHarnessStatus(repoRoot)
  const repoId = Object.keys(status.state.repos)[0]
  return {
    config: status.config,
    state: status.state,
    quality: repoId
      ? getPullRequestQualityStatus(status.state, repoId, prNumber)
      : null,
  }
}

export async function annotateHarnessIncident(
  repoRoot: string,
  input: {
    prNumber: number
    summary: string
    severity: 'low' | 'medium' | 'high' | 'critical'
    detectedAt?: string
    mergeSha?: string
  },
): Promise<{
  incident: ReturnType<typeof annotateManualIncident>
  state: HarnessRuntimeState
}> {
  const config = await readEffectiveHarnessConfig(repoRoot)
  const result = await withHostedHarnessState(async state => {
    const repoId = ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      now: new Date(),
    })
    const incident = annotateManualIncident(state, {
      repoId,
      prNumber: input.prNumber,
      summary: input.summary,
      severity: input.severity,
      detectedAt: input.detectedAt,
      mergeSha: input.mergeSha,
    })
    await ingestGstackQualityArtifacts(repoRoot, repoId, state, new Date())
    refreshRepoQualitySnapshots(state, repoId, nowIso())
    return {
      incident,
      state: filterHarnessStateForRepo(state, repoId),
    }
  })

  await logHarnessWideEvent('cc_harness_repo_state', {
    repoRoot,
    repoId: Object.keys(result.state.repos)[0],
    config,
    state: result.state,
    metadata: {
      'harness.repo_action': 'quality_annotate_incident',
      'harness.quality_pr_number': input.prNumber,
      'harness.quality_severity': input.severity,
      'harness.quality_summary': input.summary,
    },
  })

  return result
}

export async function pauseHarness(
  repoRoot: string,
  reason: string = 'paused manually',
): Promise<HarnessRuntimeState> {
  const config = await readEffectiveHarnessConfig(repoRoot)
  const nextState = await withHostedHarnessState(state => {
    const repoId = ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      now: new Date(),
    })
    state.repoHealth[repoId] = {
      ...state.repoHealth[repoId],
      repoId,
      status: 'paused',
      pauseReason: reason,
    }
    state.paused = true
    state.pauseReason = reason
    return filterHarnessStateForRepo(state, repoId)
  })

  await logHarnessWideEvent('cc_harness_repo_state', {
    repoRoot,
    repoId: buildHarnessRepoId(repoRoot),
    config,
    state: nextState,
    metadata: {
      'harness.repo_action': 'pause',
      'harness.repo_reason': reason,
    },
  })

  return nextState
}

export async function resumeHarness(
  repoRoot: string,
): Promise<HarnessRuntimeState> {
  const config = await readEffectiveHarnessConfig(repoRoot)
  const nextState = await withHostedHarnessState(state => {
    const repoId = ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      now: new Date(),
    })
    state.repoHealth[repoId] = {
      ...state.repoHealth[repoId],
      repoId,
      status: 'healthy',
      pauseReason: undefined,
      lastHealthyAt: new Date().toISOString(),
    }
    state.paused = false
    state.pauseReason = undefined
    return filterHarnessStateForRepo(state, repoId)
  })

  await logHarnessWideEvent('cc_harness_repo_state', {
    repoRoot,
    repoId: buildHarnessRepoId(repoRoot),
    config,
    state: nextState,
    metadata: {
      'harness.repo_action': 'resume',
    },
  })

  return nextState
}

export async function runHarnessJob(
  repoRoot: string,
  jobId: string,
  injectedDeps?: Partial<HarnessDependencies>,
): Promise<{
  state: HarnessRuntimeState
  instanceId: string
}> {
  const config = await readEffectiveHarnessConfig(repoRoot)
  const jobSpec = findJobSpec(config, jobId)
  if (!jobSpec) {
    throw new Error(`Unknown harness job: ${jobId}`)
  }
  const now = injectedDeps?.now?.() ?? new Date()
  const repoId = await withHostedHarnessState(state =>
    ensureHostedRepoRegistration(state, {
      repoRoot,
      config,
      now,
    }),
  )

  const dedupeKey = createStableId(jobId, 'manual', now.toISOString())
  const instanceId = await withHostedHarnessState(state => {
    const enqueued = enqueueJob(
      state,
      repoId,
      jobSpec,
      'manual',
      dedupeKey,
      buildPromptVariables(repoRoot, {
        manualRunAt: now.toISOString(),
      }),
      { requestedBy: 'cli' },
      now,
    )
    if (!enqueued.instanceId) {
      throw new Error(`Failed to enqueue harness job: ${jobId}`)
    }
    return enqueued.instanceId
  })

  const result = await pollHarnessOnce(repoRoot, injectedDeps)
  return {
    state: result.state,
    instanceId,
  }
}

export async function runHarnessDaemonWorker(
  repoRoot: string,
  injectedDeps?: Partial<HarnessDependencies>,
): Promise<void> {
  const deps = { ...createHarnessDependencies(repoRoot), ...injectedDeps }
  const repoId = buildHarnessRepoId(repoRoot)
  const runnerContext = getEffectiveRunnerContext(deps, repoId)
  let running = true
  const stop = () => {
    running = false
  }

  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  const heartbeat = async (): Promise<void> => {
    const control = await readDaemonControl(repoRoot)
    control.pid = process.pid
    control.startedAt ??= nowIso(deps.now())
    control.lastHeartbeatAt = nowIso(deps.now())
    control.mode = 'hosted'
    await writeDaemonControl(repoRoot, control)

    await withHostedHarnessState(state => {
      state.daemon.pid = process.pid
      state.daemon.startedAt = control.startedAt
      state.daemon.lastHeartbeatAt = control.lastHeartbeatAt
      refreshObservabilityHealth(state, deps.now())
      state.workerHeartbeats[runnerContext.workerId] = buildNextWorkerHeartbeat(
        state.workerHeartbeats[runnerContext.workerId],
        {
          workerId: runnerContext.workerId,
          pid: process.pid,
          runnerId: runnerContext.runnerId,
          agentKind: runnerContext.agentKind,
          labels: runnerContext.labels,
          slotCapacity: runnerContext.slotCapacity,
          repoId,
          lastHeartbeatAt: control.lastHeartbeatAt!,
          observabilityEnvLoaded: isHarnessObservabilityEnvLoaded(),
        },
      )
      upsertRunnerRegistration(state, runnerContext, deps.now())
      appendEventLedger(
        state,
        'cc_harness_worker_lifecycle',
        {
          repoId,
          runnerId: runnerContext.runnerId,
          workerId: runnerContext.workerId,
          agentKind: runnerContext.agentKind,
          metadata: {
            action: 'heartbeat',
            pid: process.pid,
          },
        },
        control.lastHeartbeatAt!,
      )
    })
    void runBestEffortHarnessStartupTask(
      emitHarnessExportHeartbeat({
        repoId,
        runnerId: runnerContext.runnerId,
        workerId: runnerContext.workerId,
        agentKind: runnerContext.agentKind,
        stage: 'worker_heartbeat',
      }),
      'emit worker heartbeat export',
    )
  }

  await heartbeat()
  void runBestEffortHarnessStartupTask(
    logHarnessWideEvent('cc_harness_worker_lifecycle', {
      repoRoot,
      repoId,
      workerId: runnerContext.workerId,
      metadata: {
        'harness.worker_action': 'started',
        'harness.runner_id': runnerContext.runnerId,
        'harness.agent_kind': runnerContext.agentKind,
        'harness.slot_capacity': runnerContext.slotCapacity,
        'harness.labels': runnerContext.labels,
        'harness.pid': process.pid,
      },
    }),
    'log worker started event',
  )
  void runBestEffortHarnessStartupTask(
    emitHarnessExportHeartbeat({
      repoId,
      runnerId: runnerContext.runnerId,
      workerId: runnerContext.workerId,
      agentKind: runnerContext.agentKind,
      stage: 'worker_started',
    }),
    'emit worker started export heartbeat',
  )

  const heartbeatLoop = (async (): Promise<void> => {
    while (running) {
      await deps.sleep(DEFAULT_DAEMON_TICK_MS)
      if (!running) {
        break
      }
      try {
        await heartbeat()
      } catch (error) {
        logError(
          `Harness heartbeat failed for ${runnerContext.workerId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  })()

  try {
    while (running) {
      try {
        await pollHarnessOnce(repoRoot, {
          ...deps,
          workerId: runnerContext.workerId,
          runnerId: runnerContext.runnerId,
          agentKind: runnerContext.agentKind,
          workerSlots: runnerContext.slotCapacity,
          runnerLabels: runnerContext.labels,
          leaseLimit: Math.max(1, deps.leaseLimit ?? 1),
        })
      } catch (error) {
        logError(
          `Harness poll failed for ${runnerContext.workerId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!running) {
        break
      }
      await deps.sleep(DEFAULT_DAEMON_TICK_MS)
    }
  } finally {
    running = false
    await heartbeatLoop
  }

  await logHarnessWideEvent('cc_harness_worker_lifecycle', {
    repoRoot,
    repoId,
    workerId: runnerContext.workerId,
    metadata: {
      'harness.worker_action': 'stopped',
      'harness.runner_id': runnerContext.runnerId,
      'harness.agent_kind': runnerContext.agentKind,
      'harness.pid': process.pid,
    },
  })
}
