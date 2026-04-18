import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { JobSpec, QueuedHarnessJob } from 'src/services/harness/types.js'
import type { ShellCommandRunner } from 'src/services/harness/shell.js'
import { runReviewerSuites } from 'src/services/harness/reviewers.js'

const reviewJobSpec: JobSpec = {
  id: 'pr-review-on-push',
  title: 'PR review on push',
  description: 'review',
  kind: 'review',
  executionMode: 'review-only',
  codeChangePolicy: 'review-only',
  promptTemplate: 'review',
  targetAgent: 'engineering-lead',
  concurrencyKey: 'github-pr-{{prNumber}}',
  autoCommit: false,
  autoMerge: true,
  priority: 70,
  timeoutSeconds: 1200,
  maxParallelism: 4,
  repoHealthImpact: 'safe',
  retryPolicy: { maxAttempts: 1, backoffSeconds: 0 },
  budget: { maxUsd: 10, warnUsd: 8, defaultAttemptUsd: 0.15 },
  escalationPolicy: {
    onFailure: 'retry',
    onBudgetExceeded: 'pause_repo',
    notify: [],
  },
  verification: { commands: [], requirePassing: true },
  reviewerSuites: [
    'scope',
    'reliability',
    'security',
    'test-quality',
    'release-readiness',
  ],
  sourceBindings: [{ type: 'github', event: 'pull_request_push' }],
}

const queuedJob: QueuedHarnessJob = {
  instanceId: 'job-1',
  jobId: 'pr-review-on-push',
  sourceKind: 'github',
  repoId: 'repo_test',
  dedupeKey: 'dedupe-1',
  concurrencyKey: 'github-pr-1',
  prompt: 'review this PR',
  status: 'queued',
  priority: 70,
  timeoutSeconds: 1200,
  maxParallelism: 4,
  metadata: {},
  promptVariables: {
    prNumber: '17',
  },
  createdAt: '2026-04-18T00:00:00.000Z',
  updatedAt: '2026-04-18T00:00:00.000Z',
  attempt: 1,
  reviewerDecisions: [],
  verificationResults: [],
  failureTags: [],
}

describe('harness reviewers', () => {
  test('blocks oversized draft pull requests', async () => {
    const runner: ShellCommandRunner = async (_file, args) => {
      if (args.at(-1) === 'command -v bun >/dev/null 2>&1') {
        return { stdout: '/opt/homebrew/bin/bun\n', stderr: '', code: 0 }
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            number: 17,
            title: 'Big draft PR',
            url: 'https://example.com/pr/17',
            isDraft: true,
            changedFiles: 52,
            additions: 1400,
            deletions: 200,
            mergeable: 'MERGEABLE',
          }),
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return {
          stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }]),
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'diff' && args.includes('--name-only')) {
        return {
          stdout: 'src/index.ts\n',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'diff') {
        return {
          stdout: '',
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    const result = await runReviewerSuites(
      '/tmp',
      reviewJobSpec,
      queuedJob,
      runner,
      { paused: false },
    )

    expect(result.decisions.some(decision => decision.status === 'block')).toBe(
      true,
    )
    expect(
      result.decisions.some(
        decision =>
          decision.reviewerId === 'scope' &&
          decision.summary.includes('draft'),
      ),
    ).toBe(true)
  })

  test('classifies bootstrap failures as infrastructure blockers', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-reviewers-'))
    await Bun.write(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'reviewers-fixture',
        private: true,
        scripts: {
          'repo:bootstrap': 'echo bootstrap',
        },
      }),
    )

    const runner: ShellCommandRunner = async (_file, args) => {
      const command = args.at(-1) ?? ''
      if (command === 'command -v bun >/dev/null 2>&1') {
        return { stdout: '/opt/homebrew/bin/bun\n', stderr: '', code: 0 }
      }
      if (command === 'bun run repo:bootstrap') {
        return {
          stdout: '',
          stderr: 'bootstrap dependencies missing',
          code: 2,
        }
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            number: 17,
            title: 'Bootstrap fixer',
            url: 'https://example.com/pr/17',
            isDraft: false,
            changedFiles: 2,
            additions: 20,
            deletions: 4,
            mergeable: 'MERGEABLE',
          }),
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return {
          stdout: JSON.stringify([]),
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'diff' && args.includes('--name-only')) {
        return {
          stdout: 'src/index.ts\n',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'diff') {
        return {
          stdout: '',
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    const result = await runReviewerSuites(
      repoRoot,
      reviewJobSpec,
      queuedJob,
      runner,
      { paused: false },
    )

    expect(
      result.verificationResults.some(
        verification =>
          verification.command === 'bun run repo:bootstrap' &&
          verification.phase === 'bootstrap' &&
          verification.infrastructureFailure,
      ),
    ).toBe(true)
    expect(
      result.decisions.some(
        decision =>
          decision.reviewerId === 'reliability' &&
          decision.reasonCode === 'infrastructure_failure',
      ),
    ).toBe(true)
  })
})
