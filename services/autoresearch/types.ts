import { z } from 'zod/v4'
import { lazySchema } from 'src/utils/lazySchema.js'

export const BenchmarkTierValues = [
  'proposed',
  'quarantine',
  'gold',
  'hidden',
] as const

export const BenchmarkTierSchema = lazySchema(() => z.enum(BenchmarkTierValues))

export const RolloutLaneValues = [
  'shadow',
  'dogfood',
  'canary',
  'mainline',
] as const

export const RolloutLaneSchema = lazySchema(() => z.enum(RolloutLaneValues))

export const ClaudeCodeSessionEventTypeValues = [
  'session_end',
  'stop_failure',
] as const

export const ClaudeCodeSessionEventTypeSchema = lazySchema(() =>
  z.enum(ClaudeCodeSessionEventTypeValues),
)

export const SplitterExecutionModeValues = [
  'topology_only',
  'coordinator',
] as const

export const SplitterExecutionModeSchema = lazySchema(() =>
  z.enum(SplitterExecutionModeValues),
)

export const SplitterDomainTypeValues = [
  'global',
  'regional',
  'unit',
] as const

export const SplitterDomainTypeSchema = lazySchema(() =>
  z.enum(SplitterDomainTypeValues),
)

export const SplitterWorkstreamValues = [
  'candidate_eval',
  'benchmark_admission',
  'dogfood_observation',
  'promotion_controller',
] as const

export const SplitterWorkstreamSchema = lazySchema(() =>
  z.enum(SplitterWorkstreamValues),
)

export const SplitterShardKeyStrategyValues = [
  'candidate_digest',
  'candidate_case_digest',
  'proposal_case_digest',
  'observation_digest',
  'singleton',
] as const

export const SplitterShardKeyStrategySchema = lazySchema(() =>
  z.enum(SplitterShardKeyStrategyValues),
)

export const MutationClassValues = [
  'prompt',
  'policy',
  'runtime',
  'mixed',
] as const

export const MutationClassSchema = lazySchema(() => z.enum(MutationClassValues))

export const ChallengeAuditReasonValues = [
  'challenge_escape',
  'dogfood_miss',
  'benchmark_instability',
] as const

export const ChallengeAuditReasonSchema = lazySchema(() =>
  z.enum(ChallengeAuditReasonValues),
)

export const MutationSourceSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('manifest_directory'),
        path: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal('command'),
        command: z.string(),
        emitMode: z.enum(['side_effect', 'stdout_manifest']).optional(),
      })
      .strict(),
  ]),
)

export const CaseRunResultSchema = lazySchema(() =>
  z
    .object({
      caseId: z.string(),
      tier: BenchmarkTierSchema(),
      passed: z.boolean(),
      taskSuccess: z.boolean(),
      artifactValid: z.boolean(),
      unsupportedClaims: z.number().nonnegative().default(0),
      verifierBypasses: z.number().nonnegative().default(0),
      phaseViolations: z.number().nonnegative().default(0),
      missingEvidenceCompletions: z.number().nonnegative().default(0),
      tokenCost: z.number().nonnegative().default(0),
      runtimeMs: z.number().nonnegative().default(0),
      toolCallCount: z.number().nonnegative().default(0),
      predictedRegression: z.boolean().default(false),
      failureTags: z.array(z.string()).default([]),
      notes: z.string().optional(),
    })
    .strict(),
)

export const ChallengeResultSchema = lazySchema(() =>
  z
    .object({
      challengeId: z.string(),
      caught: z.boolean(),
      notes: z.string().optional(),
    })
    .strict(),
)

export const BenchmarkCaseSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      tier: BenchmarkTierSchema(),
      sourceSessionId: z.string().optional(),
      transcriptPath: z.string(),
      prompt: z.string(),
      fixturePath: z.string().optional(),
      expectedOutcome: z.string(),
      mustPass: z.boolean().default(false),
      rubric: z.array(z.string()).default([]),
      objectiveSignals: z.array(z.string()).default([]),
      canonicalFailureTags: z.array(z.string()).default([]),
      fingerprint: z.string().optional(),
      redacted: z.boolean().default(false),
      replayCount: z.number().nonnegative().default(0),
      stabilityScore: z.number().min(0).max(1).default(1),
      discriminatesChallengeSet: z.boolean().default(false),
      fixtureComplete: z.boolean().default(false),
      createdAt: z.string(),
      provenance: z.enum(['seed', 'proposal', 'audit']).default('seed'),
    })
    .strict(),
)

