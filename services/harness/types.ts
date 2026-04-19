import { z } from 'zod/v4'
import { ENGINEERING_LEAD_AGENT_TYPE } from 'src/types/employee.js'
import { lazySchema } from 'src/utils/lazySchema.js'

export const HarnessExecutionModeValues = ['review-only', 'lead-session'] as const
export const HarnessExecutionModeSchema = lazySchema(() =>
  z.enum(HarnessExecutionModeValues),
)

export const HarnessAgentKindValues = ['claude', 'codex', 'either'] as const
export const HarnessAgentKindSchema = lazySchema(() =>
  z.enum(HarnessAgentKindValues),
)

export const HarnessJobKindValues = [
  'review',
  'repair',
  'maintenance',
  'implementation',
] as const
export const HarnessJobKindSchema = lazySchema(() =>
  z.enum(HarnessJobKindValues),
)

export const HarnessJobSourceEventValues = [
  'pull_request_opened',
  'pull_request_push',
  'pull_request_reopened',
  'review_requested_changes',
  'issue_labeled_automation',
  'default_branch_failure',
] as const
export const HarnessJobSourceEventSchema = lazySchema(() =>
  z.enum(HarnessJobSourceEventValues),
)

export const HarnessQueueSourceKindValues = [
  'github',
  'cron',
  'remoteTrigger',
  'manual',
  'webhook',
] as const
export const HarnessQueueSourceKindSchema = lazySchema(() =>
  z.enum(HarnessQueueSourceKindValues),
)

export const HarnessCodeChangePolicyValues = ['review-only', 'may-edit'] as const
export const HarnessCodeChangePolicySchema = lazySchema(() =>
  z.enum(HarnessCodeChangePolicyValues),
)

export const HarnessDeployAuthoritySchema = lazySchema(() =>
  z.enum(['disabled']),
)

export const HarnessReviewSeverityValues = ['info', 'warn', 'error'] as const
export const HarnessReviewSeveritySchema = lazySchema(() =>
  z.enum(HarnessReviewSeverityValues),
)

export const HarnessReviewStatusValues = ['pass', 'warn', 'block'] as const
export const HarnessReviewStatusSchema = lazySchema(() =>
  z.enum(HarnessReviewStatusValues),
)

export const HarnessJobStatusValues = [
  'queued',
  'leased',
  'running',
  'completed',
  'failed',
  'blocked',
] as const
export const HarnessJobStatusSchema = lazySchema(() =>
  z.enum(HarnessJobStatusValues),
)

export const HarnessRepoHealthImpactValues = [
  'safe',
  'serialized',
  'default-branch',
] as const
export const HarnessRepoHealthImpactSchema = lazySchema(() =>
  z.enum(HarnessRepoHealthImpactValues),
)

export const HarnessEscalationActionValues = [
  'retry',
  'pause_repo',
  'escalate',
] as const
export const HarnessEscalationActionSchema = lazySchema(() =>
  z.enum(HarnessEscalationActionValues),
)

export const HarnessRemoteDispatchModeValues = [
  'local-only',
  'shadow',
  'primary',
] as const
export const HarnessRemoteDispatchModeSchema = lazySchema(() =>
  z.enum(HarnessRemoteDispatchModeValues),
)

export const HarnessGitHubIntakeModeValues = [
  'poll',
  'webhook',
  'hybrid',
] as const
export const HarnessGitHubIntakeModeSchema = lazySchema(() =>
  z.enum(HarnessGitHubIntakeModeValues),
)

export const HarnessRepoHealthStatusValues = ['healthy', 'paused', 'red'] as const
export const HarnessRepoHealthStatusSchema = lazySchema(() =>
  z.enum(HarnessRepoHealthStatusValues),
)

export const HarnessExecutionBackendValues = [
  'local',
  'remote-session',
  'remote-trigger',
] as const
export const HarnessExecutionBackendSchema = lazySchema(() =>
  z.enum(HarnessExecutionBackendValues),
)

export const RetryPolicySchema = lazySchema(() =>
  z
    .object({
      maxAttempts: z.number().int().positive().default(1),
      backoffSeconds: z.number().int().nonnegative().default(0),
    })
    .strict(),
)

export const VerificationSpecSchema = lazySchema(() =>
  z
    .object({
      commands: z.array(z.string()).default([]),
      requirePassing: z.boolean().default(true),
    })
    .strict(),
)

export const BudgetSpecSchema = lazySchema(() =>
  z
    .object({
      maxUsd: z.number().positive().default(25),
      warnUsd: z.number().positive().default(20),
      defaultAttemptUsd: z.number().nonnegative().default(0.25),
    })
    .strict(),
)

export const EscalationPolicySchema = lazySchema(() =>
  z
    .object({
      onFailure: HarnessEscalationActionSchema().default('retry'),
      onBudgetExceeded: z.enum(['pause_repo', 'escalate']).default('pause_repo'),
      notify: z.array(z.string()).default([]),
    })
    .strict(),
)

export const GithubJobSourceBindingSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('github'),
      event: HarnessJobSourceEventSchema(),
      branch: z.string().optional(),
      label: z.string().optional(),
    })
    .strict(),
)

export const CronJobSourceBindingSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('cron'),
      cron: z.string(),
    })
    .strict(),
)

export const RemoteTriggerJobSourceBindingSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('remoteTrigger'),
      triggerId: z.string(),
    })
    .strict(),
)

export const ManualJobSourceBindingSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('manual'),
    })
    .strict(),
)

export const JobSourceBindingSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    GithubJobSourceBindingSchema(),
    CronJobSourceBindingSchema(),
    RemoteTriggerJobSourceBindingSchema(),
    ManualJobSourceBindingSchema(),
  ]),
)

export const JobSpecSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      kind: HarnessJobKindSchema(),
      agentKind: HarnessAgentKindSchema().default('claude'),
      executionMode: HarnessExecutionModeSchema().default('lead-session'),
      codeChangePolicy: HarnessCodeChangePolicySchema().default('may-edit'),
      promptTemplate: z.string(),
      targetAgent: z.string().default(ENGINEERING_LEAD_AGENT_TYPE),
      concurrencyKey: z.string(),
      autoCommit: z.boolean().default(false),
      autoMerge: z.boolean().default(false),
      priority: z.number().int().min(1).max(100).default(50),
      timeoutSeconds: z.number().int().positive().default(1800),
      maxParallelism: z.number().int().positive().default(1),
      repoHealthImpact: HarnessRepoHealthImpactSchema().default('safe'),
      retryPolicy: RetryPolicySchema().default({
        maxAttempts: 1,
        backoffSeconds: 0,
      }),
      budget: BudgetSpecSchema().default({
        maxUsd: 25,
        warnUsd: 20,
        defaultAttemptUsd: 0.25,
      }),
      escalationPolicy: EscalationPolicySchema().default({
        onFailure: 'retry',
        onBudgetExceeded: 'pause_repo',
        notify: [],
      }),
      verification: VerificationSpecSchema().default({
        commands: [],
        requirePassing: true,
      }),
      reviewerSuites: z.array(z.string()).default([]),
      sourceBindings: z.array(JobSourceBindingSchema()).min(1),
    })
    .strict(),
)

