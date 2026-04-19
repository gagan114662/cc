import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readEmployeeConfig } from 'src/utils/employeeConfig.js'
import { safeParseJSON } from 'src/utils/json.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { EmployeeDuty } from 'src/types/employee.js'
import {
  type HarnessConfig,
  HarnessConfigSchema,
  type JobSpec,
  type ReviewerSpec,
} from './types.js'

const HARNESS_CONFIG_RELATIVE_PATH = path.join('.claude', 'harness.json')

const BUILTIN_REVIEWERS: ReviewerSpec[] = [
  {
    id: 'scope',
    title: 'Scope reviewer',
    kind: 'builtin',
    blocking: true,
    policyTags: ['mergeability', 'scope'],
    appliesToKinds: ['review', 'repair', 'maintenance', 'implementation'],
    instructions:
      'Block oversized or draft work, and keep diffs narrow enough to merge safely.',
  },
  {
    id: 'reliability',
    title: 'Reliability reviewer',
    kind: 'builtin',
    blocking: true,
    policyTags: ['ci', 'verification', 'mainline-health'],
    appliesToKinds: ['review', 'repair', 'maintenance', 'implementation'],
    instructions:
      'Require passing verification commands and healthy pull request checks before merge.',
  },
  {
    id: 'security',
    title: 'Security reviewer',
    kind: 'builtin',
    blocking: true,
    policyTags: ['security'],
    appliesToKinds: ['review', 'repair', 'implementation'],
    instructions:
      'Block obvious secrets exposure or dangerous permission/config changes, and warn on sensitive surfaces.',
  },
  {
    id: 'test-quality',
    title: 'Test quality reviewer',
    kind: 'builtin',
    blocking: true,
    policyTags: ['testing'],
    appliesToKinds: ['review', 'repair', 'implementation'],
    instructions:
      'Require meaningful verification for code-producing work and flag suspiciously untested diffs.',
  },
  {
    id: 'release-readiness',
    title: 'Release readiness reviewer',
    kind: 'builtin',
    blocking: true,
    policyTags: ['release', 'mergeability'],
    appliesToKinds: ['review', 'repair', 'maintenance', 'implementation'],
    instructions:
      'Block drafts, merge conflicts, or release blockers that would make unattended merge unsafe.',
  },
]