export const BenchmarkCorpusVersionSchema = lazySchema(() =>
  z
    .object({
      version: z.string(),
      cases: z.array(BenchmarkCaseSchema()),
    })
    .strict(),
)

export const BenchmarkProposalSchema = lazySchema(() =>
  z
    .object({
      case: BenchmarkCaseSchema(),
      desiredTier: z.enum(['gold', 'hidden']).default('gold'),
      reproducibleOnReplay: z.boolean(),
      objectivePassFail: z.boolean(),
      fingerprint: z.string().optional(),
    })
    .strict(),
)

export const BenchmarkAuditCaseSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      reason: ChallengeAuditReasonSchema(),
      status: z.enum(['open', 'resolved']),
      candidateId: z.string().optional(),
      experimentId: z.string().optional(),
      benchmarkCaseId: z.string().optional(),
      transcriptPath: z.string().optional(),
      fingerprint: z.string().optional(),
      failureTags: z.array(z.string()).default([]),
      summary: z.string(),
      createdAt: z.string(),
      resolvedAt: z.string().optional(),
    })
    .strict(),
)

export const ChallengeCandidateSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      label: z.string(),
      expectedFailureTags: z.array(z.string()).default([]),
    })
    .strict(),
)

export const ChallengeSetSchema = lazySchema(() =>
  z
    .object({
      version: z.string(),
      challengeCandidates: z.array(ChallengeCandidateSchema()),
    })
    .strict(),
)

export const SplitterDomainSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      workstream: SplitterWorkstreamSchema(),
      type: SplitterDomainTypeSchema(),
      shardKeyStrategy: SplitterShardKeyStrategySchema(),
      description: z.string(),
      regionAffinity: z.boolean().default(false),
    })
    .strict(),
)

export const SplitterConfigSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().default(false),
      executionMode: SplitterExecutionModeSchema().default('topology_only'),
      serviceId: z.string(),
      region: z.string().default('local'),
      clusterId: z.string().optional(),
      domains: z.array(SplitterDomainSchema()).default([]),
    })
    .strict(),
)

export const ScorecardSchema = lazySchema(() =>
  z
    .object({
      benchmarkCount: z.number().nonnegative(),
      taskSuccessRate: z.number().min(0).max(1),
      artifactValidityRate: z.number().min(0).max(1),
      unsupportedClaimRate: z.number().min(0),
      verifierBypassRate: z.number().min(0),
      phaseViolationRate: z.number().min(0),
      missingEvidenceCompletionRate: z.number().min(0),
      medianTokenCost: z.number().nonnegative(),
      medianRuntimeMs: z.number().nonnegative(),
      medianToolCallCount: z.number().nonnegative(),
      tokenCostDeltaPct: z.number(),
      runtimeDeltaPct: z.number(),
      hiddenHoldoutPass: z.boolean(),
      hiddenHoldoutPredictiveAccuracy: z.number().min(0).max(1),
      mustPassRegressionCount: z.number().nonnegative(),
      challengeSetCatchRate: z.number().min(0).max(1),
      benchmarkStabilityRate: z.number().min(0).max(1),
      dogfoodMissRate: z.number().min(0).max(1),
      eligibleForPromotion: z.boolean(),
      reasons: z.array(z.string()).default([]),
    })
    .strict(),
)

export const LearningDeltaSchema = lazySchema(() =>
  z
    .object({
      baselineMistakeTags: z.array(z.string()).default([]),
      currentMistakeTags: z.array(z.string()).default([]),
      newMistakeTags: z.array(z.string()).default([]),
      fixedMistakeTags: z.array(z.string()).default([]),
      repeatedMistakeTags: z.array(z.string()).default([]),
    })
    .strict(),
)