export const GithubSourceSpecSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().default(true),
      provider: z.literal('gh').default('gh'),
      pollIntervalSeconds: z.number().int().positive().default(300),
      intake: z
        .object({
          mode: HarnessGitHubIntakeModeSchema().default('hybrid'),
          webhookEvents: z
            .array(HarnessJobSourceEventSchema())
            .default([
              'pull_request_opened',
              'pull_request_push',
              'pull_request_reopened',
              'review_requested_changes',
              'issue_labeled_automation',
              'default_branch_failure',
            ]),
        })
        .strict()
        .default({
          mode: 'hybrid',
          webhookEvents: [
            'pull_request_opened',
            'pull_request_push',
            'pull_request_reopened',
            'review_requested_changes',
            'issue_labeled_automation',
            'default_branch_failure',
          ],
        }),
      reviewOnPush: z.boolean().default(true),
      trackDefaultBranch: z.boolean().default(true),
      defaultBranch: z.string().optional(),
    })
    .strict(),
)

export const CronSourceSpecSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().default(true),
      pollIntervalSeconds: z.number().int().positive().default(60),
    })
    .strict(),
)

export const RemoteTriggerSourceSpecSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().default(true),
      mirrorEnabled: z.boolean().default(true),
      dispatchMode: HarnessRemoteDispatchModeSchema().default('primary'),
      localFallback: z.boolean().default(true),
      maxWorkers: z.number().int().positive().default(4),
      pollIntervalSeconds: z.number().int().positive().default(300),
      inboxPath: z.string().default('.claude/harness/remote-events.json'),
      remoteApi: z.enum(['ccr']).default('ccr'),
      environmentId: z.string().optional(),
      model: z.string().default('claude-sonnet-4-6'),
    })
    .strict(),
)

export const WorkSourceSpecSchema = lazySchema(() =>
  z
    .object({
      github: GithubSourceSpecSchema(),
      cron: CronSourceSpecSchema(),
      remoteTriggers: RemoteTriggerSourceSpecSchema(),
    })
    .strict(),
)

export const ReviewerSpecSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      title: z.string(),
      kind: z.literal('builtin').default('builtin'),
      blocking: z.boolean().default(true),
      policyTags: z.array(z.string()).default([]),
      appliesToKinds: z.array(HarnessJobKindSchema()).default([]),
      instructions: z.string(),
    })
    .strict(),
)

export const AutonomyPolicySchema = lazySchema(() =>
  z
    .object({
      autoMerge: z.boolean().default(true),
      deploy: HarnessDeployAuthoritySchema().default('disabled'),
      pauseOnMainRed: z.boolean().default(true),
      createRevertJobOnRegression: z.boolean().default(true),
    })
    .strict(),
)

export const LearningConfigSchema = lazySchema(() =>
  z
    .object({
      knowledgePath: z.string().default('.claude/harness/feedback.md'),
      minimumRepeatCount: z.number().int().positive().default(2),
      attachToJobPrompts: z.boolean().default(true),
    })
    .strict(),
)

export const HarnessConfigSchema = lazySchema(() =>
  z
    .object({
      version: z.literal('1').default('1'),
      sources: WorkSourceSpecSchema(),
      jobs: z.array(JobSpecSchema()).default([]),
      reviewers: z.array(ReviewerSpecSchema()).default([]),
      autonomy: AutonomyPolicySchema(),
      learning: LearningConfigSchema(),
    })
    .strict(),
)

export const ReviewDecisionSchema = lazySchema(() =>
  z
    .object({
      reviewerId: z.string(),
      status: HarnessReviewStatusSchema(),
      blocking: z.boolean(),
      severity: HarnessReviewSeveritySchema().default('info'),
      reasonCode: z.string().default('unknown'),
      summary: z.string(),
      details: z.array(z.string()).default([]),
    })
    .strict(),
)

export const VerificationResultSchema = lazySchema(() =>
  z
    .object({
      command: z.string(),
      code: z.number().int(),
      stdout: z.string().default(''),
      stderr: z.string().default(''),
      phase: z.enum(['bootstrap', 'verification']).default('verification'),
      infrastructureFailure: z.boolean().default(false),
    })
    .strict(),
)

export const JobOutcomeSchema = lazySchema(() =>
  z
    .object({
      jobInstanceId: z.string(),
      jobId: z.string(),
      status: z.enum(['completed', 'failed', 'blocked']),
      summary: z.string(),
      startedAt: z.string(),
      completedAt: z.string(),
      attempt: z.number().int().positive(),
      reviewerDecisions: z.array(ReviewDecisionSchema()).default([]),
      verificationResults: z.array(VerificationResultSchema()).default([]),
      autoMergeRequested: z.boolean().default(false),
      autoMergeResult: z.string().optional(),
      failureTags: z.array(z.string()).default([]),
      humanTouchCount: z.number().int().nonnegative().default(0),
      totalCostUsd: z.number().nonnegative().default(0),
      executionBackend: HarnessExecutionBackendSchema().default('local'),
      regressionDetected: z.boolean().default(false),
      outputPath: z.string().optional(),
    })
    .strict(),
)

export const RemoteTriggerEventSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      jobId: z.string(),
      dedupeKey: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
      promptVariables: z.record(z.string(), z.string()).default({}),
      createdAt: z.string(),
    })
    .strict(),
)

export const QueuedHarnessJobSchema = lazySchema(() =>
  z
    .object({
      instanceId: z.string(),
      jobId: z.string(),
      agentKind: HarnessAgentKindSchema().default('claude'),
      sourceKind: HarnessQueueSourceKindSchema(),
      repoId: z.string().default('default'),
      dedupeKey: z.string(),
      concurrencyKey: z.string(),
      prompt: z.string(),
      status: HarnessJobStatusSchema(),
      priority: z.number().int().min(1).max(100).default(50),
      timeoutSeconds: z.number().int().positive().default(1800),
      maxParallelism: z.number().int().positive().default(1),
      metadata: z.record(z.string(), z.unknown()).default({}),
      promptVariables: z.record(z.string(), z.string()).default({}),
      createdAt: z.string(),
      updatedAt: z.string(),
      attempt: z.number().int().positive(),
      nextAttemptAt: z.string().optional(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
      reviewerDecisions: z.array(ReviewDecisionSchema()).default([]),
      verificationResults: z.array(VerificationResultSchema()).default([]),
      outcomeSummary: z.string().optional(),
      outputPath: z.string().optional(),
      remoteMirrorId: z.string().optional(),
      failureTags: z.array(z.string()).default([]),
    })
    .strict(),
)

export const HarnessLeaseSchema = lazySchema(() =>
  z
    .object({
      instanceId: z.string(),
      repoId: z.string().default('default'),
      workerId: z.string(),
      runnerId: z.string(),
      agentKind: HarnessAgentKindSchema(),
      leasedAt: z.string(),
      heartbeatAt: z.string().optional(),
      expiresAt: z.string().optional(),
    })
    .strict(),
)

export const TenantSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      name: z.string().default('local-tenant'),
      createdAt: z.string(),
    })
    .strict(),
)

export const RepoRegistrationSchema = lazySchema(() =>
  z
    .object({
      repoId: z.string(),
      repoRoot: z.string(),
      repoNameWithOwner: z.string().optional(),
      defaultBranch: z.string().optional(),
      desiredStateHash: z.string(),
      syncedAt: z.string(),
      maxParallelism: z.number().int().positive().default(4),
      remoteExecution: HarnessRemoteDispatchModeSchema().default('primary'),
      fleetTargetSlots: z.number().int().positive().default(4),
    })
    .strict(),
)

