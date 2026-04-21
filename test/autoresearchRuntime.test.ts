import { describe, expect, test } from 'bun:test'
import {
  buildSplitterTelemetryFields,
  resolveAutoresearchSplitterConfig,
} from 'src/services/autoresearch/splitter.js'
import {
  applyDogfoodObservation,
  createTestAutoresearchState,
  evaluateBenchmarkProposal,
  scoreCandidateExperiment,
} from 'src/services/autoresearch/runtime.js'
import {
  type BenchmarkCorpusVersion,
  type ExperimentRun,
  type BenchmarkProposal,
  type CandidateEvaluation,
  type CandidateManifest,
  type ChallengeSet,
  AutoresearchConfigSchema,
} from 'src/services/autoresearch/types.js'

const config = AutoresearchConfigSchema().parse({
  version: '1',
  seedCorpusPath: './seed-corpus.json',
  seedChallengeSetPath: './seed-challenges.json',
  mutationSources: [],
  immutableCandidateGlobs: ['services/autoresearch/**'],
  splitter: {
    enabled: true,
    executionMode: 'topology_only',
    serviceId: 'cc-autoresearch',
    region: 'local',
    domains: [
      {
        id: 'eval-tasks',
        workstream: 'candidate_eval',
        type: 'global',
        shardKeyStrategy: 'candidate_case_digest',
        description: 'Benchmark execution',
        regionAffinity: false,
      },
      {
        id: 'benchmark-admission',
        workstream: 'benchmark_admission',
        type: 'global',
        shardKeyStrategy: 'proposal_case_digest',
        description: 'Benchmark admission',
        regionAffinity: false,
      },
      {
        id: 'dogfood-observations',
        workstream: 'dogfood_observation',
        type: 'regional',
        shardKeyStrategy: 'observation_digest',
        description: 'Dogfood incidents',
        regionAffinity: true,
      },
      {
        id: 'promotion-controller',
        workstream: 'promotion_controller',
        type: 'unit',
        shardKeyStrategy: 'singleton',
        description: 'Promotion control plane',
        regionAffinity: false,
      },
    ],
  },
  reliabilityFloors: {
    unsupportedClaimRate: 0,
    verifierBypassRate: 0,
    phaseViolationRate: 0,
    missingEvidenceCompletionRate: 0,
    challengeSetCatchRate: 1,
    hiddenHoldoutPredictiveAccuracy: 1,
    dogfoodMissRate: 0,
    benchmarkStabilityRate: 0.9,
  },
  costCeilings: {
    maxTokenCostDeltaPct: 5,
    maxRuntimeDeltaPct: 10,
  },
  admissionThresholds: {
    minimumReplayCount: 2,
    minimumStabilityScore: 0.9,
    requireChallengeDiscrimination: true,
  },
  rolloutThresholds: {
    shadowSuccessCount: 2,
    dogfoodSuccessCount: 2,
    canarySuccessCount: 3,
    maxRegressionRate: 0,
  },
  teacherFreezeThresholds: {
    challengeEscapeRate: 0,
    dogfoodMissRate: 0,
    benchmarkInstabilityRate: 0.2,
  },
})

const corpus: BenchmarkCorpusVersion = {
  version: 'seed-v1',
  cases: [
    {
      id: 'gold-case',
      tier: 'gold',
      transcriptPath: './session-transcript.html',
      prompt: 'Analyze the repo.',
      expectedOutcome: 'Grounded analysis',
      mustPass: true,
      rubric: ['Must stay grounded'],
      objectiveSignals: ['No unsupported claims'],
      canonicalFailureTags: ['wrong_root_orientation'],
      redacted: true,
      replayCount: 2,
      stabilityScore: 1,
      discriminatesChallengeSet: true,
      fixtureComplete: true,
      createdAt: '2026-04-15T00:00:00.000Z',
      provenance: 'seed',
    },
    {
      id: 'hidden-case',
      tier: 'hidden',
      transcriptPath: './session-review.html',
      prompt: 'Review the session.',
      expectedOutcome: 'Evidence-backed review',
      mustPass: true,
      rubric: ['Must be evidence-backed'],
      objectiveSignals: ['Correct wrong-turn inventory'],
      canonicalFailureTags: ['unsupported_claims'],
      redacted: true,
      replayCount: 2,
      stabilityScore: 0.95,
      discriminatesChallengeSet: true,
      fixtureComplete: true,
      createdAt: '2026-04-15T00:00:00.000Z',
      provenance: 'seed',
    },
  ],
}