export const PromotionDecisionSchema = lazySchema(() =>
  z
    .object({
      decision: z.enum([
        'promote_shadow',
        'advance_lane',
        'hold',
        'reject',
        'rollback',
        'freeze_teacher',
      ]),
      reason: z.string(),
      targetLane: RolloutLaneSchema().optional(),
      timestamp: z.string(),
    })
    .strict(),
)

export const RollbackDecisionSchema = lazySchema(() =>
  z
    .object({
      candidateId: z.string(),
      fromLane: RolloutLaneSchema(),
      reason: z.string(),
      timestamp: z.string(),
    })
    .strict(),
)

export const LaneAssignmentSchema = lazySchema(() =>
  z
    .object({
      candidateId: z.string(),
      lane: RolloutLaneSchema(),
      successCount: z.number().nonnegative().default(0),
      regressionCount: z.number().nonnegative().default(0),
      rolloutChampion: z.boolean().default(false),
      lastTransitionAt: z.string(),
    })
    .strict(),
)

export const CandidateEvaluationSchema = lazySchema(() =>
  z
    .object({
      caseResults: z.array(CaseRunResultSchema()).default([]),
      challengeResults: z.array(ChallengeResultSchema()).default([]),
      benchmarkStabilityRate: z.number().min(0).max(1).default(1),
      dogfoodMissRate: z.number().min(0).max(1).default(0),
    })
    .strict(),
)

export const CandidateManifestSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      revision: z.string(),
      workspacePath: z.string(),
      changedFiles: z.array(z.string()).default([]),
      mutationClass: MutationClassSchema(),
      hypothesis: z.string(),
      source: z.string().optional(),
      createdAt: z.string(),
      evaluation: CandidateEvaluationSchema().optional(),
    })
    .strict(),
)

export const ExperimentRunSchema = lazySchema(() =>
  z
    .object({
      experimentId: z.string(),
      candidateId: z.string(),
      candidateRevision: z.string(),
      createdAt: z.string(),
      scoredAt: z.string().optional(),
      status: z.enum([
        'queued',
        'scored',
        'shadow',
        'dogfood',
        'canary',
        'rejected',
        'rolled_back',
      ]),
      lane: RolloutLaneSchema().optional(),
      scorecard: ScorecardSchema(),
      learningDelta: LearningDeltaSchema(),
      caseResults: z.array(CaseRunResultSchema()).default([]),
      challengeResults: z.array(ChallengeResultSchema()).default([]),
      promotionDecision: PromotionDecisionSchema().optional(),
      rollbackDecision: RollbackDecisionSchema().optional(),
    })
    .strict(),
)

export const DogfoodObservationSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      candidateId: z.string(),
      experimentId: z.string().optional(),
      lane: RolloutLaneSchema(),
      success: z.boolean(),
      predictedRegression: z.boolean().default(false),
      actualRegression: z.boolean().default(false),
      transcriptPath: z.string().optional(),
      fingerprint: z.string().optional(),
      failureTags: z.array(z.string()).default([]),
      summary: z.string().optional(),
      recordedAt: z.string(),
    })
    .strict(),
)

export const ClaudeCodeSessionObservationSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      sessionId: z.string(),
      eventType: ClaudeCodeSessionEventTypeSchema(),
      transcriptPath: z.string(),
      cwd: z.string(),
      exitReason: z.string().optional(),
      summary: z.string().optional(),
      firstPrompt: z.string().optional(),
      messageCount: z.number().int().nonnegative().optional(),
      projectPath: z.string().optional(),
      success: z.boolean(),
      actualRegression: z.boolean(),
      heuristicConfidence: z.number().min(0).max(1),
      failureTags: z.array(z.string()).default([]),
      source: z.string(),
      recordedAt: z.string(),
      tokenCost: z.number().nonnegative().optional(),
      runtimeMs: z.number().nonnegative().optional(),
      toolCallCount: z.number().nonnegative().optional(),
    })
    .strict(),
)