export const RepoHealthStateSchema = lazySchema(() =>
  z
    .object({
      repoId: z.string(),
      status: HarnessRepoHealthStatusSchema().default('healthy'),
      pauseReason: z.string().optional(),
      lastHealthyAt: z.string().optional(),
      lastFailureAt: z.string().optional(),
      lastAutoMergeHeadSha: z.string().optional(),
      lastAutoMergePrNumber: z.number().int().positive().optional(),
      lastObservedFailureHeadSha: z.string().optional(),
    })
    .strict(),
)

export const RunBudgetSchema = lazySchema(() =>
  z
    .object({
      repoId: z.string(),
      spentUsd: z.number().nonnegative().default(0),
      maxUsd: z.number().positive().default(25),
      warnUsd: z.number().positive().default(20),
      blocked: z.boolean().default(false),
      updatedAt: z.string().optional(),
    })
    .strict(),
)

export const ExecutionAttemptSchema = lazySchema(() =>
  z
    .object({
      attemptId: z.string(),
      jobInstanceId: z.string(),
      repoId: z.string(),
      workerId: z.string(),
      runnerId: z.string().default('default-runner'),
      agentKind: HarnessAgentKindSchema().default('claude'),
      executionBackend: HarnessExecutionBackendSchema(),
      startedAt: z.string(),
      completedAt: z.string().optional(),
      status: z.enum(['running', 'completed', 'failed', 'blocked']),
      totalCostUsd: z.number().nonnegative().default(0),
      summary: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .strict(),
)

export const WorkerHeartbeatSchema = lazySchema(() =>
  z
    .object({
      workerId: z.string(),
      pid: z.number().int().optional(),
      runnerId: z.string().default('default-runner'),
      agentKind: HarnessAgentKindSchema().default('claude'),
      labels: z.array(z.string()).default([]),
      slotCapacity: z.number().int().positive().default(1),
      healthy: z.boolean().default(true),
      lastHeartbeatAt: z.string(),
      observabilityEnvLoaded: z.boolean().default(false),
      lastTelemetryExportAt: z.string().optional(),
      repoId: z.string().optional(),
    })
    .strict(),
)

export const RunnerRegistrationSchema = lazySchema(() =>
  z
    .object({
      runnerId: z.string(),
      repoId: z.string().optional(),
      agentKind: HarnessAgentKindSchema().default('claude'),
      slotCapacity: z.number().int().positive().default(1),
      labels: z.array(z.string()).default([]),
      lastHeartbeatAt: z.string(),
      healthy: z.boolean().default(true),
      workerIds: z.array(z.string()).default([]),
      activeLeaseCount: z.number().int().nonnegative().default(0),
    })
    .strict(),
)

export const AgentSessionObservationSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      agentKind: HarnessAgentKindSchema(),
      sessionId: z.string(),
      jobInstanceId: z.string(),
      runnerId: z.string(),
      workerId: z.string(),
      executionBackend: HarnessExecutionBackendSchema(),
      model: z.string().optional(),
      result: z.enum(['success', 'failure', 'blocked']),
      failureTags: z.array(z.string()).default([]),
      humanTouchCount: z.number().int().nonnegative().default(0),
      toolCallCount: z.number().int().nonnegative().default(0),
      runtimeMs: z.number().nonnegative().default(0),
      tokenCost: z.number().nonnegative().default(0),
      summary: z.string().optional(),
      recordedAt: z.string(),
    })
    .strict(),
)

export const AgentSessionTrendSnapshotSchema = lazySchema(() =>
  z
    .object({
      totalObservationCount: z.number().int().nonnegative(),
      claudeObservationCount: z.number().int().nonnegative(),
      codexObservationCount: z.number().int().nonnegative(),
      successCount: z.number().int().nonnegative(),
      failureCount: z.number().int().nonnegative(),
      blockedCount: z.number().int().nonnegative(),
      repeatedFailureTags: z.array(z.string()).default([]),
      lastRecordedAt: z.string().optional(),
    })
    .strict(),
)

export const HarnessEventLedgerEntrySchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      eventName: z.string(),
      recordedAt: z.string(),
      repoId: z.string().optional(),
      runnerId: z.string().optional(),
      workerId: z.string().optional(),
      agentKind: HarnessAgentKindSchema().optional(),
      jobInstanceId: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const HarnessObservabilityHealthSchema = lazySchema(() =>
  z
    .object({
      internalQueryLive: z.boolean().default(true),
      honeycombExportLive: z.boolean().default(false),
      honeycombQueryLive: z.boolean().default(false),
      lastCheckedAt: z.string().optional(),
      exportLastSuccessAt: z.string().optional(),
      exportFresh: z.boolean().default(false),
      exportEndpoint: z.string().optional(),
      dataset: z.string().optional(),
      observabilityEnvLoadedWorkers: z.array(z.string()).default([]),
      telemetryStaleWorkers: z.array(z.string()).default([]),
    })
    .strict(),
)

export const BusinessArchetypeValues = [
  'saas',
  'agency',
  'ecommerce',
  'services',
  'media',
  'marketplace',
  'developer-tools',
  'community',
  'unknown',
] as const
export const BusinessArchetypeSchema = lazySchema(() =>
  z.enum(BusinessArchetypeValues),
)

export const PackKindValues = [
  'capability',
  'composite',
  'playbook',
] as const
export const PackKindSchema = lazySchema(() => z.enum(PackKindValues))

export const CompanySignalKindValues = ['website', 'social'] as const
export const CompanySignalKindSchema = lazySchema(() =>
  z.enum(CompanySignalKindValues),
)

export const StandingLaneTypeValues = [
  'GrowthLane',
  'ContentLane',
  'CustomerOpsLane',
  'BusinessOpsLane',
  'ExecutiveBriefLane',
] as const
export const StandingLaneTypeSchema = lazySchema(() =>
  z.enum(StandingLaneTypeValues),
)

export const StandingLaneCadenceValues = ['on-demand', 'daily', 'weekly'] as const
export const StandingLaneCadenceSchema = lazySchema(() =>
  z.enum(StandingLaneCadenceValues),
)

export const StandingLaneStatusValues = ['active', 'paused', 'retired'] as const
export const StandingLaneStatusSchema = lazySchema(() =>
  z.enum(StandingLaneStatusValues),
)

export const UsefulArtifactKindValues = [
  'company-brief',
  'market-map',
  'growth-plan',
  'content-backlog',
  'customer-ops-audit',
  'ops-playbook',
  'executive-brief',
  'implementation-artifact',
] as const
export const UsefulArtifactKindSchema = lazySchema(() =>
  z.enum(UsefulArtifactKindValues),
)

export const ConnectorPolicyStatusValues = [
  'recommended',
  'accepted',
  'connected',
  'dismissed',
] as const
export const ConnectorPolicyStatusSchema = lazySchema(() =>
  z.enum(ConnectorPolicyStatusValues),
)

export const OwnerTouchSourceValues = [
  'owner_message',
  'exception_resolution',
  'manual_override',
] as const
export const OwnerTouchSourceSchema = lazySchema(() =>
  z.enum(OwnerTouchSourceValues),
)

export const SpecialistAgentVisibilityValues = ['owner', 'internal'] as const
export const SpecialistAgentVisibilitySchema = lazySchema(() =>
  z.enum(SpecialistAgentVisibilityValues),
)

