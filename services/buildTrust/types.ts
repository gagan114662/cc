import { z } from 'zod/v4'
import { lazySchema } from 'src/utils/lazySchema.js'

export const BuildTrustProfileValues = ['local', 'ci', 'release'] as const
export type BuildTrustProfileName = (typeof BuildTrustProfileValues)[number]

export const BuildTrustProfileNameSchema = lazySchema(() =>
  z.enum(BuildTrustProfileValues),
)

export const BuildTrustSeverityValues = ['error', 'warning'] as const
export const BuildTrustSeveritySchema = lazySchema(() =>
  z.enum(BuildTrustSeverityValues),
)

export const BuildTrustProfileSchema = lazySchema(() =>
  z
    .object({
      rerunEach: z.number().int().min(1),
      randomSeeds: z.array(z.number().int()).min(1),
      runCoverage: z.boolean().default(true),
      runSmokeEmployee: z.boolean().default(false),
      requireProofArtifact: z.boolean().default(true),
    })
    .strict(),
)

export const BuildTrustThresholdsSchema = lazySchema(() =>
  z
    .object({
      minChangedLineCoveragePct: z.number().min(0).max(100),
      minCriticalChangedLineCoveragePct: z.number().min(0).max(100),
      maxFlakyFiles: z.number().int().min(0),
      maxUnexplainedSuppressions: z.number().int().min(0),
      maxQualityWarningsInCi: z.number().int().min(0),
      maxSurvivingMutations: z.number().int().min(0).default(0),
    })
    .strict(),
)

export const BuildTrustQualityRulesSchema = lazySchema(() =>
  z
    .object({
      computedExpectedSeverity: z.record(
        BuildTrustProfileNameSchema(),
        BuildTrustSeveritySchema(),
      ),
      requireIntentTraceForChangedTests: z.boolean().default(true),
      requireSpecTraceForChangedTests: z.boolean().default(true),
      requireNegativeCaseForChangedTests: z.boolean().default(true),
      forbidSnapshotOnlyAssertions: z.boolean().default(true),
      forbidAnswerLeakage: z.boolean().default(true),
      requireSuppressionReason: z.boolean().default(true),
    })
    .strict(),
)

export const BuildTrustMutationRulesSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().default(true),
      maxTrialsPerRun: z.number().int().min(1).default(6),
      testCommand: z.string().min(1).default('bun test ./test'),
    })
    .strict(),
)

export const BuildTrustPolicySchema = lazySchema(() =>
  z
    .object({
      version: z.string(),
      baseRefResolution: z.array(z.string()).min(1),
      criticalGlobs: z.array(z.string()).default([]),
      profiles: z.record(BuildTrustProfileNameSchema(), BuildTrustProfileSchema()),
      thresholds: BuildTrustThresholdsSchema(),
      qualityRules: BuildTrustQualityRulesSchema(),
      mutationRules: BuildTrustMutationRulesSchema(),
    })
    .strict(),
)

export type BuildTrustPolicy = z.infer<ReturnType<typeof BuildTrustPolicySchema>>