const DEFAULT_JOBS: JobSpec[] = [
  {
    id: 'pr-review-on-push',
    title: 'PR review on push',
    description:
      'Run built-in reviewer suites whenever an open pull request receives a new commit.',
    kind: 'review',
    agentKind: 'claude',
    executionMode: 'review-only',
    codeChangePolicy: 'review-only',
    promptTemplate:
      'Review pull request #{{prNumber}} ({{prUrl}}) at head {{headSha}}. Summarize the state, note any blockers, and prepare the branch for unattended merge if all reviewer suites pass.',
    targetAgent: 'engineering-lead',
    concurrencyKey: 'github-pr-{{prNumber}}',
    autoCommit: false,
    autoMerge: true,
    priority: 70,
    timeoutSeconds: 1200,
    maxParallelism: 40,
    repoHealthImpact: 'safe',
    retryPolicy: {
      maxAttempts: 1,
      backoffSeconds: 0,
    },
    budget: {
      maxUsd: 10,
      warnUsd: 8,
      defaultAttemptUsd: 0.15,
    },
    escalationPolicy: {
      onFailure: 'retry',
      onBudgetExceeded: 'pause_repo',
      notify: [],
    },
    verification: {
      commands: [],
      requirePassing: true,
    },
    reviewerSuites: [
      'scope',
      'reliability',
      'security',
      'test-quality',
      'release-readiness',
    ],
    sourceBindings: [
      {
        type: 'github',
        event: 'pull_request_opened',
      },
      {
        type: 'github',
        event: 'pull_request_push',
      },
      {
        type: 'github',
        event: 'pull_request_reopened',
      },
    ],
  },
  {
    id: 'red-main-repair',
    title: 'Red main repair',
    description:
      'Take ownership of default-branch regressions, pause merges, and drive the fastest safe repair or revert.',
    kind: 'repair',
    agentKind: 'claude',
    executionMode: 'lead-session',
    codeChangePolicy: 'may-edit',
    promptTemplate:
      'Default branch {{defaultBranch}} is red at {{headSha}} from workflow {{workflowName}}. Fix or revert the regression without waiting for a human. If the fastest safe response is a revert, do it. Keep merges paused until the branch is healthy again.',
    targetAgent: 'engineering-lead',
    concurrencyKey: 'default-branch-{{defaultBranch}}',
    autoCommit: true,
    autoMerge: false,
    priority: 100,
    timeoutSeconds: 3600,
    maxParallelism: 1,
    repoHealthImpact: 'default-branch',
    retryPolicy: {
      maxAttempts: 2,
      backoffSeconds: 120,
    },
    budget: {
      maxUsd: 20,
      warnUsd: 15,
      defaultAttemptUsd: 0.5,
    },
    escalationPolicy: {
      onFailure: 'pause_repo',
      onBudgetExceeded: 'pause_repo',
      notify: [],
    },
    verification: {
      commands: ['bun run test:repo', 'bun run build'],
      requirePassing: true,
    },
    reviewerSuites: [
      'scope',
      'reliability',
      'security',
      'test-quality',
      'release-readiness',
    ],
    sourceBindings: [
      {
        type: 'github',
        event: 'default_branch_failure',
      },
    ],
  },
  {
    id: 'release-health-sweep',
    title: 'Release health sweep',
    description:
      'Perform the recurring CI and release-health sweep for this repository.',
    kind: 'maintenance',
    agentKind: 'either',
    executionMode: 'review-only',
    codeChangePolicy: 'review-only',
    promptTemplate:
      'Run the scheduled release-health sweep for this repository. Summarize CI health, unstable checks, and any new blockers since the prior sweep.',
    targetAgent: 'engineering-lead',
    concurrencyKey: 'release-health-sweep',
    autoCommit: false,
    autoMerge: false,
    priority: 40,
    timeoutSeconds: 1800,
    maxParallelism: 1,
    repoHealthImpact: 'serialized',
    retryPolicy: {
      maxAttempts: 1,
      backoffSeconds: 0,
    },
    budget: {
      maxUsd: 8,
      warnUsd: 6,
      defaultAttemptUsd: 0.1,
    },
    escalationPolicy: {
      onFailure: 'retry',
      onBudgetExceeded: 'pause_repo',
      notify: [],
    },
    verification: {
      commands: ['bun run test:repo', 'bun run build'],
      requirePassing: true,
    },
    reviewerSuites: ['reliability', 'release-readiness'],
    sourceBindings: [
      {
        type: 'cron',
        cron: '0 11 * * 1-5',
      },
    ],
  },
  {
    id: 'review-comment-follow-up',
    title: 'Review comment follow-up',
    description:
      'Convert requested changes and automation labels into a concrete follow-up lane that can revise the branch without waiting for a human.',
    kind: 'implementation',
    agentKind: 'codex',
    executionMode: 'lead-session',
    codeChangePolicy: 'may-edit',
    promptTemplate:
      'Follow up on review feedback for pull request #{{prNumber}} ({{prUrl}}). Apply the requested changes, keep the diff focused, rerun the required verification, and prepare the branch to re-enter unattended review.',
    targetAgent: 'engineering-lead',
    concurrencyKey: 'github-pr-follow-up-{{prNumber}}',
    autoCommit: true,
    autoMerge: false,
    priority: 85,
    timeoutSeconds: 3600,
    maxParallelism: 12,
    repoHealthImpact: 'serialized',
    retryPolicy: {
      maxAttempts: 2,
      backoffSeconds: 180,
    },
    budget: {
      maxUsd: 15,
      warnUsd: 10,
      defaultAttemptUsd: 0.35,
    },
    escalationPolicy: {
      onFailure: 'pause_repo',
      onBudgetExceeded: 'pause_repo',
      notify: [],
    },
    verification: {
      commands: ['bun run test:repo', 'bun run build'],
      requirePassing: true,
    },
    reviewerSuites: [
      'scope',
      'reliability',
      'security',
      'test-quality',
      'release-readiness',
    ],
    sourceBindings: [
      {
        type: 'github',
        event: 'review_requested_changes',
      },
      {
        type: 'github',
        event: 'issue_labeled_automation',
        label: 'codex:auto',
      },
    ],
  },
  {
    id: 'pm-company-research',
    title: 'PM company research',
    description:
      'Let the PM turn public company context into strategy, prioritization, and next actions without waiting for the owner.',
    kind: 'review',
    agentKind: 'claude',
    executionMode: 'lead-session',
    codeChangePolicy: 'review-only',
    promptTemplate:
      'You are the owner-facing PM for {{companyName}} ({{websiteUrl}}). Lane: {{laneType}} on cadence {{cadence}}. Workstream: {{workstreamTitle}}. Goal: {{workstreamGoal}}. Operating model: {{operatingModelSummary}}. Expected artifact kinds: {{expectedArtifactKinds}}. Use the company brief, current org, and pack context to produce a concrete durable business artifact, move the lane forward, and note only true owner exceptions.',
    targetAgent: 'engineering-lead',
    concurrencyKey: 'company-workstream-{{companyId}}-{{workstreamId}}',
    autoCommit: false,
    autoMerge: false,
    priority: 75,
    timeoutSeconds: 1800,
    maxParallelism: 12,
    repoHealthImpact: 'safe',
    retryPolicy: {
      maxAttempts: 2,
      backoffSeconds: 60,
    },
    budget: {
      maxUsd: 12,
      warnUsd: 9,
      defaultAttemptUsd: 0.25,
    },
    escalationPolicy: {
      onFailure: 'retry',
      onBudgetExceeded: 'pause_repo',
      notify: [],
    },
    verification: {
      commands: [],
      requirePassing: true,
    },
    reviewerSuites: ['scope', 'reliability'],
    sourceBindings: [
      {
        type: 'manual',
      },
    ],
  },
  {
    id: 'pm-company-implementation',
    title: 'PM company implementation',
    description:
      'Let the PM route implementation-heavy business or technical work to Codex while keeping the owner out of the loop.',
    kind: 'implementation',
    agentKind: 'codex',
    executionMode: 'lead-session',
    codeChangePolicy: 'may-edit',
    promptTemplate:
      'You are a specialist implementer working for the PM of {{companyName}} ({{websiteUrl}}). Lane: {{laneType}} on cadence {{cadence}}. Workstream: {{workstreamTitle}}. Goal: {{workstreamGoal}}. Operating model: {{operatingModelSummary}}. Expected artifact kinds: {{expectedArtifactKinds}}. Implement the requested outcome as a structured business artifact, keep scope narrow, and surface only genuine platform or owner exceptions.',
    targetAgent: 'engineering-lead',
    concurrencyKey: 'company-workstream-{{companyId}}-{{workstreamId}}',
    autoCommit: true,
    autoMerge: false,
    priority: 80,
    timeoutSeconds: 3600,
    maxParallelism: 12,
    repoHealthImpact: 'serialized',
    retryPolicy: {
      maxAttempts: 2,
      backoffSeconds: 120,
    },
    budget: {
      maxUsd: 18,
      warnUsd: 14,
      defaultAttemptUsd: 0.4,
    },
    escalationPolicy: {
      onFailure: 'pause_repo',
      onBudgetExceeded: 'pause_repo',
      notify: [],
    },
    verification: {
      commands: ['bun run build'],
      requirePassing: true,
    },
    reviewerSuites: ['scope', 'reliability', 'test-quality'],
    sourceBindings: [
      {
        type: 'manual',
      },
    ],
  },
  {
    id: 'pm-company-exception-response',
    title: 'PM exception response',
    description:
      'Let the PM assess owner exceptions, platform gaps, and blocked workstreams and decide the next safe move.',
    kind: 'maintenance',
    agentKind: 'claude',
    executionMode: 'lead-session',
    codeChangePolicy: 'review-only',
    promptTemplate:
      'You are the PM for {{companyName}} ({{websiteUrl}}). Workstream: {{workstreamTitle}}. An exception or gap needs triage: {{exceptionSummary}}. Decide whether to work around it, create a platform gap, or ask the owner only if the decision truly requires them.',
    targetAgent: 'engineering-lead',
    concurrencyKey: 'company-exception-{{companyId}}-{{workstreamId}}',
    autoCommit: false,
    autoMerge: false,
    priority: 90,
    timeoutSeconds: 1200,
    maxParallelism: 4,
    repoHealthImpact: 'safe',
    retryPolicy: {
      maxAttempts: 2,
      backoffSeconds: 90,
    },
    budget: {
      maxUsd: 8,
      warnUsd: 6,
      defaultAttemptUsd: 0.15,
    },
    escalationPolicy: {
      onFailure: 'retry',
      onBudgetExceeded: 'pause_repo',
      notify: [],
    },
    verification: {
      commands: [],
      requirePassing: true,
    },
    reviewerSuites: ['scope', 'reliability'],
    sourceBindings: [
      {
        type: 'manual',
      },
    ],
  },
  {
    id: 'pm-executive-brief',
    title: 'PM executive brief',
    description:
      'Generate the PM-owned summary that keeps the owner informed without forcing them into the specialist swarm.',
    kind: 'maintenance',
    agentKind: 'claude',
    executionMode: 'review-only',
    codeChangePolicy: 'review-only',
    promptTemplate:
      'You are the PM for {{companyName}} ({{websiteUrl}}). Prepare the executive brief for the owner. Include progress, risks, exceptions, lane health, connector readiness, and the highest-leverage next moves while shielding the owner from specialist implementation details.',
    targetAgent: 'engineering-lead',
    concurrencyKey: 'company-brief-{{companyId}}',
    autoCommit: false,
    autoMerge: false,
    priority: 45,
    timeoutSeconds: 1200,
    maxParallelism: 1,
    repoHealthImpact: 'safe',
    retryPolicy: {
      maxAttempts: 1,
      backoffSeconds: 0,
    },
    budget: {
      maxUsd: 6,
      warnUsd: 4,
      defaultAttemptUsd: 0.1,
    },
    escalationPolicy: {
      onFailure: 'retry',
      onBudgetExceeded: 'pause_repo',
      notify: [],
    },
    verification: {
      commands: [],
      requirePassing: true,
    },
    reviewerSuites: ['scope'],
    sourceBindings: [
      {
        type: 'manual',
      },
      {
        type: 'cron',
        cron: '0 16 * * 1-5',
      },
    ],
  },
]