export const SpecialistAgentStatusValues = ['active', 'retired'] as const
export const SpecialistAgentStatusSchema = lazySchema(() =>
  z.enum(SpecialistAgentStatusValues),
)

export const PMDecisionTypeValues = [
  'onboard',
  'org_synthesis',
  'workstream_opened',
  'connector_recommendation',
  'owner_response',
  'gap_classification',
  'exception',
  'dogfood_program',
] as const
export const PMDecisionTypeSchema = lazySchema(() =>
  z.enum(PMDecisionTypeValues),
)

export const CompanyWorkstreamStatusValues = [
  'planned',
  'queued',
  'active',
  'blocked',
  'completed',
  'failed',
] as const
export const CompanyWorkstreamStatusSchema = lazySchema(() =>
  z.enum(CompanyWorkstreamStatusValues),
)

export const CompanyWorkstreamDomainValues = [
  'pm',
  'gtm',
  'content',
  'support',
  'ops',
  'finance-ops',
  'recruiting',
  'product',
  'engineering',
  'market-intel',
  'company-system',
] as const
export const CompanyWorkstreamDomainSchema = lazySchema(() =>
  z.enum(CompanyWorkstreamDomainValues),
)

export const CompanyExceptionSeverityValues = [
  'info',
  'warn',
  'high',
  'critical',
] as const
export const CompanyExceptionSeveritySchema = lazySchema(() =>
  z.enum(CompanyExceptionSeverityValues),
)

export const CompanyExceptionStatusValues = ['open', 'resolved'] as const
export const CompanyExceptionStatusSchema = lazySchema(() =>
  z.enum(CompanyExceptionStatusValues),
)

export const CompanyGapKindValues = ['product', 'pack', 'platform'] as const
export const CompanyGapKindSchema = lazySchema(() =>
  z.enum(CompanyGapKindValues),
)

export const CompanyGapStatusValues = ['open', 'resolved'] as const
export const CompanyGapStatusSchema = lazySchema(() =>
  z.enum(CompanyGapStatusValues),
)

export const ConnectorRecommendationStatusValues = [
  'pending',
  'accepted',
  'dismissed',
] as const
export const ConnectorRecommendationStatusSchema = lazySchema(() =>
  z.enum(ConnectorRecommendationStatusValues),
)

export const CompanySignalSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      kind: CompanySignalKindSchema(),
      sourceUrl: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      contentPreview: z.string().optional(),
      keywords: z.array(z.string()).default([]),
      fetchedAt: z.string(),
    })
    .strict(),
)

export const CompanyGraphSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      websiteUrl: z.string(),
      socialUrls: z.array(z.string()).default([]),
      normalizedHost: z.string(),
      companyName: z.string(),
      businessArchetype: BusinessArchetypeSchema().default('unknown'),
      summary: z.string().default(''),
      valueProps: z.array(z.string()).default([]),
      offers: z.array(z.string()).default([]),
      icpRoles: z.array(z.string()).default([]),
      demandChannels: z.array(z.string()).default([]),
      supportSurfaces: z.array(z.string()).default([]),
      operationalNeeds: z.array(z.string()).default([]),
      technicalSignals: z.array(z.string()).default([]),
      evidence: z.array(z.string()).default([]),
      signals: z.array(CompanySignalSchema()).default([]),
      createdAt: z.string(),
      updatedAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const OperatingModelSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      businessArchetype: BusinessArchetypeSchema().default('unknown'),
      offers: z.array(z.string()).default([]),
      buyerRoles: z.array(z.string()).default([]),
      coreChannels: z.array(z.string()).default([]),
      operationalSurfaces: z.array(z.string()).default([]),
      recurringLaneNeeds: z.array(StandingLaneTypeSchema()).default([]),
      evidence: z.array(z.string()).default([]),
      confidence: z
        .object({
          archetype: z.number().min(0).max(1).default(0.5),
          offers: z.number().min(0).max(1).default(0.5),
          buyers: z.number().min(0).max(1).default(0.5),
          channels: z.number().min(0).max(1).default(0.5),
          operations: z.number().min(0).max(1).default(0.5),
          technical: z.number().min(0).max(1).default(0.5),
        })
        .strict()
        .default({
          archetype: 0.5,
          offers: 0.5,
          buyers: 0.5,
          channels: 0.5,
          operations: 0.5,
          technical: 0.5,
        }),
      createdAt: z.string(),
      updatedAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const PackManifestSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      title: z.string(),
      kind: PackKindSchema(),
      domain: CompanyWorkstreamDomainSchema(),
      summary: z.string(),
      supportedLaneTypes: z.array(StandingLaneTypeSchema()).default([]),
      runtimeOwner: HarnessAgentKindSchema().default('claude'),
      runtimeSupport: z.array(HarnessAgentKindSchema()).default(['claude']),
      requiredConnectors: z.array(z.string()).default([]),
      triggers: z.array(z.string()).default([]),
      dependencies: z.array(z.string()).default([]),
      expectedArtifactKinds: z.array(UsefulArtifactKindSchema()).default([]),
      validationRules: z.array(z.string()).default([]),
      qualityScore: z.number().min(0).max(1).default(0.7),
      defaultObjective: z.string(),
    })
    .strict(),
)

export const StandingLaneSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      type: StandingLaneTypeSchema(),
      title: z.string(),
      domain: CompanyWorkstreamDomainSchema(),
      objective: z.string(),
      cadence: StandingLaneCadenceSchema().default('weekly'),
      inputs: z.array(z.string()).default([]),
      connectorIds: z.array(z.string()).default([]),
      expectedArtifactKinds: z.array(UsefulArtifactKindSchema()).default([]),
      escalationPolicy: z.string().default('exception-only'),
      successCriteria: z.array(z.string()).default([]),
      ownerAgentId: z.string(),
      runtimeOwner: HarnessAgentKindSchema().default('claude'),
      packIds: z.array(z.string()).default([]),
      status: StandingLaneStatusSchema().default('active'),
      createdAt: z.string(),
      updatedAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const LaneRunSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      laneId: z.string(),
      workstreamId: z.string(),
      jobInstanceId: z.string().optional(),
      status: z.enum(['queued', 'active', 'blocked', 'completed', 'failed']),
      usefulArtifactId: z.string().optional(),
      usefulOutput: z.boolean().default(false),
      ownerTouchRequired: z.boolean().default(false),
      startedAt: z.string(),
      completedAt: z.string().optional(),
      outcomeSummary: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const UsefulArtifactSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      laneId: z.string(),
      runId: z.string(),
      workstreamId: z.string(),
      artifactKind: UsefulArtifactKindSchema(),
      title: z.string(),
      summary: z.string(),
      content: z.string().optional(),
      outputPath: z.string().optional(),
      usefulOutput: z.boolean().default(true),
      ownerTouchRequired: z.boolean().default(false),
      createdAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const SpecialistAgentRoleSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      name: z.string(),
      title: z.string(),
      domain: CompanyWorkstreamDomainSchema(),
      objective: z.string(),
      agentKind: HarnessAgentKindSchema().default('claude'),
      visibility: SpecialistAgentVisibilitySchema().default('internal'),
      status: SpecialistAgentStatusSchema().default('active'),
      capabilities: z.array(z.string()).default([]),
      packIds: z.array(z.string()).default([]),
      createdBy: z.literal('pm').default('pm'),
      createdAt: z.string(),
      retiredAt: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const DynamicOrgSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      pmAgentId: z.string(),
      roles: z.array(SpecialistAgentRoleSchema()).default([]),
      rationale: z.string().default(''),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .strict(),
)

