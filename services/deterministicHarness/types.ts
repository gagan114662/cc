import { z } from 'zod/v4'
import { lazySchema } from 'src/utils/lazySchema.js'

export const DETERMINISTIC_PHASES = [
  'intake',
  'discover',
  'plan',
  'implement',
  'verify',
  'release',
  'done',
] as const

export type DeterministicPhase = (typeof DETERMINISTIC_PHASES)[number]

export const DeterministicPhaseSchema = lazySchema(() =>
  z.enum(DETERMINISTIC_PHASES),
)

export const ClaimStatusSchema = lazySchema(() =>
  z.enum(['verified', 'assumption', 'proposal']),
)

export const TaskSpecSchema = lazySchema(() =>
  z
    .object({
      taskIntent: z.string(),
      repoTarget: z.string(),
      requestedOutcome: z.string(),
      riskLevel: z.enum(['low', 'medium', 'high']),
      userPrompt: z.string(),
    })
    .strict(),
)

export const ClaimSchema = lazySchema(() =>
  z
    .object({
      text: z.string(),
      status: ClaimStatusSchema(),
      evidenceIds: z.array(z.string()).optional(),
    })
    .strict(),
)

export const PhaseResultSchema = lazySchema(() =>
  z
    .object({
      phase: DeterministicPhaseSchema(),
      summary: z.string(),
      proposedActions: z.array(z.string()),
      assumptions: z.array(z.string()),
      expectedEvidence: z.array(z.string()),
      claims: z.array(ClaimSchema()),
      nextPhase: DeterministicPhaseSchema(),
    })
    .strict(),
)

export const EvidenceRecordSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      phase: DeterministicPhaseSchema(),
      event: z.enum(['tool_succeeded', 'tool_failed']),
      toolName: z.string(),
      summary: z.string(),
      contentHash: z.string(),
      timestamp: z.string(),
    })
    .strict(),
)

export const VerifierResultSchema = lazySchema(() =>
  z
    .object({
      verifierName: z.string(),
      status: z.enum(['passed', 'failed']),
      phase: DeterministicPhaseSchema(),
      artifactsChecked: z.array(z.string()),
      failureReason: z.string().optional(),
      timestamp: z.string(),
    })
    .strict(),
)

export const PolicyDecisionSchema = lazySchema(() =>
  z
    .object({
      decision: z.enum([
        'allow',
        'block',
        'require_human_gate',
        'retry_with_feedback',
      ]),
      phase: DeterministicPhaseSchema(),
      reason: z.string(),
      toolName: z.string().optional(),
      command: z.string().optional(),
      timestamp: z.string(),
    })
    .strict(),
)

export const ArtifactRuleSchema = lazySchema(() =>
  z
    .object({
      pattern: z.string(),
      validationCommand: z.string().optional(),
      requiredAnchor: z.string().optional(),
    })
    .strict(),
)

export const PhaseCommandPrefixesSchema = lazySchema(() =>
  z
    .object({
      intake: z.array(z.string()).optional(),
      discover: z.array(z.string()).optional(),
      plan: z.array(z.string()).optional(),
      implement: z.array(z.string()).optional(),
      verify: z.array(z.string()).optional(),
      release: z.array(z.string()).optional(),
      done: z.array(z.string()).optional(),
    })
    .strict(),
)

export const RepoAdapterSchema = lazySchema(() =>
  z
    .object({
      version: z.string(),
      canonicalRoots: z.array(z.string()).min(1),
      requiredDocs: z.array(z.string()).default([]),
      searchExcludes: z.array(z.string()).default([]),
      bootstrapCommands: z.array(z.string()).default([]),
      analysisCommands: z.array(z.string()).default([]),
      implementationVerificationCommands: z.array(z.string()).default([]),
      releaseVerificationCommands: z.array(z.string()).default([]),
      artifactRules: z.array(ArtifactRuleSchema()).default([]),
      riskyCommandAllowlist: z.array(z.string()).default([]),
      approvedCommandPrefixes: PhaseCommandPrefixesSchema().default({}),
    })
    .strict(),
)

export const DeterministicHarnessSettingsSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().optional(),
      strictWorkflow: z.boolean().optional(),
      repoAdapterPath: z.string().optional(),
      repoAdapter: RepoAdapterSchema().optional(),
      requireHumanGate: z.boolean().optional(),
      emitTelemetry: z.boolean().optional(),
      strictJsonResponses: z.boolean().optional(),
    })
    .strict(),
)

export type TaskSpec = z.infer<ReturnType<typeof TaskSpecSchema>>
export type Claim = z.infer<ReturnType<typeof ClaimSchema>>
export type PhaseResult = z.infer<ReturnType<typeof PhaseResultSchema>>
export type EvidenceRecord = z.infer<ReturnType<typeof EvidenceRecordSchema>>
export type VerifierResult = z.infer<ReturnType<typeof VerifierResultSchema>>
export type PolicyDecision = z.infer<ReturnType<typeof PolicyDecisionSchema>>
export type ArtifactRule = z.infer<ReturnType<typeof ArtifactRuleSchema>>
export type RepoAdapter = z.infer<ReturnType<typeof RepoAdapterSchema>>
export type DeterministicHarnessSettings = z.infer<
  ReturnType<typeof DeterministicHarnessSettingsSchema>
>