export function getHarnessConfigPath(projectRoot: string): string {
  return path.join(projectRoot, HARNESS_CONFIG_RELATIVE_PATH)
}

export function getDefaultHarnessConfig(): HarnessConfig {
  return HarnessConfigSchema().parse({
    version: '1',
    sources: {
      github: {
        enabled: true,
        provider: 'gh',
        pollIntervalSeconds: 300,
        intake: {
          mode: 'hybrid',
          webhookEvents: [
            'pull_request_opened',
            'pull_request_push',
            'pull_request_reopened',
            'review_requested_changes',
            'issue_labeled_automation',
            'default_branch_failure',
          ],
        },
        reviewOnPush: true,
        trackDefaultBranch: true,
      },
      cron: {
        enabled: true,
        pollIntervalSeconds: 60,
      },
        remoteTriggers: {
          enabled: true,
          mirrorEnabled: true,
          dispatchMode: 'primary',
          localFallback: true,
          maxWorkers: 50,
          pollIntervalSeconds: 300,
          inboxPath: '.claude/harness/remote-events.json',
          remoteApi: 'ccr',
          model: 'claude-sonnet-4-6',
        },
    },
    jobs: DEFAULT_JOBS,
    reviewers: BUILTIN_REVIEWERS,
    autonomy: {
      autoMerge: true,
      deploy: 'disabled',
      pauseOnMainRed: true,
      createRevertJobOnRegression: true,
    },
    learning: {
      knowledgePath: '.claude/harness/feedback.md',
      minimumRepeatCount: 2,
      attachToJobPrompts: true,
    },
  })
}