export const CompanyMetricsSchema = lazySchema(() =>
  z
    .object({
      ownerTouchCount: z.number().int().nonnegative().default(0),
      pmCreatedAgentCount: z.number().int().nonnegative().default(0),
      pmRetiredAgentCount: z.number().int().nonnegative().default(0),
      activeLaneCount: z.number().int().nonnegative().default(0),
      workstreamSuccessCount: z.number().int().nonnegative().default(0),
      workstreamFailureCount: z.number().int().nonnegative().default(0),
      usefulArtifactCount: z.number().int().nonnegative().default(0),
      usefulArtifactsThisWeek: z.number().int().nonnegative().default(0),
      recurringLaneCompletionRate: z.number().min(0).max(1).default(0),
      firstUsefulOutputAt: z.string().optional(),
      repeatedExceptionCount: z.number().int().nonnegative().default(0),
      platformGapCount: z.number().int().nonnegative().default(0),
      packGapCount: z.number().int().nonnegative().default(0),
      productGapCount: z.number().int().nonnegative().default(0),
      domainSuccessCounts: z.record(z.string(), z.number().int()).default({}),
      executionFailureCountsByRuntime: z
        .record(z.string(), z.number().int())
        .default({}),
    })
    .strict(),
)

export const ConnectorUnlockRecommendationSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      connector: z.string(),
      reason: z.string(),
      unlocks: z.array(z.string()).default([]),
      status: ConnectorRecommendationStatusSchema().default('pending'),
      recommendedAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const ConnectorPolicySchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      connector: z.string(),
      status: ConnectorPolicyStatusSchema().default('recommended'),
      autonomyMode: z.literal('exception-only').default('exception-only'),
      reason: z.string(),
      laneTypes: z.array(StandingLaneTypeSchema()).default([]),
      createdAt: z.string(),
      updatedAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const OwnerTouchMetricSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      laneId: z.string().optional(),
      workstreamId: z.string().optional(),
      source: OwnerTouchSourceSchema(),
      recordedAt: z.string(),
      summary: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const PMDecisionSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      type: PMDecisionTypeSchema(),
      summary: z.string(),
      rationale: z.string().default(''),
      linkedWorkstreamId: z.string().optional(),
      linkedGapId: z.string().optional(),
      linkedExceptionId: z.string().optional(),
      createdAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const OwnerMessageSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      text: z.string(),
      createdAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const WorkstreamSpecSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      title: z.string(),
      domain: CompanyWorkstreamDomainSchema(),
      objective: z.string(),
      ownerAgentId: z.string(),
      preferredAgentKind: HarnessAgentKindSchema().default('claude'),
      status: CompanyWorkstreamStatusSchema().default('planned'),
      packIds: z.array(z.string()).default([]),
      laneId: z.string().optional(),
      jobId: z.string(),
      jobInstanceId: z.string().optional(),
      summary: z.string().optional(),
      lastOutcome: z.string().optional(),
      latestArtifactId: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
      completedAt: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const OwnerExceptionSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      severity: CompanyExceptionSeveritySchema().default('warn'),
      title: z.string(),
      summary: z.string(),
      status: CompanyExceptionStatusSchema().default('open'),
      requiresOwner: z.boolean().default(true),
      createdAt: z.string(),
      resolvedAt: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const ExecutionGapSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      companyId: z.string(),
      laneId: z.string().optional(),
      workstreamId: z.string().optional(),
      kind: CompanyGapKindSchema(),
      status: CompanyGapStatusSchema().default('open'),
      summary: z.string(),
      sourceJobInstanceId: z.string().optional(),
      createdAt: z.string(),
      resolvedAt: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)
export const CompanyGapSchema = ExecutionGapSchema

export const CompanyRecordSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      websiteUrl: z.string(),
      socialUrls: z.array(z.string()).default([]),
      companyName: z.string(),
      businessArchetype: BusinessArchetypeSchema().default('unknown'),
      pmAgentId: z.string(),
      graph: CompanyGraphSchema(),
      operatingModelId: z.string().optional(),
      org: DynamicOrgSchema(),
      activePackIds: z.array(z.string()).default([]),
      standingLaneIds: z.array(z.string()).default([]),
      laneRunIds: z.array(z.string()).default([]),
      workstreamIds: z.array(z.string()).default([]),
      usefulArtifactIds: z.array(z.string()).default([]),
      exceptionIds: z.array(z.string()).default([]),
      gapIds: z.array(z.string()).default([]),
      ownerMessageIds: z.array(z.string()).default([]),
      ownerTouchMetricIds: z.array(z.string()).default([]),
      pmDecisionIds: z.array(z.string()).default([]),
      connectorRecommendationIds: z.array(z.string()).default([]),
      connectorPolicyIds: z.array(z.string()).default([]),
      metrics: CompanyMetricsSchema().default({
        ownerTouchCount: 0,
        pmCreatedAgentCount: 0,
        pmRetiredAgentCount: 0,
        activeLaneCount: 0,
        workstreamSuccessCount: 0,
        workstreamFailureCount: 0,
        usefulArtifactCount: 0,
        usefulArtifactsThisWeek: 0,
        recurringLaneCompletionRate: 0,
        repeatedExceptionCount: 0,
        platformGapCount: 0,
        packGapCount: 0,
        productGapCount: 0,
        domainSuccessCounts: {},
        executionFailureCountsByRuntime: {},
      }),
      createdAt: z.string(),
      updatedAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const CompanyOpsStateSchema = lazySchema(() =>
  z
    .object({
      companies: z.record(z.string(), CompanyRecordSchema()).default({}),
      operatingModels: z.record(z.string(), OperatingModelSchema()).default({}),
      standingLanes: z.record(z.string(), StandingLaneSchema()).default({}),
      laneRuns: z.record(z.string(), LaneRunSchema()).default({}),
      workstreams: z.record(z.string(), WorkstreamSpecSchema()).default({}),
      usefulArtifacts: z.record(z.string(), UsefulArtifactSchema()).default({}),
      ownerMessages: z.record(z.string(), OwnerMessageSchema()).default({}),
      ownerTouchMetrics: z.record(z.string(), OwnerTouchMetricSchema()).default({}),
      pmDecisions: z.record(z.string(), PMDecisionSchema()).default({}),
      exceptions: z.record(z.string(), OwnerExceptionSchema()).default({}),
      connectorRecommendations: z
        .record(z.string(), ConnectorUnlockRecommendationSchema())
        .default({}),
      connectorPolicies: z.record(z.string(), ConnectorPolicySchema()).default({}),
      gaps: z.record(z.string(), CompanyGapSchema()).default({}),
    })
    .strict(),
)

export const MissionControlPackStatusValues = [
  'active',
  'available',
  'deferred',
] as const
export const MissionControlPackStatusSchema = lazySchema(() =>
  z.enum(MissionControlPackStatusValues),
)

export const MissionControlPackViewSchema = lazySchema(() =>
  z
    .object({
      pack: PackManifestSchema(),
      status: MissionControlPackStatusSchema(),
      reason: z.string(),
    })
    .strict(),
)

export const MissionControlWorkstreamCardSchema = lazySchema(() =>
  z
    .object({
      workstream: WorkstreamSpecSchema(),
      ownerRole: SpecialistAgentRoleSchema().nullable(),
      latestSummary: z.string().optional(),
      linkedGapId: z.string().optional(),
      linkedExceptionId: z.string().optional(),
    })
    .strict(),
)