export const ClaudeCodeTrendSnapshotSchema = lazySchema(() =>
  z
    .object({
      totalObservationCount: z.number().int().nonnegative(),
      totalSessionCount: z.number().int().nonnegative(),
      successSessionCount: z.number().int().nonnegative(),
      regressionSessionCount: z.number().int().nonnegative(),
      highConfidenceRegressionSessionCount: z.number().int().nonnegative(),
      currentWindowSize: z.number().int().nonnegative(),
      previousWindowSize: z.number().int().nonnegative(),
      currentMistakeTags: z.array(z.string()).default([]),
      newMistakeTags: z.array(z.string()).default([]),
      fixedMistakeTags: z.array(z.string()).default([]),
      repeatedMistakeTags: z.array(z.string()).default([]),
      lastRecordedAt: z.string().optional(),
    })
    .strict(),
)

export const ReliabilityFloorsSchema = lazySchema(() =>
  z
    .object({
      unsupportedClaimRate: z.number().min(0),
      verifierBypassRate: z.number().min(0),
      phaseViolationRate: z.number().min(0),
      missingEvidenceCompletionRate: z.number().min(0),
      challengeSetCatchRate: z.number().min(0).max(1),
      hiddenHoldoutPredictiveAccuracy: z.number().min(0).max(1),
      dogfoodMissRate: z.number().min(0).max(1),
      benchmarkStabilityRate: z.number().min(0).max(1),
    })
    .strict(),
)

export const CostCeilingsSchema = lazySchema(() =>
  z
    .object({
      maxTokenCostDeltaPct: z.number().min(0),
      maxRuntimeDeltaPct: z.number().min(0),
    })
    .strict(),
)

export const AdmissionThresholdsSchema = lazySchema(() =>
  z
    .object({
      minimumReplayCount: z.number().int().nonnegative(),
      minimumStabilityScore: z.number().min(0).max(1),
      requireChallengeDiscrimination: z.boolean().default(true),
    })
    .strict(),
)

export const RolloutThresholdsSchema = lazySchema(() =>
  z
    .object({
      shadowSuccessCount: z.number().int().positive(),
      dogfoodSuccessCount: z.number().int().positive(),
      canarySuccessCount: z.number().int().positive(),
      maxRegressionRate: z.number().min(0).max(1),
    })
    .strict(),
)

export const TeacherFreezeThresholdsSchema = lazySchema(() =>
  z
    .object({
      challengeEscapeRate: z.number().min(0).max(1),
      dogfoodMissRate: z.number().min(0).max(1),
      benchmarkInstabilityRate: z.number().min(0).max(1),
    })
    .strict(),
)

export const AutoresearchConfigSchema = lazySchema(() =>
  z
    .object({
      version: z.string(),
      seedCorpusPath: z.string(),
      seedChallengeSetPath: z.string(),
      mutationSources: z.array(MutationSourceSchema()).default([]),
      immutableCandidateGlobs: z.array(z.string()).default([]),
      evaluationCommand: z.string().optional(),
      splitter: SplitterConfigSchema().optional(),
      reliabilityFloors: ReliabilityFloorsSchema(),
      costCeilings: CostCeilingsSchema(),
      admissionThresholds: AdmissionThresholdsSchema(),
      rolloutThresholds: RolloutThresholdsSchema(),
      teacherFreezeThresholds: TeacherFreezeThresholdsSchema(),
    })
    .strict(),
)

export const AutoresearchSettingsSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().optional(),
      configPath: z.string().optional(),
      experimentStatePath: z.string().optional(),
      schedulerCadenceMs: z.number().positive().optional(),
      emitTelemetry: z.boolean().optional(),
    })
    .strict(),
)

export const RolloutStateSchema = lazySchema(() =>
  z
    .object({
      repoRoot: z.string(),
      corpusVersion: z.string(),
      challengeSetVersion: z.string(),
      teacherFrozen: z.boolean(),
      freezeReason: z.string().optional(),
      freezeOpenedAt: z.string().optional(),
      currentChampionCandidateId: z.string().optional(),
      previousChampionCandidateId: z.string().optional(),
      processedCandidateIds: z.array(z.string()).default([]),
      processedProposalIds: z.array(z.string()).default([]),
      processedObservationIds: z.array(z.string()).default([]),
      processedClaudeCodeObservationIds: z.array(z.string()).default([]),
      experiments: z.array(ExperimentRunSchema()).default([]),
      laneAssignments: z.array(LaneAssignmentSchema()).default([]),
      audits: z.array(BenchmarkAuditCaseSchema()).default([]),
      lastClaudeCodeTrendSnapshot: ClaudeCodeTrendSnapshotSchema().optional(),
      lastCycleAt: z.string().optional(),
    })
    .strict(),
)