export async function readHarnessConfig(
  projectRoot: string,
): Promise<HarnessConfig | null> {
  try {
    const raw = await readFile(getHarnessConfigPath(projectRoot), 'utf-8')
    const parsed = safeParseJSON(raw, false)
    if (parsed == null) {
      return null
    }
    return HarnessConfigSchema().parse(parsed)
  } catch {
    return null
  }
}

export async function writeHarnessConfig(
  config: HarnessConfig,
  projectRoot: string,
): Promise<void> {
  await mkdir(path.dirname(getHarnessConfigPath(projectRoot)), {
    recursive: true,
  })
  await writeFile(
    getHarnessConfigPath(projectRoot),
    `${jsonStringify(config, null, 2)}\n`,
    'utf-8',
  )
}

function toEmployeeDutyJob(duty: EmployeeDuty): JobSpec {
  const dutyHash = createHash('sha256').update(duty.id).digest('hex').slice(0, 8)
  return {
    id: `employee-duty-${duty.id}`,
    title: duty.title,
    description: `Compiled recurring duty from .claude/employee.json (${duty.id}).`,
    kind: 'maintenance',
    executionMode: 'lead-session',
    codeChangePolicy: duty.autoCommit ? 'may-edit' : 'review-only',
    promptTemplate: duty.prompt,
    targetAgent: duty.targetAgent ?? 'engineering-lead',
    concurrencyKey: `employee-duty-${dutyHash}`,
    autoCommit: duty.autoCommit,
    autoMerge: false,
    priority: 35,
    timeoutSeconds: 1800,
    maxParallelism: 1,
    repoHealthImpact: 'safe',
    retryPolicy: {
      maxAttempts: 1,
      backoffSeconds: 0,
    },
    budget: {
      maxUsd: 5,
      warnUsd: 4,
      defaultAttemptUsd: 0.1,
    },
    escalationPolicy: {
      onFailure: 'retry',
      onBudgetExceeded: 'pause_repo',
      notify: [],
    },
    verification: {
      commands: [],
      requirePassing: true,
    },
    reviewerSuites: ['reliability', 'release-readiness'],
    sourceBindings: [
      {
        type: 'cron',
        cron: duty.cron,
      },
    ],
  }
}