export const PMSnapshotSchema = lazySchema(() =>
  z
    .object({
      agent: SpecialistAgentRoleSchema().nullable(),
      recentDecisions: z.array(PMDecisionSchema()).default([]),
      recentMessages: z.array(OwnerMessageSchema()).default([]),
    })
    .strict(),
)

export const MissionControlMetricsSchema = lazySchema(() =>
  z
    .object({
      ownerTouchCount: z.number().int().nonnegative().default(0),
      pmCreatedAgentCount: z.number().int().nonnegative().default(0),
      pmRetiredAgentCount: z.number().int().nonnegative().default(0),
      standingLaneCount: z.number().int().nonnegative().default(0),
      activeWorkstreamCount: z.number().int().nonnegative().default(0),
      usefulArtifactCount: z.number().int().nonnegative().default(0),
      usefulArtifactsThisWeek: z.number().int().nonnegative().default(0),
      recurringLaneCompletionRate: z.number().min(0).max(1).default(0),
      openExceptionCount: z.number().int().nonnegative().default(0),
      firstUsefulOutputAt: z.string().optional(),
      gapCounts: z
        .object({
          product: z.number().int().nonnegative().default(0),
          pack: z.number().int().nonnegative().default(0),
          platform: z.number().int().nonnegative().default(0),
        })
        .strict()
        .default({
          product: 0,
          pack: 0,
          platform: 0,
        }),
      successCountsByDomain: z.record(z.string(), z.number().int()).default({}),
      executionFailureCountsByRuntime: z
        .record(z.string(), z.number().int())
        .default({}),
    })
    .strict(),
)

export const MissionControlStandingLaneCardSchema = lazySchema(() =>
  z
    .object({
      lane: StandingLaneSchema(),
      ownerRole: SpecialistAgentRoleSchema().nullable(),
      latestArtifact: UsefulArtifactSchema().nullable(),
      activeWorkstream: WorkstreamSpecSchema().nullable(),
      nextScheduledAt: z.string().optional(),
      connectorReadiness: z.enum(['ready', 'recommended', 'blocked']).default('ready'),
    })
    .strict(),
)

export const MissionControlSnapshotSchema = lazySchema(() =>
  z
    .object({
      company: CompanyRecordSchema().nullable(),
      operatingModel: OperatingModelSchema().nullable().default(null),
      pm: PMSnapshotSchema().nullable(),
      specialists: z.array(SpecialistAgentRoleSchema()).default([]),
      standingLanes: z.array(MissionControlStandingLaneCardSchema()).default([]),
      workstreams: z.array(MissionControlWorkstreamCardSchema()).default([]),
      usefulArtifacts: z.array(UsefulArtifactSchema()).default([]),
      exceptions: z.array(OwnerExceptionSchema()).default([]),
      gaps: z.array(CompanyGapSchema()).default([]),
      connectorRecommendations: z
        .array(ConnectorUnlockRecommendationSchema())
        .default([]),
      connectorPolicies: z.array(ConnectorPolicySchema()).default([]),
      packs: z.array(MissionControlPackViewSchema()).default([]),
      metrics: MissionControlMetricsSchema(),
      observability: HarnessObservabilityHealthSchema(),
      summary: z.string().default(''),
    })
    .strict(),
)

export const LoadMissionControlActionSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('load_snapshot'),
      companyId: z.string().optional(),
    })
    .strict(),
)

export const SendPmMessageActionSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('send_pm_message'),
      companyId: z.string().optional(),
      text: z.string().min(1),
    })
    .strict(),
)

export const RefreshCompanyBriefActionSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('refresh_brief'),
      companyId: z.string().optional(),
    })
    .strict(),
)

export const ResolveOwnerExceptionActionSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('resolve_exception'),
      companyId: z.string().optional(),
      exceptionId: z.string(),
      resolution: z.string().optional(),
    })
    .strict(),
)

export const UpdateConnectorRecommendationActionSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('update_connector_recommendation'),
      companyId: z.string().optional(),
      recommendationId: z.string(),
      status: z.enum(['accepted', 'dismissed']),
    })
    .strict(),
)

export const MissionControlActionTypeSchema = lazySchema(() =>
  z.enum([
    'load_snapshot',
    'send_pm_message',
    'refresh_brief',
    'resolve_exception',
    'update_connector_recommendation',
  ]),
)

export const MissionControlActionSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    LoadMissionControlActionSchema(),
    SendPmMessageActionSchema(),
    RefreshCompanyBriefActionSchema(),
    ResolveOwnerExceptionActionSchema(),
    UpdateConnectorRecommendationActionSchema(),
  ]),
)

export const MissionControlActionResultSchema = lazySchema(() =>
  z
    .object({
      actionType: MissionControlActionTypeSchema(),
      snapshot: MissionControlSnapshotSchema(),
      response: z.string().optional(),
    })
    .strict(),
)

export const HarnessQualitySeverityValues = [
  'low',
  'medium',
  'high',
  'critical',
] as const
export const HarnessQualitySeveritySchema = lazySchema(() =>
  z.enum(HarnessQualitySeverityValues),
)

export const DefectFindingSourceValues = [
  'cc-reviewer',
  'github-review',
  'github-ci',
  'gstack-review',
  'gstack-qa',
  'manual',
] as const
export const DefectFindingSourceSchema = lazySchema(() =>
  z.enum(DefectFindingSourceValues),
)

export const DeploymentVerificationSourceValues = [
  'cc-auto-merge',
  'gstack-land-and-deploy',
  'gstack-canary',
  'manual',
] as const
export const DeploymentVerificationSourceSchema = lazySchema(() =>
  z.enum(DeploymentVerificationSourceValues),
)

export const DeploymentVerificationStatusValues = [
  'healthy',
  'degraded',
  'broken',
  'failed',
  'skipped',
  'reverted',
] as const
export const DeploymentVerificationStatusSchema = lazySchema(() =>
  z.enum(DeploymentVerificationStatusValues),
)

export const IncidentSourceValues = [
  'deploy_verification',
  'canary',
  'revert',
  'default_branch_failure',
  'manual',
] as const
export const IncidentSourceSchema = lazySchema(() =>
  z.enum(IncidentSourceValues),
)

export const IncidentStatusValues = ['open', 'resolved'] as const
export const IncidentStatusSchema = lazySchema(() =>
  z.enum(IncidentStatusValues),
)

export const RecoverySourceValues = ['revert', 'fix_deploy', 'manual'] as const
export const RecoverySourceSchema = lazySchema(() =>
  z.enum(RecoverySourceValues),
)