export type BenchmarkTier = z.infer<ReturnType<typeof BenchmarkTierSchema>>
export type RolloutLane = z.infer<ReturnType<typeof RolloutLaneSchema>>
export type SplitterExecutionMode = z.infer<
  ReturnType<typeof SplitterExecutionModeSchema>
>
export type SplitterDomainType = z.infer<
  ReturnType<typeof SplitterDomainTypeSchema>
>
export type SplitterWorkstream = z.infer<
  ReturnType<typeof SplitterWorkstreamSchema>
>
export type SplitterShardKeyStrategy = z.infer<
  ReturnType<typeof SplitterShardKeyStrategySchema>
>
export type MutationSource = z.infer<ReturnType<typeof MutationSourceSchema>>
export type MutationClass = z.infer<ReturnType<typeof MutationClassSchema>>
export type CaseRunResult = z.infer<ReturnType<typeof CaseRunResultSchema>>
export type ChallengeResult = z.infer<ReturnType<typeof ChallengeResultSchema>>
export type BenchmarkCase = z.infer<ReturnType<typeof BenchmarkCaseSchema>>
export type BenchmarkCorpusVersion = z.infer<
  ReturnType<typeof BenchmarkCorpusVersionSchema>
>
export type BenchmarkProposal = z.infer<
  ReturnType<typeof BenchmarkProposalSchema>
>
export type BenchmarkAuditCase = z.infer<
  ReturnType<typeof BenchmarkAuditCaseSchema>
>
export type ChallengeCandidate = z.infer<
  ReturnType<typeof ChallengeCandidateSchema>
>
export type ChallengeSet = z.infer<ReturnType<typeof ChallengeSetSchema>>
export type SplitterDomain = z.infer<ReturnType<typeof SplitterDomainSchema>>
export type SplitterConfig = z.infer<ReturnType<typeof SplitterConfigSchema>>
export type Scorecard = z.infer<ReturnType<typeof ScorecardSchema>>
export type LearningDelta = z.infer<ReturnType<typeof LearningDeltaSchema>>
export type PromotionDecision = z.infer<
  ReturnType<typeof PromotionDecisionSchema>
>
export type RollbackDecision = z.infer<
  ReturnType<typeof RollbackDecisionSchema>
>
export type LaneAssignment = z.infer<ReturnType<typeof LaneAssignmentSchema>>
export type CandidateEvaluation = z.infer<
  ReturnType<typeof CandidateEvaluationSchema>
>
export type CandidateManifest = z.infer<
  ReturnType<typeof CandidateManifestSchema>
>
export type ExperimentRun = z.infer<ReturnType<typeof ExperimentRunSchema>>
export type DogfoodObservation = z.infer<
  ReturnType<typeof DogfoodObservationSchema>
>
export type ClaudeCodeSessionEventType = z.infer<
  ReturnType<typeof ClaudeCodeSessionEventTypeSchema>
>
export type ClaudeCodeSessionObservation = z.infer<
  ReturnType<typeof ClaudeCodeSessionObservationSchema>
>
export type ClaudeCodeTrendSnapshot = z.infer<
  ReturnType<typeof ClaudeCodeTrendSnapshotSchema>
>
export type ReliabilityFloors = z.infer<
  ReturnType<typeof ReliabilityFloorsSchema>
>
export type CostCeilings = z.infer<ReturnType<typeof CostCeilingsSchema>>
export type AdmissionThresholds = z.infer<
  ReturnType<typeof AdmissionThresholdsSchema>
>
export type RolloutThresholds = z.infer<
  ReturnType<typeof RolloutThresholdsSchema>
>
export type TeacherFreezeThresholds = z.infer<
  ReturnType<typeof TeacherFreezeThresholdsSchema>
>
export type AutoresearchConfig = z.infer<
  ReturnType<typeof AutoresearchConfigSchema>
>
export type AutoresearchSettings = z.infer<
  ReturnType<typeof AutoresearchSettingsSchema>
>
export type RolloutState = z.infer<ReturnType<typeof RolloutStateSchema>>