export async function readEffectiveHarnessConfig(
  projectRoot: string,
): Promise<HarnessConfig> {
  const [rawConfig, employeeConfig] = await Promise.all([
    readHarnessConfig(projectRoot),
    readEmployeeConfig(projectRoot),
  ])

  const config = rawConfig ?? getDefaultHarnessConfig()
  const jobs = [...config.jobs]
  const reviewers = [...config.reviewers]
  const existingIds = new Set(jobs.map(job => job.id))
  const existingReviewerIds = new Set(reviewers.map(reviewer => reviewer.id))

  for (const defaultJob of DEFAULT_JOBS) {
    if (!existingIds.has(defaultJob.id)) {
      jobs.push(defaultJob)
      existingIds.add(defaultJob.id)
    }
  }

  for (const builtinReviewer of BUILTIN_REVIEWERS) {
    if (!existingReviewerIds.has(builtinReviewer.id)) {
      reviewers.push(builtinReviewer)
      existingReviewerIds.add(builtinReviewer.id)
    }
  }

  for (const duty of employeeConfig?.recurringDuties ?? []) {
    if (!duty.enabled) continue
    const compiled = toEmployeeDutyJob(duty)
    if (existingIds.has(compiled.id)) {
      continue
    }
    jobs.push(compiled)
  }

  return HarnessConfigSchema().parse({
    ...config,
    jobs,
    reviewers,
  })
}