export const PullRequestQualityRecordSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      repoNameWithOwner: z.string().optional(),
      prNumber: z.number().int().positive(),
      title: z.string().default(''),
      url: z.string().optional(),
      state: z.enum(['open', 'merged', 'closed', 'unknown']).default('unknown'),
      headSha: z.string().optional(),
      headRefName: z.string().optional(),
      baseRefName: z.string().optional(),
      mergeSha: z.string().optional(),
      mergedAt: z.string().optional(),
      changedFiles: z.number().int().nonnegative().default(0),
      additions: z.number().int().nonnegative().default(0),
      deletions: z.number().int().nonnegative().default(0),
      latestReviewDecision: z.string().optional(),
      logicalChangeSizeId: z.string().optional(),
      findingIds: z.array(z.string()).default([]),
      deploymentIds: z.array(z.string()).default([]),
      incidentIds: z.array(z.string()).default([]),
      recoveryIds: z.array(z.string()).default([]),
      revertIds: z.array(z.string()).default([]),
      createdAt: z.string(),
      updatedAt: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const DefectFindingSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      prNumber: z.number().int().positive(),
      mergeSha: z.string().optional(),
      headSha: z.string().optional(),
      source: DefectFindingSourceSchema(),
      severity: HarnessQualitySeveritySchema(),
      category: z.string().default('general'),
      summary: z.string(),
      detectedAt: z.string(),
      preMerge: z.boolean().default(true),
      escaped: z.boolean().default(false),
      count: z.number().int().positive().default(1),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const DeploymentVerificationSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      prNumber: z.number().int().positive(),
      mergeSha: z.string().optional(),
      source: DeploymentVerificationSourceSchema(),
      status: DeploymentVerificationStatusSchema(),
      verifiedAt: z.string(),
      deployStartedAt: z.string().optional(),
      durationSeconds: z.number().nonnegative().optional(),
      summary: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const PostMergeIncidentSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      prNumber: z.number().int().positive(),
      mergeSha: z.string().optional(),
      source: IncidentSourceSchema(),
      severity: HarnessQualitySeveritySchema(),
      status: IncidentStatusSchema().default('open'),
      detectedAt: z.string(),
      summary: z.string(),
      relatedDeploymentId: z.string().optional(),
      manual: z.boolean().default(false),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const RecoveryEventSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      prNumber: z.number().int().positive(),
      incidentId: z.string(),
      mergeSha: z.string().optional(),
      source: RecoverySourceSchema(),
      recoveredAt: z.string(),
      summary: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const RevertLinkSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      prNumber: z.number().int().positive(),
      mergeSha: z.string().optional(),
      revertCommitSha: z.string().optional(),
      revertPrNumber: z.number().int().positive().optional(),
      detectedAt: z.string(),
      summary: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const LogicalChangeSizeSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      prNumber: z.number().int().positive(),
      additions: z.number().int().nonnegative().default(0),
      deletions: z.number().int().nonnegative().default(0),
      changedFiles: z.number().int().nonnegative().default(0),
      includedFiles: z.number().int().nonnegative().default(0),
      excludedFiles: z.number().int().nonnegative().default(0),
      weightedSize: z.number().nonnegative().default(0),
      categoryWeights: z.record(z.string(), z.number()).default({}),
      computedAt: z.string(),
    })
    .strict(),
)

export const RepoQualitySnapshotSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      repoId: z.string(),
      generatedAt: z.string(),
      windowDays: z.number().int().positive(),
      deployedPrCount: z.number().int().nonnegative().default(0),
      preMergeFindingCount: z.number().int().nonnegative().default(0),
      postMergeIncidentCount: z.number().int().nonnegative().default(0),
      revertCount: z.number().int().nonnegative().default(0),
      manualIncidentCount: z.number().int().nonnegative().default(0),
      escapedBugRate: z.number().nonnegative().default(0),
      changeFailureRate: z.number().nonnegative().default(0),
      meanTimeToDetectMs: z.number().nonnegative().default(0),
      meanTimeToRecoverMs: z.number().nonnegative().default(0),
      preMergeDefectDensity: z.number().nonnegative().default(0),
      escapedDefectDensity: z.number().nonnegative().default(0),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
)

export const HarnessQualityStateSchema = lazySchema(() =>
  z
    .object({
      pullRequests: z.record(z.string(), PullRequestQualityRecordSchema()).default({}),
      findings: z.record(z.string(), DefectFindingSchema()).default({}),
      deployments: z.record(z.string(), DeploymentVerificationSchema()).default({}),
      incidents: z.record(z.string(), PostMergeIncidentSchema()).default({}),
      recoveries: z.record(z.string(), RecoveryEventSchema()).default({}),
      reverts: z.record(z.string(), RevertLinkSchema()).default({}),
      logicalChangeSizes: z.record(z.string(), LogicalChangeSizeSchema()).default({}),
      snapshots: z.record(z.string(), RepoQualitySnapshotSchema()).default({}),
    })
    .strict(),
)

export const HarnessRuntimeStateSchema = lazySchema(() =>
  z
    .object({
      version: z.enum(['1', '2']).default('2'),
      tenant: TenantSchema()
        .default({
          id: 'local-tenant',
          name: 'local-tenant',
          createdAt: new Date(0).toISOString(),
        }),
      paused: z.boolean().default(false),
      pauseReason: z.string().optional(),
      lastPolledAt: z.string().optional(),
      queue: z.array(z.string()).default([]),
      jobs: z.record(z.string(), QueuedHarnessJobSchema()).default({}),
      leases: z.record(z.string(), HarnessLeaseSchema()).default({}),
      repos: z.record(z.string(), RepoRegistrationSchema()).default({}),
      repoHealth: z.record(z.string(), RepoHealthStateSchema()).default({}),
      budgets: z.record(z.string(), RunBudgetSchema()).default({}),
      attempts: z.record(z.string(), ExecutionAttemptSchema()).default({}),
      runners: z.record(z.string(), RunnerRegistrationSchema()).default({}),
      workerHeartbeats: z.record(z.string(), WorkerHeartbeatSchema()).default({}),
      agentSessions: z
        .record(z.string(), AgentSessionObservationSchema())
        .default({}),
      eventLedger: z.array(HarnessEventLedgerEntrySchema()).default([]),
      observability: HarnessObservabilityHealthSchema().default({
        internalQueryLive: true,
        honeycombExportLive: false,
        honeycombQueryLive: false,
        exportFresh: false,
        observabilityEnvLoadedWorkers: [],
        telemetryStaleWorkers: [],
      }),
      companyOps: CompanyOpsStateSchema().default({
        companies: {},
        operatingModels: {},
        standingLanes: {},
        laneRuns: {},
        workstreams: {},
        usefulArtifacts: {},
        ownerMessages: {},
        ownerTouchMetrics: {},
        pmDecisions: {},
        exceptions: {},
        connectorRecommendations: {},
        connectorPolicies: {},
        gaps: {},
      }),
      quality: HarnessQualityStateSchema().default({
        pullRequests: {},
        findings: {},
        deployments: {},
        incidents: {},
        recoveries: {},
        reverts: {},
        logicalChangeSizes: {},
        snapshots: {},
      }),
      sourceCursors: z
        .object({
          githubPrHeads: z.record(z.string(), z.string()).default({}),
          cronFires: z.record(z.string(), z.string()).default({}),
          remoteEvents: z.record(z.string(), z.string()).default({}),
          defaultBranches: z.record(z.string(), z.string()).default({}),
          defaultBranchHeads: z.record(z.string(), z.string()).default({}),
          failingRunKeys: z.record(z.string(), z.string()).default({}),
        })
        .strict()
        .default({
          githubPrHeads: {},
          cronFires: {},
          remoteEvents: {},
          defaultBranches: {},
          defaultBranchHeads: {},
          failingRunKeys: {},
        }),
      remoteMirror: z.record(z.string(), z.string()).default({}),
      history: z.array(JobOutcomeSchema()).default([]),
      learning: z
        .object({
          reviewerFindings: z.record(z.string(), z.number().int()).default({}),
          failureReasons: z.record(z.string(), z.number().int()).default({}),
          humanTouches: z.number().int().nonnegative().default(0),
          mergeRegressions: z.number().int().nonnegative().default(0),
          autoMerges: z.number().int().nonnegative().default(0),
        })
        .strict()
        .default({
          reviewerFindings: {},
          failureReasons: {},
          humanTouches: 0,
          mergeRegressions: 0,
          autoMerges: 0,
        }),
      daemon: z
        .object({
          pid: z.number().int().optional(),
          startedAt: z.string().optional(),
          lastHeartbeatAt: z.string().optional(),
        })
        .strict()
        .default({}),
    })
    .strict(),
)