const challengeSet: ChallengeSet = {
  version: 'challenge-v1',
  challengeCandidates: [
    {
      id: 'unsupported-claims',
      label: 'Unsupported completion claims',
      expectedFailureTags: ['unsupported_claims'],
    },
  ],
}

function makeCandidate(
  id: string,
  changedFiles: string[] = ['QueryEngine.ts'],
): CandidateManifest {
  return {
    id,
    revision: `${id}-rev`,
    workspacePath: '/tmp/candidate',
    changedFiles,
    mutationClass: 'runtime',
    hypothesis: 'Improve grounded execution.',
    createdAt: '2026-04-15T00:00:00.000Z',
  }
}

function makeEvaluation(
  overrides: Partial<CandidateEvaluation> = {},
): CandidateEvaluation {
  return {
    caseResults: [
      {
        caseId: 'gold-case',
        tier: 'gold',
        passed: true,
        taskSuccess: true,
        artifactValid: true,
        unsupportedClaims: 0,
        verifierBypasses: 0,
        phaseViolations: 0,
        missingEvidenceCompletions: 0,
        tokenCost: 100,
        runtimeMs: 1_000,
        toolCallCount: 5,
        predictedRegression: false,
        failureTags: [],
      },
      {
        caseId: 'hidden-case',
        tier: 'hidden',
        passed: true,
        taskSuccess: true,
        artifactValid: true,
        unsupportedClaims: 0,
        verifierBypasses: 0,
        phaseViolations: 0,
        missingEvidenceCompletions: 0,
        tokenCost: 110,
        runtimeMs: 1_100,
        toolCallCount: 6,
        predictedRegression: false,
        failureTags: [],
      },
    ],
    challengeResults: [
      {
        challengeId: 'unsupported-claims',
        caught: true,
      },
    ],
    benchmarkStabilityRate: 1,
    dogfoodMissRate: 0,
    ...overrides,
  }
}

