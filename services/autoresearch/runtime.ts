import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import picomatch from 'picomatch'
import { execa } from 'execa'
import { logForDebugging } from 'src/utils/debug.js'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import { safeParseJSON } from 'src/utils/json.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { logOTelEvent } from 'src/utils/telemetry/events.js'
import {
  buildSplitterTelemetryFields,
  buildSplitterTopologyTelemetryFields,
  resolveAutoresearchSplitterConfig,
} from './splitter.js'
import { summarizeClaudeCodeSessionObservations } from './claudeCodeSessions.js'
import {
  type AdmissionThresholds,
  type AutoresearchConfig,
  AutoresearchConfigSchema,
  type AutoresearchSettings,
  type BenchmarkAuditCase,
  BenchmarkAuditCaseSchema,
  type BenchmarkCase,
  type BenchmarkCorpusVersion,
  BenchmarkCorpusVersionSchema,
  type BenchmarkProposal,
  BenchmarkProposalSchema,
  type CandidateEvaluation,
  type CandidateManifest,
  CandidateEvaluationSchema,
  CandidateManifestSchema,
  type ChallengeSet,
  ChallengeSetSchema,
  type ClaudeCodeSessionObservation,
  ClaudeCodeSessionObservationSchema,
  type ClaudeCodeTrendSnapshot,
  type DogfoodObservation,
  DogfoodObservationSchema,
  type ExperimentRun,
  ExperimentRunSchema,
  type LaneAssignment,
  type LearningDelta,
  LearningDeltaSchema,
  type PromotionDecision,
  type RolloutLane,
  type RolloutState,
  RolloutStateSchema,
  type Scorecard,
  ScorecardSchema,
} from './types.js'

const DEFAULT_SCHEDULER_CADENCE_MS = 5 * 60 * 1000

const STATE_FILE_NAME = 'state.json'
const CORPUS_FILE_NAME = 'corpus.json'
const CHALLENGE_SET_FILE_NAME = 'challenge-set.json'
const INTERNAL_CANDIDATE_DIR = path.join('incoming', 'candidates')
const INTERNAL_PROPOSAL_DIR = path.join('incoming', 'benchmark-proposals')
const INTERNAL_OBSERVATION_DIR = path.join('incoming', 'dogfood-observations')
const INTERNAL_CLAUDE_CODE_SESSION_DIR = path.join(
  'incoming',
  'claude-code-sessions',
)
const EXPERIMENTS_DIR = 'experiments'
const AUDITS_DIR = 'audits'

type ResolvedAutoresearchControllerConfig = Omit<
  AutoresearchConfig,
  'seedCorpusPath' | 'seedChallengeSetPath'
> & {
  configPath: string
  configDir: string
  seedCorpusPath: string
  seedChallengeSetPath: string
}

type ResolvedAutoresearchConfig =
  | { enabled: false; invalidReason?: string }
  | {
      enabled: true
      repoRoot: string
      statePath: string
      schedulerCadenceMs: number
      emitTelemetry: boolean
      controllerConfig: ResolvedAutoresearchControllerConfig
    }

type ManagedPaths = {
  stateDir: string
  stateFile: string
  corpusFile: string
  challengeSetFile: string
  experimentsDir: string
  auditsDir: string
  candidateDir: string
  proposalDir: string
  observationDir: string
  claudeCodeSessionDir: string
}

type BenchmarkAdmissionDecision = {
  tier: BenchmarkCase['tier']
  reasons: string[]
}

function createHashDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

function getDefaultStatePath(repoRoot: string): string {
  return path.join(
    getClaudeConfigHomeDir(),
    'autoresearch',
    createHashDigest(repoRoot).slice(0, 12),
  )
}

function getManagedPaths(stateDir: string): ManagedPaths {
  return {
    stateDir,
    stateFile: path.join(stateDir, STATE_FILE_NAME),
    corpusFile: path.join(stateDir, CORPUS_FILE_NAME),
    challengeSetFile: path.join(stateDir, CHALLENGE_SET_FILE_NAME),
    experimentsDir: path.join(stateDir, EXPERIMENTS_DIR),
    auditsDir: path.join(stateDir, AUDITS_DIR),
    candidateDir: path.join(stateDir, INTERNAL_CANDIDATE_DIR),
    proposalDir: path.join(stateDir, INTERNAL_PROPOSAL_DIR),
    observationDir: path.join(stateDir, INTERNAL_OBSERVATION_DIR),
    claudeCodeSessionDir: path.join(stateDir, INTERNAL_CLAUDE_CODE_SESSION_DIR),
  }
}