export type WorkSourceSpec = z.infer<ReturnType<typeof WorkSourceSpecSchema>>
export type HarnessExecutionMode = z.infer<
  ReturnType<typeof HarnessExecutionModeSchema>
>
export type HarnessAgentKind = z.infer<ReturnType<typeof HarnessAgentKindSchema>>
export type HarnessExecutionBackend = z.infer<
  ReturnType<typeof HarnessExecutionBackendSchema>
>
export type HarnessQualitySeverity = z.infer<
  ReturnType<typeof HarnessQualitySeveritySchema>
>
export type JobSpec = z.infer<ReturnType<typeof JobSpecSchema>>
export type ReviewerSpec = z.infer<ReturnType<typeof ReviewerSpecSchema>>
export type AutonomyPolicy = z.infer<ReturnType<typeof AutonomyPolicySchema>>
export type ReviewDecision = z.infer<ReturnType<typeof ReviewDecisionSchema>>
export type Tenant = z.infer<ReturnType<typeof TenantSchema>>
export type RepoRegistration = z.infer<ReturnType<typeof RepoRegistrationSchema>>
export type RepoHealthState = z.infer<ReturnType<typeof RepoHealthStateSchema>>
export type RunBudget = z.infer<ReturnType<typeof RunBudgetSchema>>
export type ExecutionAttempt = z.infer<
  ReturnType<typeof ExecutionAttemptSchema>
>
export type RunnerRegistration = z.infer<
  ReturnType<typeof RunnerRegistrationSchema>
>
export type AgentSessionObservation = z.infer<
  ReturnType<typeof AgentSessionObservationSchema>
>
export type AgentSessionTrendSnapshot = z.infer<
  ReturnType<typeof AgentSessionTrendSnapshotSchema>
>
export type HarnessEventLedgerEntry = z.infer<
  ReturnType<typeof HarnessEventLedgerEntrySchema>
>
export type HarnessObservabilityHealth = z.infer<
  ReturnType<typeof HarnessObservabilityHealthSchema>
>
export type BusinessArchetype = z.infer<
  ReturnType<typeof BusinessArchetypeSchema>
>
export type PackManifest = z.infer<ReturnType<typeof PackManifestSchema>>
export type CompanySignal = z.infer<ReturnType<typeof CompanySignalSchema>>
export type CompanyGraph = z.infer<ReturnType<typeof CompanyGraphSchema>>
export type OperatingModel = z.infer<ReturnType<typeof OperatingModelSchema>>
export type StandingLane = z.infer<ReturnType<typeof StandingLaneSchema>>
export type LaneRun = z.infer<ReturnType<typeof LaneRunSchema>>
export type UsefulArtifact = z.infer<ReturnType<typeof UsefulArtifactSchema>>
export type SpecialistAgentRole = z.infer<
  ReturnType<typeof SpecialistAgentRoleSchema>
>
export type DynamicOrg = z.infer<ReturnType<typeof DynamicOrgSchema>>
export type CompanyMetrics = z.infer<ReturnType<typeof CompanyMetricsSchema>>
export type ConnectorUnlockRecommendation = z.infer<
  ReturnType<typeof ConnectorUnlockRecommendationSchema>
>
export type ConnectorPolicy = z.infer<ReturnType<typeof ConnectorPolicySchema>>
export type PMDecision = z.infer<ReturnType<typeof PMDecisionSchema>>
export type OwnerMessage = z.infer<ReturnType<typeof OwnerMessageSchema>>
export type OwnerTouchMetric = z.infer<
  ReturnType<typeof OwnerTouchMetricSchema>
>
export type WorkstreamSpec = z.infer<ReturnType<typeof WorkstreamSpecSchema>>
export type OwnerException = z.infer<ReturnType<typeof OwnerExceptionSchema>>
export type ExecutionGap = z.infer<ReturnType<typeof ExecutionGapSchema>>
export type CompanyGap = z.infer<ReturnType<typeof CompanyGapSchema>>
export type CompanyRecord = z.infer<ReturnType<typeof CompanyRecordSchema>>
export type CompanyOpsState = z.infer<ReturnType<typeof CompanyOpsStateSchema>>
export type MissionControlPackView = z.infer<
  ReturnType<typeof MissionControlPackViewSchema>
>
export type MissionControlStandingLaneCard = z.infer<
  ReturnType<typeof MissionControlStandingLaneCardSchema>
>
export type MissionControlWorkstreamCard = z.infer<
  ReturnType<typeof MissionControlWorkstreamCardSchema>
>
export type PMSnapshot = z.infer<ReturnType<typeof PMSnapshotSchema>>
export type MissionControlMetrics = z.infer<
  ReturnType<typeof MissionControlMetricsSchema>
>
export type MissionControlSnapshot = z.infer<
  ReturnType<typeof MissionControlSnapshotSchema>
>
export type MissionControlAction = z.infer<
  ReturnType<typeof MissionControlActionSchema>
>
export type MissionControlActionResult = z.infer<
  ReturnType<typeof MissionControlActionResultSchema>
>
export type PullRequestQualityRecord = z.infer<
  ReturnType<typeof PullRequestQualityRecordSchema>
>
export type DefectFinding = z.infer<ReturnType<typeof DefectFindingSchema>>
export type DeploymentVerification = z.infer<
  ReturnType<typeof DeploymentVerificationSchema>
>
export type PostMergeIncident = z.infer<
  ReturnType<typeof PostMergeIncidentSchema>
>
export type RecoveryEvent = z.infer<ReturnType<typeof RecoveryEventSchema>>
export type RevertLink = z.infer<ReturnType<typeof RevertLinkSchema>>
export type LogicalChangeSize = z.infer<
  ReturnType<typeof LogicalChangeSizeSchema>
>
export type RepoQualitySnapshot = z.infer<
  ReturnType<typeof RepoQualitySnapshotSchema>
>
export type HarnessQualityState = z.infer<
  ReturnType<typeof HarnessQualityStateSchema>
>
export type VerificationResult = z.infer<
  ReturnType<typeof VerificationResultSchema>
>
export type JobOutcome = z.infer<ReturnType<typeof JobOutcomeSchema>>
export type LearningConfig = z.infer<ReturnType<typeof LearningConfigSchema>>
export type HarnessConfig = z.infer<ReturnType<typeof HarnessConfigSchema>>
export type RemoteTriggerEvent = z.infer<
  ReturnType<typeof RemoteTriggerEventSchema>
>
export type QueuedHarnessJob = z.infer<
  ReturnType<typeof QueuedHarnessJobSchema>
>
export type HarnessLease = z.infer<ReturnType<typeof HarnessLeaseSchema>>
export type HarnessRuntimeState = z.infer<
  ReturnType<typeof HarnessRuntimeStateSchema>
>