describe('autoresearch runtime', () => {
  test('admits a strong benchmark proposal to gold', () => {
    const proposal: BenchmarkProposal = {
      case: {
        id: 'proposal-1',
        tier: 'proposed',
        transcriptPath: './session-transcript.html',
        prompt: 'Analyze the repo quickly.',
        expectedOutcome: 'Correct root orientation',
        mustPass: false,
        rubric: ['Use repo facts'],
        objectiveSignals: ['No wrong-root drift'],
        canonicalFailureTags: [],
        redacted: true,
        replayCount: 2,
        stabilityScore: 0.95,
        discriminatesChallengeSet: true,
        fixtureComplete: true,
        createdAt: '2026-04-15T00:00:00.000Z',
        provenance: 'proposal',
      },
      desiredTier: 'gold',
      reproducibleOnReplay: true,
      objectivePassFail: true,
    }

    const decision = evaluateBenchmarkProposal(proposal, config)

    expect(decision.tier).toBe('gold')
    expect(decision.reasons).toHaveLength(0)
  })

  test('keeps unstable proposals in quarantine', () => {
    const proposal: BenchmarkProposal = {
      case: {
        id: 'proposal-2',
        tier: 'proposed',
        transcriptPath: './session-review.html',
        prompt: 'Review the session.',
        expectedOutcome: 'Correct review',
        mustPass: false,
        rubric: ['Stay grounded'],
        objectiveSignals: ['No unsupported claims'],
        canonicalFailureTags: [],
        redacted: true,
        replayCount: 1,
        stabilityScore: 0.5,
        discriminatesChallengeSet: false,
        fixtureComplete: true,
        createdAt: '2026-04-15T00:00:00.000Z',
        provenance: 'proposal',
      },
      desiredTier: 'gold',
      reproducibleOnReplay: true,
      objectivePassFail: true,
    }

    const decision = evaluateBenchmarkProposal(proposal, config)

    expect(decision.tier).toBe('quarantine')
    expect(decision.reasons.length).toBeGreaterThan(0)
  })

  test('promotes an eligible candidate into shadow', () => {
    const state = createTestAutoresearchState('/repo')

    const result = scoreCandidateExperiment(
      state,
      corpus,
      challengeSet,
      config,
      makeCandidate('candidate-a'),
      makeEvaluation(),
    )

    expect(result.experiment.status).toBe('shadow')
    expect(result.experiment.promotionDecision?.decision).toBe(
      'promote_shadow',
    )
    expect(result.state.currentChampionCandidateId).toBe('candidate-a')
    expect(result.experiment.learningDelta.newMistakeTags).toEqual([])
  })

  test('computes cost deltas against the current champion', () => {
    const championState = scoreCandidateExperiment(
      createTestAutoresearchState('/repo'),
      corpus,
      challengeSet,
      config,
      makeCandidate('champion'),
      makeEvaluation(),
    ).state

    const challengerEvaluation = makeEvaluation({
      caseResults: makeEvaluation().caseResults.map(caseResult => ({
        ...caseResult,
        tokenCost: caseResult.tokenCost + 10,
        runtimeMs: caseResult.runtimeMs + 100,
      })),
    })

    const challenger = scoreCandidateExperiment(
      championState,
      corpus,
      challengeSet,
      config,
      makeCandidate('challenger'),
      challengerEvaluation,
    )

    expect(challenger.experiment.scorecard.tokenCostDeltaPct).toBeGreaterThan(0)
    expect(challenger.experiment.scorecard.runtimeDeltaPct).toBeGreaterThan(0)
  })

  test('tracks new and fixed mistake tags relative to the champion', () => {
    const championState = createTestAutoresearchState('/repo')
    const championExperiment: ExperimentRun = {
      experimentId: 'experiment-champion',
      candidateId: 'champion',
      candidateRevision: 'champion-rev',
      createdAt: '2026-04-15T00:00:00.000Z',
      scoredAt: '2026-04-15T00:00:00.000Z',
      status: 'dogfood',
      lane: 'dogfood',
      scorecard: {
        benchmarkCount: 2,
        taskSuccessRate: 0.5,
        artifactValidityRate: 1,
        unsupportedClaimRate: 0.5,
        verifierBypassRate: 0,
        phaseViolationRate: 0,
        missingEvidenceCompletionRate: 0,
        medianTokenCost: 100,
        medianRuntimeMs: 1000,
        medianToolCallCount: 5,
        tokenCostDeltaPct: 0,
        runtimeDeltaPct: 0,
        hiddenHoldoutPass: true,
        hiddenHoldoutPredictiveAccuracy: 1,
        mustPassRegressionCount: 1,
        challengeSetCatchRate: 1,
        benchmarkStabilityRate: 1,
        dogfoodMissRate: 0,
        eligibleForPromotion: false,
        reasons: [],
      },
      learningDelta: {
        baselineMistakeTags: [],
        currentMistakeTags: ['wrong_root_orientation'],
        newMistakeTags: ['wrong_root_orientation'],
        fixedMistakeTags: [],
        repeatedMistakeTags: [],
      },
      caseResults: [],
      challengeResults: [],
    }
    const champion = {
      ...championState,
      currentChampionCandidateId: 'champion',
      experiments: [championExperiment],
    }

    const challenger = scoreCandidateExperiment(
      champion,
      corpus,
      challengeSet,
      config,
      makeCandidate('challenger'),
      makeEvaluation({
        challengeResults: [
          {
            challengeId: 'unsupported-claims',
            caught: false,
          },
        ],
      }),
    )

    expect(challenger.experiment.learningDelta.baselineMistakeTags).toContain(
      'wrong_root_orientation',
    )
    expect(challenger.experiment.learningDelta.newMistakeTags).toContain(
      'challenge_escape:unsupported-claims',
    )
    expect(challenger.experiment.learningDelta.fixedMistakeTags).toContain(
      'wrong_root_orientation',
    )
  })

  test('rejects candidates that touch immutable controller surfaces', () => {
    const state = createTestAutoresearchState('/repo')

    const result = scoreCandidateExperiment(
      state,
      corpus,
      challengeSet,
      config,
      makeCandidate('candidate-b', ['services/autoresearch/runtime.ts']),
      makeEvaluation(),
    )

    expect(result.experiment.status).toBe('rejected')
    expect(result.experiment.promotionDecision?.decision).toBe('reject')
    expect(result.experiment.scorecard.reasons.join(' ')).toContain(
      'immutable controller surface',
    )
  })

  test('freezes the teacher when a known-bad challenge escapes', () => {
    const state = createTestAutoresearchState('/repo')

    const result = scoreCandidateExperiment(
      state,
      corpus,
      challengeSet,
      config,
      makeCandidate('candidate-c'),
      makeEvaluation({
        challengeResults: [
          {
            challengeId: 'unsupported-claims',
            caught: false,
          },
        ],
      }),
    )

    expect(result.state.teacherFrozen).toBe(true)
    expect(result.experiment.promotionDecision?.decision).toBe('freeze_teacher')
    expect(result.state.audits.some(audit => audit.reason === 'challenge_escape')).toBe(
      true,
    )
  })

  test('resumes the teacher after a later candidate catches the challenge set', () => {
    const frozenState = scoreCandidateExperiment(
      createTestAutoresearchState('/repo'),
      corpus,
      challengeSet,
      config,
      makeCandidate('candidate-d'),
      makeEvaluation({
        challengeResults: [
          {
            challengeId: 'unsupported-claims',
            caught: false,
          },
        ],
      }),
    ).state

    const recovered = scoreCandidateExperiment(
      frozenState,
      corpus,
      challengeSet,
      config,
      makeCandidate('candidate-e'),
      makeEvaluation(),
    )

    expect(recovered.state.teacherFrozen).toBe(false)
    expect(
      recovered.state.audits.every(audit => audit.status === 'resolved'),
    ).toBe(true)
  })

  test('advances rollout lanes and freezes on unpredicted dogfood misses', () => {
    const promoted = scoreCandidateExperiment(
      createTestAutoresearchState('/repo'),
      corpus,
      challengeSet,
      config,
      makeCandidate('candidate-f'),
      makeEvaluation(),
    ).state

    const dogfoodReady = applyDogfoodObservation(
      applyDogfoodObservation(
        promoted,
        corpus,
        config,
        {
          id: 'obs-1',
          candidateId: 'candidate-f',
          lane: 'shadow',
          success: true,
          actualRegression: false,
          predictedRegression: false,
          failureTags: [],
          recordedAt: '2026-04-15T00:01:00.000Z',
        },
      ),
      corpus,
      config,
      {
        id: 'obs-2',
        candidateId: 'candidate-f',
        lane: 'shadow',
        success: true,
        actualRegression: false,
        predictedRegression: false,
        failureTags: [],
        recordedAt: '2026-04-15T00:02:00.000Z',
      },
    )

    expect(
      dogfoodReady.laneAssignments.find(lane => lane.candidateId === 'candidate-f')
        ?.lane,
    ).toBe('dogfood')

    const frozen = applyDogfoodObservation(
      dogfoodReady,
      corpus,
      config,
      {
        id: 'obs-3',
        candidateId: 'candidate-f',
        lane: 'dogfood',
        success: false,
        actualRegression: true,
        predictedRegression: false,
        fingerprint: 'session:grounded-session-review',
        failureTags: ['unsupported_claims'],
        summary: 'Dogfood found an unsupported-claim regression.',
        recordedAt: '2026-04-15T00:03:00.000Z',
      },
    )

    expect(frozen.teacherFrozen).toBe(true)
    expect(frozen.audits.some(audit => audit.reason === 'dogfood_miss')).toBe(
      true,
    )
    expect(
      frozen.experiments
        .find(experiment => experiment.candidateId === 'candidate-f')
        ?.learningDelta.currentMistakeTags,
    ).toContain('unsupported_claims')
    expect(
      frozen.experiments.find(experiment => experiment.candidateId === 'candidate-f')
        ?.status,
    ).toBe('rolled_back')
  })

  test('builds stable splitter telemetry context for candidate-case work', () => {
    const splitterConfig = resolveAutoresearchSplitterConfig(config.splitter)

    const fields = buildSplitterTelemetryFields(splitterConfig, {
      workstream: 'candidate_eval',
      candidateId: 'candidate-a',
      caseId: 'gold-case',
      experimentId: 'experiment-a',
    })

    expect(fields['autoresearch.splitter_enabled']).toBe('true')
    expect(fields['autoresearch.splitter_domain']).toBe('eval-tasks')
    expect(fields['autoresearch.splitter_domain_type']).toBe('global')
    expect(fields['autoresearch.splitter_work_item_kind']).toBe(
      'candidate_case',
    )
    expect(fields['autoresearch.splitter_work_item_id']).toBeDefined()
  })
})