async function readJsonFile<T>(
  filePath: string,
  parse: (value: unknown) => T,
): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = safeParseJSON(raw, false)
    if (parsed == null) {
      return null
    }
    return parse(parsed)
  } catch {
    return null
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${jsonStringify(value, null, 2)}\n`, 'utf-8')
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2
  }
  return sorted[midpoint]
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function getTierWeight(tier: BenchmarkCase['tier']): number {
  switch (tier) {
    case 'proposed':
      return 0
    case 'quarantine':
      return 1
    case 'gold':
      return 2
    case 'hidden':
      return 3
  }
}

function compareScorecards(left: Scorecard, right: Scorecard): number {
  if (left.taskSuccessRate !== right.taskSuccessRate) {
    return left.taskSuccessRate - right.taskSuccessRate
  }
  if (left.artifactValidityRate !== right.artifactValidityRate) {
    return left.artifactValidityRate - right.artifactValidityRate
  }
  if (left.medianTokenCost !== right.medianTokenCost) {
    return right.medianTokenCost - left.medianTokenCost
  }
  if (left.medianRuntimeMs !== right.medianRuntimeMs) {
    return right.medianRuntimeMs - left.medianRuntimeMs
  }
  if (left.challengeSetCatchRate !== right.challengeSetCatchRate) {
    return left.challengeSetCatchRate - right.challengeSetCatchRate
  }
  return left.benchmarkStabilityRate - right.benchmarkStabilityRate
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function buildAggregateFailureTagsFromCaseResult(
  benchmarkCase: BenchmarkCase | undefined,
  caseResult: CandidateEvaluation['caseResults'][number],
): string[] {
  const tags = new Set<string>()
  if (!caseResult.passed && benchmarkCase) {
    for (const failureTag of benchmarkCase.canonicalFailureTags) {
      tags.add(failureTag)
    }
  }
  for (const failureTag of caseResult.failureTags ?? []) {
    tags.add(failureTag)
  }
  if (caseResult.unsupportedClaims > 0) {
    tags.add('unsupported_claims')
  }
  if (caseResult.verifierBypasses > 0) {
    tags.add('verification_bypass')
  }
  if (caseResult.phaseViolations > 0) {
    tags.add('phase_violation')
  }
  if (caseResult.missingEvidenceCompletions > 0) {
    tags.add('missing_evidence_completion')
  }
  if (!caseResult.taskSuccess) {
    tags.add('task_failed')
  }
  if (!caseResult.artifactValid) {
    tags.add('artifact_invalid')
  }
  return uniqueSorted(tags)
}

function collectMistakeTagsFromEvaluation(
  corpus: BenchmarkCorpusVersion,
  evaluation: CandidateEvaluation,
): string[] {
  const benchmarkCases = new Map(
    corpus.cases.map(benchmarkCase => [benchmarkCase.id, benchmarkCase]),
  )
  const tags = new Set<string>()
  for (const caseResult of evaluation.caseResults) {
    for (const failureTag of buildAggregateFailureTagsFromCaseResult(
      benchmarkCases.get(caseResult.caseId),
      caseResult,
    )) {
      tags.add(failureTag)
    }
  }
  for (const challengeResult of evaluation.challengeResults) {
    if (!challengeResult.caught) {
      tags.add(`challenge_escape:${challengeResult.challengeId}`)
    }
  }
  if (evaluation.dogfoodMissRate > 0) {
    tags.add('dogfood_miss')
  }
  return uniqueSorted(tags)
}

function buildLearningDelta(
  baselineMistakeTags: string[],
  currentMistakeTags: string[],
): LearningDelta {
  const baselineSet = new Set(baselineMistakeTags)
  const currentSet = new Set(currentMistakeTags)
  return LearningDeltaSchema().parse({
    baselineMistakeTags: uniqueSorted(baselineSet),
    currentMistakeTags: uniqueSorted(currentSet),
    newMistakeTags: uniqueSorted(
      [...currentSet].filter(mistakeTag => !baselineSet.has(mistakeTag)),
    ),
    fixedMistakeTags: uniqueSorted(
      [...baselineSet].filter(mistakeTag => !currentSet.has(mistakeTag)),
    ),
    repeatedMistakeTags: uniqueSorted(
      [...currentSet].filter(mistakeTag => baselineSet.has(mistakeTag)),
    ),
  })
}

function mergeLearningDeltaWithObservation(
  learningDelta: LearningDelta,
  observationFailureTags: string[],
): LearningDelta {
  if (observationFailureTags.length === 0) {
    return learningDelta
  }
  const mergedCurrentTags = uniqueSorted([
    ...learningDelta.currentMistakeTags,
    ...observationFailureTags,
  ])
  return buildLearningDelta(learningDelta.baselineMistakeTags, mergedCurrentTags)
}

function buildLearningTelemetryFields(
  learningDelta: LearningDelta,
): Record<string, string> {
  return {
    'autoresearch.current_mistake_count': String(
      learningDelta.currentMistakeTags.length,
    ),
    'autoresearch.new_mistake_count': String(
      learningDelta.newMistakeTags.length,
    ),
    'autoresearch.fixed_mistake_count': String(
      learningDelta.fixedMistakeTags.length,
    ),
    'autoresearch.repeated_mistake_count': String(
      learningDelta.repeatedMistakeTags.length,
    ),
    'autoresearch.current_mistake_tags': learningDelta.currentMistakeTags.join(','),
    'autoresearch.new_mistake_tags': learningDelta.newMistakeTags.join(','),
    'autoresearch.fixed_mistake_tags': learningDelta.fixedMistakeTags.join(','),
    'autoresearch.repeated_mistake_tags':
      learningDelta.repeatedMistakeTags.join(','),
  }
}

function joinTelemetryList(values: string[]): string {
  return uniqueSorted(values).join(',')
}

function countLaneAssignments(
  state: RolloutState,
  lane: RolloutLane,
): number {
  return state.laneAssignments.filter(
    laneAssignment => laneAssignment.lane === lane,
  ).length
}

function getTeacherQualityVerdict(state: RolloutState): string {
  return state.teacherFrozen ? 'frozen' : 'healthy'
}

function buildStateTelemetryFields(
  state: RolloutState,
): Record<string, string | undefined> {
  const openAudits = state.audits.filter(audit => audit.status === 'open')
  const championExperiment = state.currentChampionCandidateId
    ? state.experiments.find(
        experiment => experiment.candidateId === state.currentChampionCandidateId,
      )
    : undefined

  return {
    'autoresearch.corpus_version': state.corpusVersion,
    'autoresearch.challenge_set_version': state.challengeSetVersion,
    'autoresearch.teacher_frozen': String(state.teacherFrozen),
    'autoresearch.teacher_quality_verdict': getTeacherQualityVerdict(state),
    'autoresearch.teacher_freeze_reason': state.freezeReason,
    'autoresearch.open_audit_count': String(openAudits.length),
    'autoresearch.open_audit_reasons': joinTelemetryList(
      openAudits.map(audit => audit.reason),
    ),
    'autoresearch.current_champion_candidate_id': state.currentChampionCandidateId,
    'autoresearch.previous_champion_candidate_id':
      state.previousChampionCandidateId,
    'autoresearch.processed_candidate_count': String(
      state.processedCandidateIds.length,
    ),
    'autoresearch.processed_proposal_count': String(
      state.processedProposalIds.length,
    ),
    'autoresearch.processed_observation_count': String(
      state.processedObservationIds.length,
    ),
    'autoresearch.processed_claude_code_observation_count': String(
      state.processedClaudeCodeObservationIds.length,
    ),
    'autoresearch.total_experiment_count': String(state.experiments.length),
    'autoresearch.lane_assignment_count': String(state.laneAssignments.length),
    'autoresearch.shadow_lane_count': String(countLaneAssignments(state, 'shadow')),
    'autoresearch.dogfood_lane_count': String(
      countLaneAssignments(state, 'dogfood'),
    ),
    'autoresearch.canary_lane_count': String(countLaneAssignments(state, 'canary')),
    'autoresearch.rollout_champion_count': String(
      state.laneAssignments.filter(laneAssignment => laneAssignment.rolloutChampion)
        .length,
    ),
    'autoresearch.current_champion_mistake_tags': championExperiment
      ? joinTelemetryList(championExperiment.learningDelta.currentMistakeTags)
      : undefined,
    ...buildClaudeCodeTrendTelemetryFields(state.lastClaudeCodeTrendSnapshot),
  }
}

function buildCorpusTelemetryFields(
  corpus: BenchmarkCorpusVersion,
): Record<string, string> {
  const countByTier = (tier: BenchmarkCase['tier']) =>
    corpus.cases.filter(benchmarkCase => benchmarkCase.tier === tier).length
  return {
    'autoresearch.corpus_case_count': String(corpus.cases.length),
    'autoresearch.proposed_case_count': String(countByTier('proposed')),
    'autoresearch.quarantine_case_count': String(countByTier('quarantine')),
    'autoresearch.gold_case_count': String(countByTier('gold')),
    'autoresearch.hidden_case_count': String(countByTier('hidden')),
  }
}

function buildChallengeSetTelemetryFields(
  challengeSet: ChallengeSet,
): Record<string, string> {
  return {
    'autoresearch.challenge_set_version': challengeSet.version,
    'autoresearch.challenge_candidate_count': String(
      challengeSet.challengeCandidates.length,
    ),
  }
}

function buildCandidateTelemetryFields(
  candidate: CandidateManifest,
): Record<string, string | undefined> {
  return {
    'autoresearch.candidate_revision': candidate.revision,
    'autoresearch.candidate_mutation_class': candidate.mutationClass,
    'autoresearch.candidate_hypothesis': candidate.hypothesis,
    'autoresearch.candidate_source': candidate.source,
    'autoresearch.candidate_changed_file_count': String(
      candidate.changedFiles.length,
    ),
    'autoresearch.candidate_changed_files_digest':
      candidate.changedFiles.length > 0
        ? createHashDigest(candidate.changedFiles.join('|')).slice(0, 16)
        : undefined,
  }
}

function buildScorecardTelemetryFields(
  scorecard: Scorecard,
): Record<string, string> {
  return {
    'autoresearch.benchmark_count': String(scorecard.benchmarkCount),
    'autoresearch.task_success_rate': String(scorecard.taskSuccessRate),
    'autoresearch.artifact_validity_rate': String(scorecard.artifactValidityRate),
    'autoresearch.unsupported_claim_rate': String(
      scorecard.unsupportedClaimRate,
    ),
    'autoresearch.verifier_bypass_rate': String(scorecard.verifierBypassRate),
    'autoresearch.phase_violation_rate': String(scorecard.phaseViolationRate),
    'autoresearch.missing_evidence_completion_rate': String(
      scorecard.missingEvidenceCompletionRate,
    ),
    'autoresearch.median_token_cost': String(scorecard.medianTokenCost),
    'autoresearch.median_runtime_ms': String(scorecard.medianRuntimeMs),
    'autoresearch.median_tool_call_count': String(scorecard.medianToolCallCount),
    'autoresearch.token_cost_delta_pct': String(scorecard.tokenCostDeltaPct),
    'autoresearch.runtime_delta_pct': String(scorecard.runtimeDeltaPct),
    'autoresearch.hidden_holdout_pass': String(scorecard.hiddenHoldoutPass),
    'autoresearch.hidden_holdout_predictive_accuracy': String(
      scorecard.hiddenHoldoutPredictiveAccuracy,
    ),
    'autoresearch.must_pass_regression_count': String(
      scorecard.mustPassRegressionCount,
    ),
    'autoresearch.challenge_set_catch_rate': String(
      scorecard.challengeSetCatchRate,
    ),
    'autoresearch.benchmark_stability_rate': String(
      scorecard.benchmarkStabilityRate,
    ),
    'autoresearch.dogfood_miss_rate': String(scorecard.dogfoodMissRate),
    'autoresearch.eligible_for_promotion': String(scorecard.eligibleForPromotion),
    'autoresearch.scorecard_reason_count': String(scorecard.reasons.length),
    'autoresearch.scorecard_reasons': joinTelemetryList(scorecard.reasons),
  }
}

function buildPromotionTelemetryFields(
  decision: PromotionDecision | undefined,
): Record<string, string | undefined> {
  return {
    'autoresearch.promotion_decision': decision?.decision,
    'autoresearch.promotion_reason': decision?.reason,
    'autoresearch.promotion_target_lane': decision?.targetLane,
    'autoresearch.promotion_timestamp': decision?.timestamp,
  }
}

function buildCaseResultTelemetryFields(
  benchmarkCase: BenchmarkCase | undefined,
  caseResult: CandidateEvaluation['caseResults'][number],
): Record<string, string> {
  const failureTags = buildAggregateFailureTagsFromCaseResult(
    benchmarkCase,
    caseResult,
  )
  return {
    'autoresearch.case_passed': String(caseResult.passed),
    'autoresearch.case_task_success': String(caseResult.taskSuccess),
    'autoresearch.case_artifact_valid': String(caseResult.artifactValid),
    'autoresearch.case_unsupported_claims': String(caseResult.unsupportedClaims),
    'autoresearch.case_verifier_bypasses': String(caseResult.verifierBypasses),
    'autoresearch.case_phase_violations': String(caseResult.phaseViolations),
    'autoresearch.case_missing_evidence_completions': String(
      caseResult.missingEvidenceCompletions,
    ),
    'autoresearch.case_token_cost': String(caseResult.tokenCost),
    'autoresearch.case_runtime_ms': String(caseResult.runtimeMs),
    'autoresearch.case_tool_call_count': String(caseResult.toolCallCount),
    'autoresearch.case_predicted_regression': String(
      caseResult.predictedRegression,
    ),
    'autoresearch.case_failure_tag_count': String(failureTags.length),
    'autoresearch.failure_tags': joinTelemetryList(failureTags),
    'autoresearch.case_must_pass': String(benchmarkCase?.mustPass ?? false),
    'autoresearch.case_provenance': benchmarkCase?.provenance ?? 'unknown',
  }
}

function buildChallengeResultTelemetryFields(
  challengeSet: ChallengeSet,
  challengeResult: CandidateEvaluation['challengeResults'][number],
): Record<string, string> {
  const challengeCandidate = challengeSet.challengeCandidates.find(
    challengeCandidate => challengeCandidate.id === challengeResult.challengeId,
  )
  return {
    'autoresearch.challenge_caught': String(challengeResult.caught),
    'autoresearch.challenge_expected_failure_tags': joinTelemetryList(
      challengeCandidate?.expectedFailureTags ?? [],
    ),
  }
}

function buildObservationTelemetryFields(
  observation: DogfoodObservation,
): Record<string, string | undefined> {
  return {
    'autoresearch.observation_id': observation.id,
    'autoresearch.lane': observation.lane,
    'autoresearch.result': observation.success ? 'success' : 'failure',
    'autoresearch.actual_regression': String(observation.actualRegression),
    'autoresearch.predicted_regression': String(
      observation.predictedRegression,
    ),
    'autoresearch.failure_tag_count': String(observation.failureTags.length),
    'autoresearch.failure_tags': joinTelemetryList(observation.failureTags),
    'autoresearch.observation_summary': observation.summary,
  }
}

function buildClaudeCodeSessionTelemetryFields(
  observation: ClaudeCodeSessionObservation,
): Record<string, string | undefined> {
  return {
    'autoresearch.claude_code_observation_id': observation.id,
    'autoresearch.claude_code_session_id': observation.sessionId,
    'autoresearch.claude_code_event_type': observation.eventType,
    'autoresearch.claude_code_result': observation.success
      ? 'success'
      : 'failure',
    'autoresearch.claude_code_actual_regression': String(
      observation.actualRegression,
    ),
    'autoresearch.claude_code_heuristic_confidence': String(
      observation.heuristicConfidence,
    ),
    'autoresearch.claude_code_failure_tag_count': String(
      observation.failureTags.length,
    ),
    'autoresearch.claude_code_failure_tags': joinTelemetryList(
      observation.failureTags,
    ),
    'autoresearch.claude_code_exit_reason': observation.exitReason,
    'autoresearch.claude_code_summary': observation.summary,
    'autoresearch.claude_code_message_count':
      observation.messageCount?.toString(),
  }
}

function buildClaudeCodeTrendTelemetryFields(
  trend: ClaudeCodeTrendSnapshot | undefined,
): Record<string, string | undefined> {
  if (!trend) {
    return {}
  }
  return {
    'autoresearch.claude_code_total_observation_count': String(
      trend.totalObservationCount,
    ),
    'autoresearch.claude_code_total_session_count': String(
      trend.totalSessionCount,
    ),
    'autoresearch.claude_code_success_session_count': String(
      trend.successSessionCount,
    ),
    'autoresearch.claude_code_regression_session_count': String(
      trend.regressionSessionCount,
    ),
    'autoresearch.claude_code_high_confidence_regression_session_count': String(
      trend.highConfidenceRegressionSessionCount,
    ),
    'autoresearch.claude_code_current_window_size': String(
      trend.currentWindowSize,
    ),
    'autoresearch.claude_code_previous_window_size': String(
      trend.previousWindowSize,
    ),
    'autoresearch.claude_code_current_mistake_tags': joinTelemetryList(
      trend.currentMistakeTags,
    ),
    'autoresearch.claude_code_new_mistake_tags': joinTelemetryList(
      trend.newMistakeTags,
    ),
    'autoresearch.claude_code_fixed_mistake_tags': joinTelemetryList(
      trend.fixedMistakeTags,
    ),
    'autoresearch.claude_code_repeated_mistake_tags': joinTelemetryList(
      trend.repeatedMistakeTags,
    ),
    'autoresearch.claude_code_last_recorded_at': trend.lastRecordedAt,
  }
}

function buildControlPlaneSnapshotFields(
  state: RolloutState,
  corpus: BenchmarkCorpusVersion,
  challengeSet: ChallengeSet,
): Record<string, string | undefined> {
  const championExperiment = state.currentChampionCandidateId
    ? state.experiments.find(
        experiment => experiment.candidateId === state.currentChampionCandidateId,
      )
    : undefined

  return {
    ...buildStateTelemetryFields(state),
    ...buildCorpusTelemetryFields(corpus),
    ...buildChallengeSetTelemetryFields(challengeSet),
    ...(championExperiment
      ? {
          'autoresearch.current_champion_experiment_id':
            championExperiment.experimentId,
          'autoresearch.current_champion_status': championExperiment.status,
          'autoresearch.current_champion_lane': championExperiment.lane,
          ...buildScorecardTelemetryFields(championExperiment.scorecard),
          ...buildLearningTelemetryFields(championExperiment.learningDelta),
          ...buildPromotionTelemetryFields(championExperiment.promotionDecision),
        }
      : {}),
    ...buildClaudeCodeTrendTelemetryFields(state.lastClaudeCodeTrendSnapshot),
  }
}

function findExperiment(
  state: RolloutState,
  candidateId: string,
  experimentId?: string,
): ExperimentRun | undefined {
  return state.experiments.find(experiment =>
    experimentId
      ? experiment.experimentId === experimentId
      : experiment.candidateId === candidateId,
  )
}

function findLaneAssignment(
  state: RolloutState,
  candidateId: string,
): LaneAssignment | undefined {
  return state.laneAssignments.find(lane => lane.candidateId === candidateId)
}

function upsertExperiment(
  state: RolloutState,
  experiment: ExperimentRun,
): RolloutState {
  const experiments = state.experiments.filter(
    current => current.experimentId !== experiment.experimentId,
  )
  experiments.push(ExperimentRunSchema().parse(experiment))
  return {
    ...state,
    experiments,
  }
}

function upsertLaneAssignment(
  state: RolloutState,
  laneAssignment: LaneAssignment,
): RolloutState {
  const laneAssignments = state.laneAssignments.filter(
    current => current.candidateId !== laneAssignment.candidateId,
  )
  laneAssignments.push(laneAssignment)
  return {
    ...state,
    laneAssignments,
  }
}

function markAuditResolved(
  audit: BenchmarkAuditCase,
  resolvedAt: string,
): BenchmarkAuditCase {
  return BenchmarkAuditCaseSchema().parse({
    ...audit,
    status: 'resolved',
    resolvedAt,
  })
}

function openAudit(
  state: RolloutState,
  audit: Omit<BenchmarkAuditCase, 'id' | 'createdAt' | 'status'>,
): RolloutState {
  const duplicate = state.audits.find(existing => {
    if (existing.status !== 'open') {
      return false
    }
    return (
      existing.reason === audit.reason &&
      existing.candidateId === audit.candidateId &&
      existing.experimentId === audit.experimentId &&
      existing.fingerprint === audit.fingerprint &&
      existing.failureTags.join(',') === (audit.failureTags ?? []).join(',')
    )
  })
  if (duplicate) {
    return state
  }

  const createdAt = nowIso()
  const fullAudit = BenchmarkAuditCaseSchema().parse({
    ...audit,
    id: `audit-${createHashDigest(jsonStringify(audit)).slice(0, 12)}`,
    createdAt,
    status: 'open',
  })
  return {
    ...state,
    teacherFrozen: true,
    freezeReason: audit.summary,
    freezeOpenedAt: createdAt,
    audits: [...state.audits, fullAudit],
  }
}

type AutoresearchStateDiff = {
  openedAudits: BenchmarkAuditCase[]
  resolvedAudits: BenchmarkAuditCase[]
  laneTransitions: Array<{
    candidateId: string
    fromLane?: RolloutLane
    toLane: RolloutLane
  }>
  rollbacks: ExperimentRun[]
}

function diffState(
  before: RolloutState,
  after: RolloutState,
): AutoresearchStateDiff {
  const beforeAudits = new Map(before.audits.map(audit => [audit.id, audit]))
  const openedAudits = after.audits.filter(audit => {
    const previous = beforeAudits.get(audit.id)
    return audit.status === 'open' && previous?.status !== 'open'
  })
  const resolvedAudits = after.audits.filter(audit => {
    const previous = beforeAudits.get(audit.id)
    return audit.status === 'resolved' && previous?.status !== 'resolved'
  })

  const beforeLanes = new Map(
    before.laneAssignments.map(laneAssignment => [
      laneAssignment.candidateId,
      laneAssignment,
    ]),
  )
  const laneTransitions = after.laneAssignments
    .filter(laneAssignment => {
      const previous = beforeLanes.get(laneAssignment.candidateId)
      return previous?.lane !== laneAssignment.lane
    })
    .map(laneAssignment => ({
      candidateId: laneAssignment.candidateId,
      fromLane: beforeLanes.get(laneAssignment.candidateId)?.lane,
      toLane: laneAssignment.lane,
    }))

  const beforeExperiments = new Map(
    before.experiments.map(experiment => [experiment.experimentId, experiment]),
  )
  const rollbacks = after.experiments.filter(experiment => {
    const previous = beforeExperiments.get(experiment.experimentId)
    return (
      experiment.rollbackDecision != null &&
      previous?.rollbackDecision?.timestamp !==
        experiment.rollbackDecision.timestamp
    )
  })

  return {
    openedAudits,
    resolvedAudits,
    laneTransitions,
    rollbacks,
  }
}

function benchmarkInstabilityRate(
  corpus: BenchmarkCorpusVersion,
  admissionThresholds: AdmissionThresholds,
): number {
  const protectedCases = corpus.cases.filter(
    benchmarkCase =>
      benchmarkCase.tier === 'gold' || benchmarkCase.tier === 'hidden',
  )
  if (protectedCases.length === 0) {
    return 0
  }
  const unstableCount = protectedCases.filter(
    benchmarkCase =>
      benchmarkCase.stabilityScore < admissionThresholds.minimumStabilityScore,
  ).length
  return unstableCount / protectedCases.length
}

export function evaluateBenchmarkProposal(
  proposal: BenchmarkProposal,
  config: ResolvedAutoresearchControllerConfig | AutoresearchConfig,
): BenchmarkAdmissionDecision {
  const reasons: string[] = []
  if (!proposal.reproducibleOnReplay) {
    reasons.push('Proposal is not reproducible on replay.')
  }
  if (!proposal.objectivePassFail) {
    reasons.push('Proposal is missing objective pass/fail criteria.')
  }
  if (!proposal.case.redacted) {
    reasons.push('Proposal is missing redaction confirmation.')
  }
  if (!proposal.case.fixtureComplete) {
    reasons.push('Proposal is missing a complete fixture bundle.')
  }
  if (
    config.admissionThresholds.requireChallengeDiscrimination &&
    !proposal.case.discriminatesChallengeSet
  ) {
    reasons.push('Proposal does not discriminate against the challenge set.')
  }
  if (
    proposal.case.replayCount < config.admissionThresholds.minimumReplayCount
  ) {
    reasons.push('Proposal does not have enough replay confirmations.')
  }
  if (
    proposal.case.stabilityScore <
    config.admissionThresholds.minimumStabilityScore
  ) {
    reasons.push('Proposal stability score is below the admission threshold.')
  }

  if (
    proposal.objectivePassFail &&
    proposal.case.redacted &&
    proposal.case.fixtureComplete &&
    reasons.length === 0
  ) {
    return {
      tier: proposal.desiredTier,
      reasons: [],
    }
  }

  if (
    proposal.case.redacted &&
    proposal.case.fixtureComplete &&
    proposal.objectivePassFail
  ) {
    return {
      tier: 'quarantine',
      reasons,
    }
  }

  return {
    tier: 'proposed',
    reasons,
  }
}

function upsertBenchmarkCase(
  corpus: BenchmarkCorpusVersion,
  nextCase: BenchmarkCase,
): BenchmarkCorpusVersion {
  const existing = corpus.cases.find(benchmarkCase => {
    if (benchmarkCase.id === nextCase.id) {
      return true
    }
    return (
      benchmarkCase.fingerprint != null &&
      nextCase.fingerprint != null &&
      benchmarkCase.fingerprint === nextCase.fingerprint
    )
  })

  if (!existing) {
    return {
      ...corpus,
      cases: [...corpus.cases, nextCase],
    }
  }

  const keepExistingTier =
    getTierWeight(existing.tier) > getTierWeight(nextCase.tier)

  const merged: BenchmarkCase = {
    ...existing,
    ...nextCase,
    tier: keepExistingTier ? existing.tier : nextCase.tier,
    replayCount: Math.max(existing.replayCount, nextCase.replayCount),
    stabilityScore: Math.max(existing.stabilityScore, nextCase.stabilityScore),
    discriminatesChallengeSet:
      existing.discriminatesChallengeSet || nextCase.discriminatesChallengeSet,
    fixtureComplete: existing.fixtureComplete || nextCase.fixtureComplete,
    redacted: existing.redacted || nextCase.redacted,
  }

  return {
    ...corpus,
    cases: corpus.cases.map(benchmarkCase =>
      benchmarkCase.id === existing.id ? merged : benchmarkCase,
    ),
  }
}

function buildExperimentId(candidate: CandidateManifest): string {
  return `experiment-${candidate.id}-${createHashDigest(candidate.revision).slice(0, 8)}`
}

function matchesImmutableSurface(
  candidate: CandidateManifest,
  config: ResolvedAutoresearchControllerConfig | AutoresearchConfig,
): string | null {
  if (candidate.changedFiles.length === 0) {
    return null
  }

  for (const pattern of config.immutableCandidateGlobs) {
    const matcher = picomatch(pattern)
    const offending = candidate.changedFiles.find(filePath => matcher(filePath))
    if (offending) {
      return offending
    }
  }

  return null
}

function buildScorecard(
  caseResults: CandidateEvaluation['caseResults'],
  corpus: BenchmarkCorpusVersion,
  challengeSet: ChallengeSet,
  evaluation: CandidateEvaluation,
  config: ResolvedAutoresearchControllerConfig | AutoresearchConfig,
  championScorecard?: Scorecard,
): Scorecard {
  const reasons: string[] = []
  const benchmarkCases = corpus.cases.filter(
    benchmarkCase =>
      benchmarkCase.tier === 'gold' || benchmarkCase.tier === 'hidden',
  )
  const resultByCaseId = new Map(
    caseResults.map(caseResult => [caseResult.caseId, caseResult]),
  )

  const missingCaseIds = benchmarkCases
    .filter(benchmarkCase => !resultByCaseId.has(benchmarkCase.id))
    .map(benchmarkCase => benchmarkCase.id)
  if (missingCaseIds.length > 0) {
    reasons.push(
      `Missing benchmark results for cases: ${missingCaseIds.join(', ')}`,
    )
  }

  const benchmarkResults = benchmarkCases
    .map(benchmarkCase => resultByCaseId.get(benchmarkCase.id))
    .filter((result): result is NonNullable<typeof result> => result != null)

  const hiddenResults = benchmarkResults.filter(result => result.tier === 'hidden')
  const mustPassRegressionCount = benchmarkCases.filter(benchmarkCase => {
    if (!benchmarkCase.mustPass) {
      return false
    }
    const result = resultByCaseId.get(benchmarkCase.id)
    return !result?.passed
  }).length

  if (mustPassRegressionCount > 0) {
    reasons.push('One or more must-pass benchmark cases regressed.')
  }

  const taskSuccessRate = mean(
    benchmarkResults.map(result => (result.taskSuccess ? 1 : 0)),
  )
  const artifactValidityRate = mean(
    benchmarkResults.map(result => (result.artifactValid ? 1 : 0)),
  )
  const unsupportedClaimRate = mean(
    benchmarkResults.map(result => result.unsupportedClaims),
  )
  const verifierBypassRate = mean(
    benchmarkResults.map(result => result.verifierBypasses),
  )
  const phaseViolationRate = mean(
    benchmarkResults.map(result => result.phaseViolations),
  )
  const missingEvidenceCompletionRate = mean(
    benchmarkResults.map(result => result.missingEvidenceCompletions),
  )
  const medianTokenCost = median(
    benchmarkResults.map(result => result.tokenCost),
  )
  const medianRuntimeMs = median(
    benchmarkResults.map(result => result.runtimeMs),
  )
  const medianToolCallCount = median(
    benchmarkResults.map(result => result.toolCallCount),
  )
  const tokenCostDeltaPct =
    championScorecard == null || championScorecard.medianTokenCost === 0
      ? 0
      : ((medianTokenCost - championScorecard.medianTokenCost) /
          championScorecard.medianTokenCost) *
        100
  const runtimeDeltaPct =
    championScorecard == null || championScorecard.medianRuntimeMs === 0
      ? 0
      : ((medianRuntimeMs - championScorecard.medianRuntimeMs) /
          championScorecard.medianRuntimeMs) *
        100
  const hiddenHoldoutPass =
    hiddenResults.length === 0 || hiddenResults.every(result => result.passed)
  const hiddenHoldoutPredictiveAccuracy =
    hiddenResults.length === 0
      ? 1
      : mean(hiddenResults.map(result => (result.passed ? 1 : 0)))
  const challengeSetCatchRate =
    challengeSet.challengeCandidates.length === 0
      ? 1
      : mean(
          challengeSet.challengeCandidates.map(challengeCandidate => {
            const result = evaluation.challengeResults.find(
              challengeResult =>
                challengeResult.challengeId === challengeCandidate.id,
            )
            return result?.caught ? 1 : 0
          }),
        )

  if (!hiddenHoldoutPass) {
    reasons.push('Hidden holdout benchmarks did not all pass.')
  }

  if (
    unsupportedClaimRate > config.reliabilityFloors.unsupportedClaimRate
  ) {
    reasons.push('Unsupported claim rate breached the reliability floor.')
  }
  if (verifierBypassRate > config.reliabilityFloors.verifierBypassRate) {
    reasons.push('Verifier bypass rate breached the reliability floor.')
  }
  if (phaseViolationRate > config.reliabilityFloors.phaseViolationRate) {
    reasons.push('Phase violation rate breached the reliability floor.')
  }
  if (
    missingEvidenceCompletionRate >
    config.reliabilityFloors.missingEvidenceCompletionRate
  ) {
    reasons.push('Missing-evidence completion rate breached the reliability floor.')
  }
  if (
    challengeSetCatchRate < config.reliabilityFloors.challengeSetCatchRate
  ) {
    reasons.push('Challenge set catch rate breached the reliability floor.')
  }
  if (
    hiddenHoldoutPredictiveAccuracy <
    config.reliabilityFloors.hiddenHoldoutPredictiveAccuracy
  ) {
    reasons.push(
      'Hidden holdout predictive accuracy breached the reliability floor.',
    )
  }
  if (evaluation.dogfoodMissRate > config.reliabilityFloors.dogfoodMissRate) {
    reasons.push('Dogfood miss rate breached the reliability floor.')
  }
  if (
    evaluation.benchmarkStabilityRate <
    config.reliabilityFloors.benchmarkStabilityRate
  ) {
    reasons.push('Benchmark stability rate breached the reliability floor.')
  }

  if (championScorecard) {
    if (tokenCostDeltaPct > config.costCeilings.maxTokenCostDeltaPct) {
      reasons.push('Candidate exceeded the token-cost ceiling versus champion.')
    }
    if (runtimeDeltaPct > config.costCeilings.maxRuntimeDeltaPct) {
      reasons.push('Candidate exceeded the runtime ceiling versus champion.')
    }
  }

  return ScorecardSchema().parse({
    benchmarkCount: benchmarkResults.length,
    taskSuccessRate,
    artifactValidityRate,
    unsupportedClaimRate,
    verifierBypassRate,
    phaseViolationRate,
    missingEvidenceCompletionRate,
    medianTokenCost,
    medianRuntimeMs,
    medianToolCallCount,
    tokenCostDeltaPct,
    runtimeDeltaPct,
    hiddenHoldoutPass,
    hiddenHoldoutPredictiveAccuracy,
    mustPassRegressionCount,
    challengeSetCatchRate,
    benchmarkStabilityRate: evaluation.benchmarkStabilityRate,
    dogfoodMissRate: evaluation.dogfoodMissRate,
    eligibleForPromotion: reasons.length === 0,
    reasons,
  })
}

function resolveRecoverableAudits(
  state: RolloutState,
  corpus: BenchmarkCorpusVersion,
  config: ResolvedAutoresearchControllerConfig | AutoresearchConfig,
): RolloutState {
  const timestamp = nowIso()
  const audits = state.audits.map(audit => {
    if (audit.status !== 'open') {
      return audit
    }

    if (audit.reason === 'challenge_escape') {
      const recovered = state.experiments.some(
        experiment =>
          experiment.createdAt >= audit.createdAt &&
          experiment.scorecard.challengeSetCatchRate >=
            config.reliabilityFloors.challengeSetCatchRate,
      )
      if (recovered) {
        return markAuditResolved(audit, timestamp)
      }
    }

    if (audit.reason === 'dogfood_miss' && audit.fingerprint) {
      const recovered = corpus.cases.some(
        benchmarkCase =>
          benchmarkCase.fingerprint === audit.fingerprint &&
          (benchmarkCase.tier === 'gold' || benchmarkCase.tier === 'hidden'),
      )
      if (recovered) {
        return markAuditResolved(audit, timestamp)
      }
    }

    if (audit.reason === 'benchmark_instability') {
      const instability = benchmarkInstabilityRate(
        corpus,
        config.admissionThresholds,
      )
      if (instability <= config.teacherFreezeThresholds.benchmarkInstabilityRate) {
        return markAuditResolved(audit, timestamp)
      }
    }

    return audit
  })

  return {
    ...state,
    audits,
  }
}

function recomputeTeacherFreeze(
  state: RolloutState,
  corpus: BenchmarkCorpusVersion,
  config: ResolvedAutoresearchControllerConfig | AutoresearchConfig,
): RolloutState {
  let nextState = resolveRecoverableAudits(state, corpus, config)
  const instability = benchmarkInstabilityRate(
    corpus,
    config.admissionThresholds,
  )

  if (instability > config.teacherFreezeThresholds.benchmarkInstabilityRate) {
    nextState = openAudit(nextState, {
      reason: 'benchmark_instability',
      summary: 'Benchmark instability exceeded the configured freeze threshold.',
    })
  }

  const openAudits = nextState.audits.filter(audit => audit.status === 'open')
  if (openAudits.length === 0) {
    return {
      ...nextState,
      teacherFrozen: false,
      freezeReason: undefined,
      freezeOpenedAt: undefined,
    }
  }

  return {
    ...nextState,
    teacherFrozen: true,
    freezeReason: openAudits[0]?.summary ?? nextState.freezeReason,
    freezeOpenedAt: nextState.freezeOpenedAt ?? openAudits[0]?.createdAt,
  }
}

export function createTestAutoresearchState(
  repoRoot: string,
  corpusVersion: string = 'seed-corpus',
  challengeSetVersion: string = 'seed-challenges',
): RolloutState {
  return RolloutStateSchema().parse({
    repoRoot,
    corpusVersion,
    challengeSetVersion,
    teacherFrozen: false,
    processedCandidateIds: [],
    processedProposalIds: [],
    processedObservationIds: [],
    processedClaudeCodeObservationIds: [],
    experiments: [],
    laneAssignments: [],
    audits: [],
  })
}

/**
 * Score a completed candidate evaluation against the current rollout state.
 *
 * Builds a Scorecard from the CandidateEvaluation, computes the LearningDelta
 * against the current champion, makes a promotion decision (promote_shadow |
 * advance_lane | hold | reject | rollback | freeze_teacher), and returns the
 * updated RolloutState alongside the new ExperimentRun record.
 *
 * Called by runCycle() after runEvaluationCommand() returns a valid evaluation.
 */
export function scoreCandidateExperiment(
  state: RolloutState,
  corpus: BenchmarkCorpusVersion,
  challengeSet: ChallengeSet,
  config: ResolvedAutoresearchControllerConfig | AutoresearchConfig,
  candidate: CandidateManifest,
  evaluation: CandidateEvaluation,
  timestamp: string = nowIso(),
): { state: RolloutState; experiment: ExperimentRun } {
  const immutableFile = matchesImmutableSurface(candidate, config)
  const championExperiment = state.currentChampionCandidateId
    ? state.experiments.find(
        experiment =>
          experiment.candidateId === state.currentChampionCandidateId,
      )
    : undefined
  const baselineMistakeTags =
    championExperiment?.learningDelta.currentMistakeTags ?? []
  const currentMistakeTags = collectMistakeTagsFromEvaluation(corpus, evaluation)
  const learningDelta = buildLearningDelta(
    baselineMistakeTags,
    currentMistakeTags,
  )
  const scorecard = buildScorecard(
    evaluation.caseResults,
    corpus,
    challengeSet,
    evaluation,
    config,
    championExperiment?.scorecard,
  )

  let decision: PromotionDecision
  let nextState = state

  if (immutableFile) {
    const rejectedScorecard = ScorecardSchema().parse({
      ...scorecard,
      eligibleForPromotion: false,
      reasons: [
        ...scorecard.reasons,
        `Candidate touched immutable controller surface: ${immutableFile}`,
      ],
    })
    const rejectedExperiment = ExperimentRunSchema().parse({
      experimentId: buildExperimentId(candidate),
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      createdAt: timestamp,
      scoredAt: timestamp,
      status: 'rejected',
      scorecard: rejectedScorecard,
      learningDelta,
      caseResults: evaluation.caseResults,
      challengeResults: evaluation.challengeResults,
      promotionDecision: {
        decision: 'reject',
        reason: `Candidate touched immutable controller surface: ${immutableFile}`,
        timestamp,
      },
    })
    return {
      state: upsertExperiment(
        {
          ...state,
          processedCandidateIds: [...state.processedCandidateIds, candidate.id],
        },
        rejectedExperiment,
      ),
      experiment: rejectedExperiment,
    }
  }

  if (
    scorecard.challengeSetCatchRate <
    config.reliabilityFloors.challengeSetCatchRate
  ) {
    nextState = openAudit(nextState, {
      reason: 'challenge_escape',
      candidateId: candidate.id,
      experimentId: buildExperimentId(candidate),
      summary: 'A known-bad challenge candidate escaped the evaluator.',
      fingerprint: 'challenge-set',
      failureTags: learningDelta.currentMistakeTags,
    })
    decision = {
      decision: 'freeze_teacher',
      reason: 'Challenge set catch rate fell below the required floor.',
      timestamp,
    }
  } else if (nextState.teacherFrozen) {
    decision = {
      decision: 'hold',
      reason: nextState.freezeReason ?? 'Teacher is currently frozen.',
      timestamp,
    }
  } else if (!scorecard.eligibleForPromotion) {
    decision = {
      decision: 'reject',
      reason: scorecard.reasons[0] ?? 'Candidate did not meet promotion gates.',
      timestamp,
    }
  } else {
    const winsOverChampion =
      !championExperiment ||
      compareScorecards(scorecard, championExperiment.scorecard) > 0

    decision = winsOverChampion
      ? {
          decision: 'promote_shadow',
          reason: 'Candidate cleared gates and beat the current champion.',
          targetLane: 'shadow',
          timestamp,
        }
      : {
          decision: 'hold',
          reason: 'Candidate cleared gates but did not beat the current champion.',
          timestamp,
        }
  }

  let experiment = ExperimentRunSchema().parse({
    experimentId: buildExperimentId(candidate),
    candidateId: candidate.id,
    candidateRevision: candidate.revision,
    createdAt: timestamp,
    scoredAt: timestamp,
    status:
      decision.decision === 'promote_shadow'
        ? 'shadow'
        : decision.decision === 'reject' || decision.decision === 'freeze_teacher'
          ? 'rejected'
          : 'scored',
    lane: decision.targetLane,
    scorecard,
    learningDelta,
    caseResults: evaluation.caseResults,
    challengeResults: evaluation.challengeResults,
    promotionDecision: decision,
  })

  nextState = {
    ...nextState,
    processedCandidateIds: [...nextState.processedCandidateIds, candidate.id],
  }

  if (decision.decision === 'promote_shadow') {
    nextState = {
      ...nextState,
      previousChampionCandidateId: nextState.currentChampionCandidateId,
      currentChampionCandidateId: candidate.id,
    }
    nextState = upsertLaneAssignment(
      nextState,
      {
        candidateId: candidate.id,
        lane: 'shadow',
        successCount: 0,
        regressionCount: 0,
        rolloutChampion: false,
        lastTransitionAt: timestamp,
      },
    )
  }

  nextState = upsertExperiment(nextState, experiment)
  nextState = recomputeTeacherFreeze(nextState, corpus, config)
  experiment =
    findExperiment(nextState, candidate.id, experiment.experimentId) ?? experiment

  return {
    state: nextState,
    experiment,
  }
}

export function applyDogfoodObservation(
  state: RolloutState,
  corpus: BenchmarkCorpusVersion,
  config: ResolvedAutoresearchControllerConfig | AutoresearchConfig,
  observation: DogfoodObservation,
  timestamp: string = nowIso(),
): RolloutState {
  const experiment = findExperiment(
    state,
    observation.candidateId,
    observation.experimentId,
  )
  if (!experiment || state.processedObservationIds.includes(observation.id)) {
    return state
  }

  let nextState: RolloutState = {
    ...state,
    processedObservationIds: [...state.processedObservationIds, observation.id],
  }
  const existingLane =
    findLaneAssignment(nextState, observation.candidateId) ??
    ({
      candidateId: observation.candidateId,
      lane: observation.lane,
      successCount: 0,
      regressionCount: 0,
      rolloutChampion: false,
      lastTransitionAt: timestamp,
    } satisfies LaneAssignment)

  let updatedLane: LaneAssignment = {
    ...existingLane,
    successCount: existingLane.successCount + (observation.success ? 1 : 0),
    regressionCount:
      existingLane.regressionCount + (observation.actualRegression ? 1 : 0),
  }

  const sampleCount = updatedLane.successCount + updatedLane.regressionCount
  const regressionRate =
    sampleCount === 0 ? 0 : updatedLane.regressionCount / sampleCount

  let nextExperiment: ExperimentRun = {
    ...experiment,
    lane: updatedLane.lane,
    learningDelta: mergeLearningDeltaWithObservation(
      experiment.learningDelta,
      observation.actualRegression ? observation.failureTags : [],
    ),
  }

  if (observation.actualRegression) {
    nextExperiment = {
      ...nextExperiment,
      status: 'rolled_back',
      rollbackDecision: {
        candidateId: observation.candidateId,
        fromLane: updatedLane.lane,
        reason: observation.summary ?? 'Regression detected in rollout lane.',
        timestamp,
      },
      promotionDecision: {
        decision: observation.predictedRegression ? 'rollback' : 'freeze_teacher',
        reason:
          observation.summary ??
          (observation.predictedRegression
            ? 'Regression threshold exceeded.'
            : 'Dogfood regression was not predicted by the benchmark.'),
        timestamp,
      },
    }
    updatedLane = {
      ...updatedLane,
      lastTransitionAt: timestamp,
    }
    if (!observation.predictedRegression) {
      nextState = openAudit(nextState, {
        reason: 'dogfood_miss',
        candidateId: observation.candidateId,
        experimentId: experiment.experimentId,
        transcriptPath: observation.transcriptPath,
        fingerprint: observation.fingerprint,
        failureTags: observation.failureTags,
        summary:
          observation.summary ??
          'Dogfood observed a regression that the benchmark suite did not predict.',
      })
    }
    if (regressionRate > config.rolloutThresholds.maxRegressionRate) {
      nextState = {
        ...nextState,
        currentChampionCandidateId:
          nextState.currentChampionCandidateId === observation.candidateId
            ? nextState.previousChampionCandidateId
            : nextState.currentChampionCandidateId,
      }
    }
  } else if (observation.success) {
    let nextLane: RolloutLane | null = null
    if (
      updatedLane.lane === 'shadow' &&
      updatedLane.successCount >= config.rolloutThresholds.shadowSuccessCount
    ) {
      nextLane = 'dogfood'
    } else if (
      updatedLane.lane === 'dogfood' &&
      updatedLane.successCount >= config.rolloutThresholds.dogfoodSuccessCount
    ) {
      nextLane = 'canary'
    }

    if (nextLane) {
      updatedLane = {
        ...updatedLane,
        lane: nextLane,
        successCount: 0,
        regressionCount: 0,
        lastTransitionAt: timestamp,
        rolloutChampion:
          nextLane === 'canary' &&
          config.rolloutThresholds.canarySuccessCount <= 1,
      }
      nextExperiment = {
        ...nextExperiment,
        status: nextLane,
        lane: nextLane,
        promotionDecision: {
          decision: 'advance_lane',
          targetLane: nextLane,
          reason: `Candidate cleared ${observation.lane} rollout thresholds.`,
          timestamp,
        },
      }
      nextState = {
        ...nextState,
        currentChampionCandidateId: observation.candidateId,
      }
    } else if (
      updatedLane.lane === 'canary' &&
      updatedLane.successCount >= config.rolloutThresholds.canarySuccessCount
    ) {
      updatedLane = {
        ...updatedLane,
        rolloutChampion: true,
      }
      nextExperiment = {
        ...nextExperiment,
        status: 'canary',
      }
    }
  }

  nextState = upsertLaneAssignment(nextState, updatedLane)
  nextState = upsertExperiment(nextState, nextExperiment)
  return recomputeTeacherFreeze(nextState, corpus, config)
}

// Set by runCycle() for the duration of each cycle so all emitted events share
// a common trace.trace_id, making them browsable as a waterfall in Honeycomb.
let _activeCycleTraceId: string | undefined

async function emitTelemetry(
  config: ResolvedAutoresearchConfig,
  eventName: string,
  metadata: Record<string, string | undefined>,
): Promise<void> {
  if (!config.enabled || !config.emitTelemetry) {
    return
  }
  const traceFields: Record<string, string> = _activeCycleTraceId
    ? {
        'trace.trace_id': _activeCycleTraceId,
        'trace.span_id': randomUUID().replace(/-/g, ''),
        'trace.parent_id': _activeCycleTraceId,
      }
    : {}
  await logOTelEvent(eventName, { ...traceFields, ...metadata })
}

async function emitStateDiffTelemetry(
  config: ResolvedAutoresearchConfig,
  before: RolloutState,
  after: RolloutState,
): Promise<void> {
  if (!config.enabled || !config.emitTelemetry) {
    return
  }

  const diff = diffState(before, after)

  for (const audit of diff.openedAudits) {
    await emitTelemetry(config, 'autoresearch_teacher_audit_opened', {
      ...buildStateTelemetryFields(after),
      ...buildSplitterTelemetryFields(config.controllerConfig.splitter, {
        workstream: 'promotion_controller',
        candidateId: audit.candidateId,
        experimentId: audit.experimentId,
      }),
      'autoresearch.repo': config.repoRoot,
      'autoresearch.audit_id': audit.id,
      'autoresearch.audit_reason': audit.reason,
      'autoresearch.candidate_id': audit.candidateId,
      'autoresearch.experiment_id': audit.experimentId,
      'autoresearch.failure_tags': joinTelemetryList(audit.failureTags),
    })
  }

  for (const audit of diff.resolvedAudits) {
    await emitTelemetry(config, 'autoresearch_teacher_audit_resolved', {
      ...buildStateTelemetryFields(after),
      ...buildSplitterTelemetryFields(config.controllerConfig.splitter, {
        workstream: 'promotion_controller',
        candidateId: audit.candidateId,
        experimentId: audit.experimentId,
      }),
      'autoresearch.repo': config.repoRoot,
      'autoresearch.audit_id': audit.id,
      'autoresearch.audit_reason': audit.reason,
      'autoresearch.candidate_id': audit.candidateId,
      'autoresearch.experiment_id': audit.experimentId,
      'autoresearch.failure_tags': joinTelemetryList(audit.failureTags),
    })
  }

  for (const transition of diff.laneTransitions) {
    const experiment = after.experiments.find(
      currentExperiment => currentExperiment.candidateId === transition.candidateId,
    )
    await emitTelemetry(config, 'autoresearch_lane_transition', {
      ...buildStateTelemetryFields(after),
      ...buildSplitterTelemetryFields(config.controllerConfig.splitter, {
        workstream: 'promotion_controller',
        candidateId: transition.candidateId,
        experimentId: experiment?.experimentId,
      }),
      'autoresearch.repo': config.repoRoot,
      'autoresearch.candidate_id': transition.candidateId,
      'autoresearch.from_lane': transition.fromLane,
      'autoresearch.to_lane': transition.toLane,
      ...buildPromotionTelemetryFields(experiment?.promotionDecision),
    })
  }

  for (const experiment of diff.rollbacks) {
    await emitTelemetry(config, 'autoresearch_rollback_triggered', {
      ...buildStateTelemetryFields(after),
      ...buildScorecardTelemetryFields(experiment.scorecard),
      ...buildPromotionTelemetryFields(experiment.promotionDecision),
      'autoresearch.repo': config.repoRoot,
      'autoresearch.candidate_id': experiment.candidateId,
      'autoresearch.experiment_id': experiment.experimentId,
      'autoresearch.rollback_reason': experiment.rollbackDecision?.reason,
      'autoresearch.rollback_lane': experiment.rollbackDecision?.fromLane,
      ...buildSplitterTelemetryFields(config.controllerConfig.splitter, {
        workstream: 'promotion_controller',
        candidateId: experiment.candidateId,
        experimentId: experiment.experimentId,
      }),
      ...buildLearningTelemetryFields(experiment.learningDelta),
    })
  }
}

async function loadSeedCorpus(
  controllerConfig: ResolvedAutoresearchControllerConfig,
): Promise<BenchmarkCorpusVersion> {
  const seedCorpus = await readJsonFile(controllerConfig.seedCorpusPath, value =>
    BenchmarkCorpusVersionSchema().parse(value),
  )
  if (!seedCorpus) {
    return BenchmarkCorpusVersionSchema().parse({
      version: 'empty',
      cases: [],
    })
  }
  return seedCorpus
}

async function loadSeedChallengeSet(
  controllerConfig: ResolvedAutoresearchControllerConfig,
): Promise<ChallengeSet> {
  const challengeSet = await readJsonFile(
    controllerConfig.seedChallengeSetPath,
    value => ChallengeSetSchema().parse(value),
  )
  if (!challengeSet) {
    return ChallengeSetSchema().parse({
      version: 'empty',
      challengeCandidates: [],
    })
  }
  return challengeSet
}

async function ensureBootstrapFiles(
  config: Extract<ResolvedAutoresearchConfig, { enabled: true }>,
): Promise<{
  state: RolloutState
  corpus: BenchmarkCorpusVersion
  challengeSet: ChallengeSet
}> {
  const managedPaths = getManagedPaths(config.statePath)

  await mkdir(managedPaths.stateDir, { recursive: true })
  await mkdir(managedPaths.experimentsDir, { recursive: true })
  await mkdir(managedPaths.auditsDir, { recursive: true })
  await mkdir(managedPaths.candidateDir, { recursive: true })
  await mkdir(managedPaths.proposalDir, { recursive: true })
  await mkdir(managedPaths.observationDir, { recursive: true })
  await mkdir(managedPaths.claudeCodeSessionDir, { recursive: true })

  let corpus = await readJsonFile(managedPaths.corpusFile, value =>
    BenchmarkCorpusVersionSchema().parse(value),
  )
  if (!corpus) {
    corpus = await loadSeedCorpus(config.controllerConfig)
    await writeJsonFile(managedPaths.corpusFile, corpus)
  }

  let challengeSet = await readJsonFile(managedPaths.challengeSetFile, value =>
    ChallengeSetSchema().parse(value),
  )
  if (!challengeSet) {
    challengeSet = await loadSeedChallengeSet(config.controllerConfig)
    await writeJsonFile(managedPaths.challengeSetFile, challengeSet)
  }

  let state = await readJsonFile(managedPaths.stateFile, value =>
    RolloutStateSchema().parse(value),
  )
  if (!state) {
    state = createTestAutoresearchState(
      config.repoRoot,
      corpus.version,
      challengeSet.version,
    )
    await writeJsonFile(managedPaths.stateFile, state)
  }

  return {
    state,
    corpus,
    challengeSet,
  }
}

async function collectJsonFiles<T>(
  directoryPath: string,
  parse: (value: unknown) => T,
): Promise<T[]> {
  let entries: string[]
  try {
    entries = await readdir(directoryPath)
  } catch {
    return []
  }

  const files = entries
    .filter(entry => entry.endsWith('.json'))
    .sort()
    .map(entry => path.join(directoryPath, entry))

  const results: T[] = []
  for (const filePath of files) {
    const parsed = await readJsonFile(filePath, parse)
    if (parsed) {
      results.push(parsed)
    }
  }
  return results
}

async function runMutationCommand(
  command: string,
  emitMode: 'side_effect' | 'stdout_manifest',
  cwd: string,
  env: Record<string, string>,
): Promise<CandidateManifest[]> {
  const result = await execa(command, {
    cwd,
    env,
    shell: true,
    reject: false,
  })

  if (result.exitCode !== 0) {
    logForDebugging(
      `[autoresearch] mutation source command failed (${result.exitCode}): ${command}`,
      { level: 'warn' },
    )
    return []
  }

  if (emitMode !== 'stdout_manifest' || !result.stdout.trim()) {
    return []
  }

  const parsed = safeParseJSON(result.stdout, false)
  if (parsed == null) {
    return []
  }
  if (Array.isArray(parsed)) {
    return parsed.map(value => CandidateManifestSchema().parse(value))
  }
  return [CandidateManifestSchema().parse(parsed)]
}

/**
 * Shell out to config.controllerConfig.evaluationCommand to score one candidate.
 *
 * Writes the candidate manifest to <stateDir>/candidates/<id>.json, then
 * invokes the evaluation command with these env vars:
 *   AUTORESEARCH_REPO_ROOT        — absolute repo root
 *   AUTORESEARCH_STATE_DIR        — autoresearch state directory
 *   AUTORESEARCH_CANDIDATE_MANIFEST — path to the written manifest JSON
 *   AUTORESEARCH_OUTPUT_PATH      — path where the command MUST write CandidateEvaluation JSON
 *   AUTORESEARCH_CORPUS_PATH      — path to the loaded seed corpus JSON
 *   AUTORESEARCH_CHALLENGE_SET_PATH — path to the loaded challenge set JSON
 *
 * Returns null if evaluationCommand is unset, the command exits non-zero, or the
 * output fails CandidateEvaluationSchema validation.
 */
async function runEvaluationCommand(
  config: Extract<ResolvedAutoresearchConfig, { enabled: true }>,
  candidate: CandidateManifest,
  managedPaths: ManagedPaths,
): Promise<CandidateEvaluation | null> {
  if (!config.controllerConfig.evaluationCommand) {
    return null
  }

  const manifestPath = path.join(managedPaths.candidateDir, `${candidate.id}.json`)
  const outputPath = path.join(managedPaths.experimentsDir, `${candidate.id}.evaluation.json`)
  await writeJsonFile(manifestPath, candidate)

  const result = await execa(config.controllerConfig.evaluationCommand, {
    cwd: candidate.workspacePath,
    shell: true,
    reject: false,
    env: {
      AUTORESEARCH_REPO_ROOT: config.repoRoot,
      AUTORESEARCH_STATE_DIR: managedPaths.stateDir,
      AUTORESEARCH_CANDIDATE_MANIFEST: manifestPath,
      AUTORESEARCH_OUTPUT_PATH: outputPath,
      AUTORESEARCH_CORPUS_PATH: managedPaths.corpusFile,
      AUTORESEARCH_CHALLENGE_SET_PATH: managedPaths.challengeSetFile,
    },
  })

  if (result.exitCode !== 0) {
    logForDebugging(
      `[autoresearch] evaluation command failed (${result.exitCode}) for candidate ${candidate.id}`,
      { level: 'warn' },
    )
    return null
  }

  const output = await readJsonFile(outputPath, value =>
    CandidateEvaluationSchema().parse(value),
  )
  if (output) {
    return output
  }

  const stdout = safeParseJSON(result.stdout, false)
  if (stdout == null) {
    return null
  }
  return CandidateEvaluationSchema().parse(stdout)
}

export async function resolveAutoresearchConfig(
  repoRoot: string,
  settings: AutoresearchSettings | undefined,
): Promise<ResolvedAutoresearchConfig> {
  if (!settings?.enabled) {
    return { enabled: false }
  }

  if (!settings.configPath) {
    return {
      enabled: false,
      invalidReason: 'Autoresearch requires configPath when enabled.',
    }
  }

  const configPath = path.resolve(repoRoot, settings.configPath)
  const rawConfig = await readJsonFile(configPath, value =>
    AutoresearchConfigSchema().parse(value),
  )
  if (!rawConfig) {
    return {
      enabled: false,
      invalidReason: `Failed to load autoresearch config from ${configPath}.`,
    }
  }

  const configDir = path.dirname(configPath)
  return {
    enabled: true,
    repoRoot,
    statePath: settings.experimentStatePath
      ? path.resolve(repoRoot, settings.experimentStatePath)
      : getDefaultStatePath(repoRoot),
    schedulerCadenceMs:
      settings.schedulerCadenceMs ?? DEFAULT_SCHEDULER_CADENCE_MS,
    emitTelemetry: settings.emitTelemetry !== false,
    controllerConfig: {
      ...rawConfig,
      configPath,
      configDir,
      splitter: resolveAutoresearchSplitterConfig(rawConfig.splitter),
      seedCorpusPath: path.resolve(configDir, rawConfig.seedCorpusPath),
      seedChallengeSetPath: path.resolve(
        configDir,
        rawConfig.seedChallengeSetPath,
      ),
      mutationSources: rawConfig.mutationSources.map(source =>
        source.type === 'manifest_directory'
          ? {
              ...source,
              path: path.resolve(configDir, source.path),
            }
          : source,
      ),
    },
  }
}

export class AutoresearchController {
  private readonly config: Extract<ResolvedAutoresearchConfig, { enabled: true }>
  private intervalId: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(config: Extract<ResolvedAutoresearchConfig, { enabled: true }>) {
    this.config = config
  }

  async start(): Promise<void> {
    await this.runCycle()
    if (this.intervalId) {
      return
    }
    this.intervalId = setInterval(() => {
      void this.runCycle()
    }, this.config.schedulerCadenceMs)
    this.intervalId.unref?.()
  }

  /**
   * Main controller loop — called on a scheduler cadence or manually.
   *
   * Sequence per cycle:
   *   1. Load rollout state, corpus, and challenge set from disk.
   *   2. Scan mutationSources for new CandidateManifest JSON files.
   *   3. For each unprocessed candidate: call runEvaluationCommand(), then
   *      scoreCandidateExperiment(), then persist the updated RolloutState.
   *   4. Emit autoresearch_cycle_completed (or autoresearch_cycle_failed on throw).
   *
   * Guards against concurrent execution (this.running flag).
   * The cycle is a no-op if evaluationCommand is not configured.
   */
  async runCycle(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    _activeCycleTraceId = randomUUID()

    const managedPaths = getManagedPaths(this.config.statePath)
    const cycleStartMs = Date.now()
    try {
      let { state, corpus, challengeSet } = await ensureBootstrapFiles(this.config)
      await emitTelemetry(this.config, 'autoresearch_splitter_topology_loaded', {
        'autoresearch.repo': this.config.repoRoot,
        ...buildSplitterTopologyTelemetryFields(
          this.config.controllerConfig.splitter,
        ),
        ...buildStateTelemetryFields(state),
        ...buildCorpusTelemetryFields(corpus),
        ...buildChallengeSetTelemetryFields(challengeSet),
      })

      for (const source of this.config.controllerConfig.mutationSources) {
        if (source.type !== 'command') {
          continue
        }
        const candidates = await runMutationCommand(
          source.command,
          source.emitMode ?? 'side_effect',
          this.config.repoRoot,
          {
            AUTORESEARCH_REPO_ROOT: this.config.repoRoot,
            AUTORESEARCH_STATE_DIR: managedPaths.stateDir,
            AUTORESEARCH_CANDIDATE_DIR: managedPaths.candidateDir,
          },
        )
        for (const candidate of candidates) {
          await writeJsonFile(
            path.join(managedPaths.candidateDir, `${candidate.id}.json`),
            candidate,
          )
        }
      }

      const candidateFiles = new Set<string>([
        managedPaths.candidateDir,
        ...this.config.controllerConfig.mutationSources
          .filter(source => source.type === 'manifest_directory')
          .map(source => source.path),
      ])
      const collectedCandidates: CandidateManifest[] = []
      for (const directoryPath of candidateFiles) {
        const manifests = await collectJsonFiles(directoryPath, value =>
          CandidateManifestSchema().parse(value),
        )
        collectedCandidates.push(...manifests)
      }

      const proposals = await collectJsonFiles(managedPaths.proposalDir, value =>
        BenchmarkProposalSchema().parse(value),
      )
      for (const proposal of proposals) {
        if (state.processedProposalIds.includes(proposal.case.id)) {
          continue
        }
        const admission = evaluateBenchmarkProposal(
          proposal,
          this.config.controllerConfig,
        )
        const admittedCase = {
          ...proposal.case,
          tier: admission.tier,
          fingerprint: proposal.fingerprint ?? proposal.case.fingerprint,
          provenance:
            admission.tier === 'gold' || admission.tier === 'hidden'
              ? 'audit'
              : 'proposal',
        } satisfies BenchmarkCase
        corpus = upsertBenchmarkCase(corpus, admittedCase)
        state = {
          ...state,
          processedProposalIds: [...state.processedProposalIds, proposal.case.id],
        }
        await emitTelemetry(this.config, 'autoresearch_benchmark_admitted', {
          ...buildStateTelemetryFields(state),
          ...buildCorpusTelemetryFields(corpus),
          ...buildChallengeSetTelemetryFields(challengeSet),
          ...buildSplitterTelemetryFields(this.config.controllerConfig.splitter, {
            workstream: 'benchmark_admission',
            caseId: proposal.case.id,
          }),
          'autoresearch.repo': this.config.repoRoot,
          'autoresearch.case_id': proposal.case.id,
          'autoresearch.benchmark_tier': admittedCase.tier,
          'autoresearch.desired_tier': proposal.desiredTier,
          'autoresearch.failure_tags': joinTelemetryList(
            admittedCase.canonicalFailureTags,
          ),
          'autoresearch.admission_reason_count': String(admission.reasons.length),
          'autoresearch.admission_reasons': joinTelemetryList(admission.reasons),
          'autoresearch.case_replay_count': String(admittedCase.replayCount),
          'autoresearch.case_stability_score': String(
            admittedCase.stabilityScore,
          ),
          'autoresearch.case_discriminates_challenge_set': String(
            admittedCase.discriminatesChallengeSet,
          ),
          'autoresearch.case_fixture_complete': String(
            admittedCase.fixtureComplete,
          ),
          'autoresearch.case_redacted': String(admittedCase.redacted),
          'autoresearch.case_provenance': admittedCase.provenance,
          'autoresearch.case_must_pass': String(admittedCase.mustPass),
        })
      }

      const observations = await collectJsonFiles(
        managedPaths.observationDir,
        value => DogfoodObservationSchema().parse(value),
      )
      for (const observation of observations) {
        const previousState = state
        state = applyDogfoodObservation(
          state,
          corpus,
          this.config.controllerConfig,
          observation,
        )
        await emitTelemetry(this.config, 'autoresearch_dogfood_observation', {
          ...buildStateTelemetryFields(state),
          ...buildCorpusTelemetryFields(corpus),
          ...buildChallengeSetTelemetryFields(challengeSet),
          ...buildObservationTelemetryFields(observation),
          ...buildSplitterTelemetryFields(this.config.controllerConfig.splitter, {
            workstream: 'dogfood_observation',
            observationId: observation.id,
            candidateId: observation.candidateId,
            experimentId: observation.experimentId,
          }),
          'autoresearch.repo': this.config.repoRoot,
          'autoresearch.candidate_id': observation.candidateId,
          'autoresearch.experiment_id': observation.experimentId,
        })
        await emitStateDiffTelemetry(this.config, previousState, state)
      }

      const claudeCodeObservations = await collectJsonFiles(
        managedPaths.claudeCodeSessionDir,
        value => ClaudeCodeSessionObservationSchema().parse(value),
      )
      for (const observation of claudeCodeObservations) {
        if (
          state.processedClaudeCodeObservationIds.includes(observation.id)
        ) {
          continue
        }
        state = {
          ...state,
          processedClaudeCodeObservationIds: [
            ...state.processedClaudeCodeObservationIds,
            observation.id,
          ],
        }
        await emitTelemetry(
          this.config,
          'autoresearch_claude_code_session_observed',
          {
            ...buildStateTelemetryFields(state),
            ...buildCorpusTelemetryFields(corpus),
            ...buildChallengeSetTelemetryFields(challengeSet),
            ...buildClaudeCodeSessionTelemetryFields(observation),
            ...buildSplitterTelemetryFields(
              this.config.controllerConfig.splitter,
              {
                workstream: 'dogfood_observation',
                observationId: observation.id,
              },
            ),
            'autoresearch.repo': this.config.repoRoot,
          },
        )
      }

      if (claudeCodeObservations.length > 0) {
        const trendSnapshot =
          summarizeClaudeCodeSessionObservations(claudeCodeObservations)
        state = {
          ...state,
          lastClaudeCodeTrendSnapshot: trendSnapshot,
        }
        await emitTelemetry(
          this.config,
          'autoresearch_claude_code_trend_snapshot',
          {
            ...buildStateTelemetryFields(state),
            ...buildCorpusTelemetryFields(corpus),
            ...buildChallengeSetTelemetryFields(challengeSet),
            ...buildClaudeCodeTrendTelemetryFields(trendSnapshot),
            ...buildSplitterTopologyTelemetryFields(
              this.config.controllerConfig.splitter,
            ),
            'autoresearch.repo': this.config.repoRoot,
          },
        )
      }

      for (const candidate of collectedCandidates) {
        if (state.processedCandidateIds.includes(candidate.id)) {
          continue
        }
        const evaluation =
          candidate.evaluation ??
          (await runEvaluationCommand(this.config, candidate, managedPaths))
        if (!evaluation) {
          const experiment = ExperimentRunSchema().parse({
            experimentId: buildExperimentId(candidate),
            candidateId: candidate.id,
            candidateRevision: candidate.revision,
            createdAt: nowIso(),
            scoredAt: nowIso(),
            status: 'rejected',
            scorecard: ScorecardSchema().parse({
              benchmarkCount: 0,
              taskSuccessRate: 0,
              artifactValidityRate: 0,
              unsupportedClaimRate: 0,
              verifierBypassRate: 0,
              phaseViolationRate: 0,
              missingEvidenceCompletionRate: 0,
              medianTokenCost: 0,
              medianRuntimeMs: 0,
              medianToolCallCount: 0,
              tokenCostDeltaPct: 0,
              runtimeDeltaPct: 0,
              hiddenHoldoutPass: false,
              hiddenHoldoutPredictiveAccuracy: 0,
              mustPassRegressionCount: 0,
              challengeSetCatchRate: 0,
              benchmarkStabilityRate: 0,
              dogfoodMissRate: 0,
              eligibleForPromotion: false,
              reasons: ['Candidate is missing evaluation results.'],
            }),
            learningDelta: buildLearningDelta([], []),
            caseResults: [],
            challengeResults: [],
            promotionDecision: {
              decision: 'reject',
              reason: 'Candidate is missing evaluation results.',
              timestamp: nowIso(),
            },
          })
          state = upsertExperiment(
            {
              ...state,
              processedCandidateIds: [...state.processedCandidateIds, candidate.id],
            },
            experiment,
          )
          await writeJsonFile(
            path.join(managedPaths.experimentsDir, `${experiment.experimentId}.json`),
            experiment,
          )
          await emitTelemetry(this.config, 'autoresearch_experiment_scored', {
            ...buildStateTelemetryFields(state),
            ...buildCorpusTelemetryFields(corpus),
            ...buildChallengeSetTelemetryFields(challengeSet),
            ...buildCandidateTelemetryFields(candidate),
            ...buildScorecardTelemetryFields(experiment.scorecard),
            ...buildLearningTelemetryFields(experiment.learningDelta),
            ...buildPromotionTelemetryFields(experiment.promotionDecision),
            ...buildSplitterTelemetryFields(this.config.controllerConfig.splitter, {
              workstream: 'promotion_controller',
              candidateId: experiment.candidateId,
              experimentId: experiment.experimentId,
            }),
            'autoresearch.repo': this.config.repoRoot,
            'autoresearch.candidate_id': experiment.candidateId,
            'autoresearch.experiment_id': experiment.experimentId,
            'autoresearch.result': experiment.status,
            'autoresearch.lane': experiment.lane,
          })
          continue
        }

        const scored = scoreCandidateExperiment(
          state,
          corpus,
          challengeSet,
          this.config.controllerConfig,
          candidate,
          evaluation,
        )
        for (const caseResult of scored.experiment.caseResults) {
          const benchmarkCase = corpus.cases.find(
            currentCase => currentCase.id === caseResult.caseId,
          )
          await emitTelemetry(this.config, 'autoresearch_case_result', {
            ...buildStateTelemetryFields(scored.state),
            ...buildCorpusTelemetryFields(corpus),
            ...buildChallengeSetTelemetryFields(challengeSet),
            ...buildCaseResultTelemetryFields(benchmarkCase, caseResult),
            ...buildSplitterTelemetryFields(this.config.controllerConfig.splitter, {
              workstream: 'candidate_eval',
              candidateId: scored.experiment.candidateId,
              caseId: caseResult.caseId,
              experimentId: scored.experiment.experimentId,
            }),
            'autoresearch.repo': this.config.repoRoot,
            'autoresearch.candidate_id': scored.experiment.candidateId,
            'autoresearch.experiment_id': scored.experiment.experimentId,
            'autoresearch.case_id': caseResult.caseId,
            'autoresearch.benchmark_tier': caseResult.tier,
          })
        }
        for (const challengeResult of scored.experiment.challengeResults) {
          await emitTelemetry(this.config, 'autoresearch_challenge_result', {
            ...buildStateTelemetryFields(scored.state),
            ...buildCorpusTelemetryFields(corpus),
            ...buildChallengeSetTelemetryFields(challengeSet),
            ...buildChallengeResultTelemetryFields(challengeSet, challengeResult),
            ...buildSplitterTelemetryFields(this.config.controllerConfig.splitter, {
              workstream: 'candidate_eval',
              candidateId: scored.experiment.candidateId,
              challengeId: challengeResult.challengeId,
              experimentId: scored.experiment.experimentId,
            }),
            'autoresearch.repo': this.config.repoRoot,
            'autoresearch.candidate_id': scored.experiment.candidateId,
            'autoresearch.experiment_id': scored.experiment.experimentId,
            'autoresearch.challenge_id': challengeResult.challengeId,
          })
        }
        const previousState = state
        state = scored.state
        await writeJsonFile(
          path.join(managedPaths.experimentsDir, `${scored.experiment.experimentId}.json`),
          scored.experiment,
        )
        await emitTelemetry(this.config, 'autoresearch_experiment_scored', {
          ...buildStateTelemetryFields(state),
          ...buildCorpusTelemetryFields(corpus),
          ...buildChallengeSetTelemetryFields(challengeSet),
          ...buildCandidateTelemetryFields(candidate),
          ...buildScorecardTelemetryFields(scored.experiment.scorecard),
          ...buildLearningTelemetryFields(scored.experiment.learningDelta),
          ...buildPromotionTelemetryFields(scored.experiment.promotionDecision),
          ...buildSplitterTelemetryFields(this.config.controllerConfig.splitter, {
            workstream: 'promotion_controller',
            candidateId: scored.experiment.candidateId,
            experimentId: scored.experiment.experimentId,
          }),
          'autoresearch.repo': this.config.repoRoot,
          'autoresearch.candidate_id': scored.experiment.candidateId,
          'autoresearch.experiment_id': scored.experiment.experimentId,
          'autoresearch.result': scored.experiment.status,
          'autoresearch.lane': scored.experiment.lane,
        })
        await emitStateDiffTelemetry(this.config, previousState, state)
      }

      const stateBeforeFinalFreezeCheck = state
      state = recomputeTeacherFreeze(state, corpus, this.config.controllerConfig)
      state = {
        ...state,
        corpusVersion: corpus.version,
        challengeSetVersion: challengeSet.version,
        lastCycleAt: nowIso(),
      }
      await emitStateDiffTelemetry(
        this.config,
        stateBeforeFinalFreezeCheck,
        state,
      )

      for (const audit of state.audits) {
        await writeJsonFile(
          path.join(managedPaths.auditsDir, `${audit.id}.json`),
          audit,
        )
      }

      await Promise.all([
        writeJsonFile(managedPaths.stateFile, state),
        writeJsonFile(managedPaths.corpusFile, corpus),
        writeJsonFile(managedPaths.challengeSetFile, challengeSet),
      ])

      await emitTelemetry(this.config, 'autoresearch_cycle_completed', {
        'autoresearch.repo': this.config.repoRoot,
        ...buildStateTelemetryFields(state),
        ...buildCorpusTelemetryFields(corpus),
        ...buildChallengeSetTelemetryFields(challengeSet),
        ...buildSplitterTopologyTelemetryFields(this.config.controllerConfig.splitter),
        'autoresearch.experiment_count': String(state.experiments.length),
        'autoresearch.cycle_duration_ms': String(Date.now() - cycleStartMs),
      })
      await emitTelemetry(this.config, 'autoresearch_control_plane_snapshot', {
        'autoresearch.repo': this.config.repoRoot,
        ...buildControlPlaneSnapshotFields(state, corpus, challengeSet),
        ...buildSplitterTopologyTelemetryFields(this.config.controllerConfig.splitter),
      })
    } catch (error) {
      logForDebugging(
        `[autoresearch] cycle failed: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'error' },
      )
      await emitTelemetry(this.config, 'autoresearch_cycle_failed', {
        'autoresearch.repo': this.config.repoRoot,
        'autoresearch.result': 'failed',
        ...buildSplitterTopologyTelemetryFields(this.config.controllerConfig.splitter),
        'autoresearch.error_kind':
          error instanceof Error ? error.name : typeof error,
        'autoresearch.cycle_duration_ms': String(Date.now() - cycleStartMs),
      })
    } finally {
      _activeCycleTraceId = undefined
      this.running = false
    }
  }
}
