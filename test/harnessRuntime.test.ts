import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  getDefaultHarnessConfig,
  writeHarnessConfig,
} from 'src/services/harness/config.js'
import { pollGitHubDiscovery } from 'src/services/harness/github.js'
import type { HarnessDependencies } from 'src/services/harness/runtime.js'
import {
  buildNextWorkerHeartbeat,
  getHarnessStatus,
  ingestGitHubWebhookEvent,
  pollHarnessOnce,
  runHarnessJob,
} from 'src/services/harness/runtime.js'
import type { ShellCommandRunner } from 'src/services/harness/shell.js'
import { createStableId } from 'src/services/harness/utils.js'

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-runtime-'))
  await mkdir(path.join(repoRoot, '.claude'), { recursive: true })
  return repoRoot
}

async function writeRunnerManifest(
  repoRoot: string,
  runnerIds: { claude: string; codex: string } = {
    claude: 'claude-primary',
    codex: 'codex-primary',
  },
): Promise<void> {
  await Bun.write(
    path.join(repoRoot, '.claude', 'harness.runners.json'),
    JSON.stringify(
      {
        version: '1',
        runners: [
          {
            id: runnerIds.claude,
            agentKind: 'claude',
            slotCapacity: 25,
            labels: ['shared', 'cc', 'claude'],
          },
          {
            id: runnerIds.codex,
            agentKind: 'codex',
            slotCapacity: 25,
            labels: ['shared', 'cc', 'codex'],
          },
        ],
      },
      null,
      2,
    ),
  )
}

describe('harness runtime', () => {
  test('dedupes identical github and remote-trigger jobs, then auto-merges the pull request', async () => {
    const repoRoot = await createTempRepo()
    const claudeConfigDir = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-home-'))
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
    const config = getDefaultHarnessConfig()
    await writeHarnessConfig(config, repoRoot)

    const dedupeKey = createStableId('pr-review-on-push', 'github', 12, 'abc123')
    await mkdir(path.join(repoRoot, '.claude', 'harness'), { recursive: true })
    await Bun.write(
      path.join(repoRoot, '.claude', 'harness', 'remote-events.json'),
      JSON.stringify([
        {
          id: 'evt-1',
          jobId: 'pr-review-on-push',
          dedupeKey,
          metadata: { prNumber: 12 },
          promptVariables: {
            prNumber: '12',
            prTitle: 'Add harness',
            prUrl: 'https://example.com/pr/12',
            headSha: 'abc123',
            repo: 'owner/repo',
          },
          createdAt: '2026-04-18T00:00:00.000Z',
        },
      ]),
    )

    const runner: ShellCommandRunner = async (_file, args) => {
      if (args.at(-1) === 'command -v bun >/dev/null 2>&1') {
        return {
          stdout: '/opt/homebrew/bin/bun\n',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            nameWithOwner: 'owner/repo',
            defaultBranchRef: { name: 'main' },
          }),
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            {
              number: 12,
              title: 'Add harness',
              url: 'https://example.com/pr/12',
              isDraft: false,
              headRefOid: 'abc123',
              headRefName: 'feature/harness',
              baseRefName: 'main',
            },
          ]),
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'run' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([]),
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            number: 12,
            title: 'Add harness',
            url: 'https://example.com/pr/12',
            isDraft: false,
            changedFiles: 3,
            additions: 42,
            deletions: 4,
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
          stdout: 'src/index.ts\ntest/index.test.ts\n',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'diff') {
        return {
          stdout: 'diff --git a/src/index.ts b/src/index.ts',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return {
          stdout: 'merge queued',
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    const deps: Partial<HarnessDependencies> = {
      commandRunner: runner,
      workerExecutor: async () => {
        throw new Error('worker should not run for review-only jobs')
      },
      now: () => new Date('2026-04-18T09:00:00.000Z'),
      sleep: async () => {},
    }

    try {
      const result = await pollHarnessOnce(repoRoot, deps)
      const status = await getHarnessStatus(repoRoot)

      expect(result.processedJobId).toBeDefined()
      expect(status.state.history).toHaveLength(1)
      expect(status.state.history[0]?.status).toBe('completed')
      expect(status.state.history[0]?.autoMergeResult).toContain('merge queued')
      expect(status.state.queue.length).toBe(0)
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
  })

  test('manual lead-session jobs write learning and autoresearch artifacts', async () => {
    const repoRoot = await createTempRepo()
    const config = {
      ...getDefaultHarnessConfig(),
      sources: {
        github: {
          enabled: false,
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
          reviewOnPush: false,
          trackDefaultBranch: false,
        },
        cron: {
          enabled: false,
          pollIntervalSeconds: 60,
        },
        remoteTriggers: {
          enabled: false,
          mirrorEnabled: false,
          dispatchMode: 'shadow',
          localFallback: true,
          maxWorkers: 1,
          pollIntervalSeconds: 300,
          inboxPath: '.claude/harness/remote-events.json',
          remoteApi: 'ccr',
          model: 'claude-sonnet-4-6',
        },
      },
      jobs: getDefaultHarnessConfig().jobs.filter(job => job.id === 'red-main-repair'),
    }
    await writeHarnessConfig(config, repoRoot)

    const claudeConfigDir = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-home-'))
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

    const runner: ShellCommandRunner = async (_file, args) => {
      if (args.at(-1) === 'command -v bun >/dev/null 2>&1') {
        return { stdout: '/opt/homebrew/bin/bun\n', stderr: '', code: 0 }
      }
      if (args.at(-1) === 'bun run test:repo' || args.at(-1) === 'bun run build') {
        return { stdout: 'ok', stderr: '', code: 0 }
      }
      return { stdout: JSON.stringify([]), stderr: '', code: 0 }
    }

    try {
      const deps: Partial<HarnessDependencies> = {
        commandRunner: runner,
        workerExecutor: async () => ({
          success: true,
          stdout: 'repaired main',
          stderr: '',
          summary: 'repaired default branch',
          humanTouchCount: 0,
          outputPath: path.join(repoRoot, '.claude', 'harness', 'runs', 'manual.log'),
        }),
        now: () => new Date('2026-04-18T09:00:00.000Z'),
        sleep: async () => {},
      }

      await runHarnessJob(repoRoot, 'red-main-repair', deps)

      const feedback = await readFile(
        path.join(repoRoot, '.claude', 'harness', 'feedback.md'),
        'utf-8',
      )
      expect(feedback).toContain('Harness Feedback')

      const autoresearchRoot = path.join(claudeConfigDir, 'autoresearch')
      const entries = await readdir(autoresearchRoot)
      expect(entries.length).toBeGreaterThan(0)
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
  })

  test('ingests GitHub requested-changes webhooks into follow-up jobs', async () => {
    const repoRoot = await createTempRepo()
    const claudeConfigDir = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-home-'))
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
    await writeHarnessConfig(getDefaultHarnessConfig(), repoRoot)

    try {
      const result = await ingestGitHubWebhookEvent(repoRoot, 'pull_request_review', {
        action: 'submitted',
        repository: {
          full_name: 'owner/repo',
          default_branch: 'main',
        },
        pull_request: {
          number: 42,
          title: 'Tighten harness',
          html_url: 'https://example.com/pr/42',
          head: {
            sha: 'feedbeef',
            ref: 'feature/harness-v2',
          },
          base: {
            ref: 'main',
          },
        },
        review: {
          state: 'changes_requested',
        },
      })

      expect(result.enqueued).toHaveLength(1)
      expect(result.state.queue).toHaveLength(1)
      expect(result.state.jobs[result.enqueued[0]!]?.jobId).toBe(
        'review-comment-follow-up',
      )
      expect(result.state.jobs[result.enqueued[0]!]?.sourceKind).toBe('webhook')
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
  })

  test('routes codex work only to codex runners and reports fleet capacity in status', async () => {
    const repoRoot = await createTempRepo()
    await writeRunnerManifest(repoRoot)
    const claudeConfigDir = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-home-'))
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
    const baseNow = new Date()

    const config = {
      ...getDefaultHarnessConfig(),
      sources: {
        github: {
          enabled: false,
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
          reviewOnPush: false,
          trackDefaultBranch: false,
        },
        cron: {
          enabled: false,
          pollIntervalSeconds: 60,
        },
        remoteTriggers: {
          enabled: false,
          mirrorEnabled: false,
          dispatchMode: 'shadow',
          localFallback: true,
          maxWorkers: 50,
          pollIntervalSeconds: 300,
          inboxPath: '.claude/harness/remote-events.json',
          remoteApi: 'ccr',
          model: 'claude-sonnet-4-6',
        },
      },
      jobs: getDefaultHarnessConfig().jobs.filter(
        job => job.id === 'review-comment-follow-up' || job.id === 'red-main-repair',
      ),
    }
    await writeHarnessConfig(config, repoRoot)

    const runner: ShellCommandRunner = async () => ({
      stdout: JSON.stringify([]),
      stderr: '',
      code: 0,
    })

    try {
      const queued = await runHarnessJob(repoRoot, 'review-comment-follow-up', {
        commandRunner: runner,
        workerExecutor: async () => {
          throw new Error('claude runner should not pick up codex work')
        },
        agentKind: 'claude',
        runnerId: 'claude-primary',
        workerSlots: 25,
        now: () => baseNow,
        sleep: async () => {},
      })

      expect(queued.state.queue).toHaveLength(1)

      let status = await getHarnessStatus(repoRoot)
      expect(status.totalSlotCapacity).toBe(25)
      expect(status.slotCapacityByAgentKind.claude).toBe(25)
      expect(status.slotCapacityByAgentKind.codex).toBe(0)
      expect(status.queuedCapacityShortfalls.codex).toBe(1)
      expect(status.fleet.expectedRunners).toEqual([
        'claude-primary',
        'codex-primary',
      ])
      expect(status.fleet.missingRunners).toEqual(['codex-primary'])
      expect(status.fleet.missingSlots).toBe(25)

      const processed = await pollHarnessOnce(repoRoot, {
        commandRunner: runner,
        workerExecutor: async ({ agentKind }) => ({
          success: true,
          stdout: `${agentKind} completed`,
          stderr: '',
          summary: `${agentKind} applied follow-up`,
          humanTouchCount: 0,
          totalCostUsd: 0,
          executionBackend: 'local',
        }),
        agentKind: 'codex',
        runnerId: 'codex-primary',
        workerSlots: 25,
        now: () => new Date(baseNow.getTime() + 5_000),
        sleep: async () => {},
      })

      expect(processed.processedJobId).toBeDefined()

      status = await getHarnessStatus(repoRoot)
      expect(status.totalSlotCapacity).toBe(50)
      expect(status.slotCapacityByAgentKind.claude).toBe(25)
      expect(status.slotCapacityByAgentKind.codex).toBe(25)
      expect(status.runners.map(runner => runner.runnerId)).toEqual([
        'claude-primary',
        'codex-primary',
      ])
      expect(status.fleet.registeredRunners).toEqual([
        'claude-primary',
        'codex-primary',
      ])
      expect(status.fleet.expectedSlotCapacity).toBe(50)
      expect(status.fleet.registeredSlotCapacity).toBe(50)
      expect(status.fleet.missingRunners).toEqual([])
      expect(status.fleet.missingSlots).toBe(0)
      expect(status.state.history[0]?.jobId).toBe('review-comment-follow-up')
      expect(Object.values(status.state.agentSessions)[0]?.agentKind).toBe('codex')
      expect(status.observability.internalQueryLive).toBe(true)
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
  })

  test('preserves telemetry export state across worker heartbeat refreshes', () => {
    const next = buildNextWorkerHeartbeat(
      {
        workerId: 'claude-primary-worker-1',
        pid: 100,
        runnerId: 'claude-primary',
        agentKind: 'claude',
        labels: ['shared', 'cc', 'claude'],
        slotCapacity: 25,
        healthy: true,
        observabilityEnvLoaded: true,
        lastTelemetryExportAt: '2026-04-19T12:00:00.000Z',
        repoId: 'repo-1',
        lastHeartbeatAt: '2026-04-19T12:00:01.000Z',
      },
      {
        workerId: 'claude-primary-worker-1',
        pid: 101,
        runnerId: 'claude-primary',
        agentKind: 'claude',
        labels: ['shared', 'cc', 'claude'],
        slotCapacity: 25,
        repoId: 'repo-1',
        lastHeartbeatAt: '2026-04-19T12:00:10.000Z',
        observabilityEnvLoaded: true,
      },
    )

    expect(next.pid).toBe(101)
    expect(next.lastHeartbeatAt).toBe('2026-04-19T12:00:10.000Z')
    expect(next.observabilityEnvLoaded).toBe(true)
    expect(next.lastTelemetryExportAt).toBe('2026-04-19T12:00:00.000Z')
  })

  test('treats only the latest default-branch run as authoritative for red-main detection', async () => {
    const repoRoot = await createTempRepo()
    const runner: ShellCommandRunner = async (_file, args) => {
      if (args[0] === 'repo' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            nameWithOwner: 'owner/repo',
            defaultBranchRef: { name: 'main' },
          }),
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([]),
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'run' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            {
              databaseId: 2,
              headSha: 'goodsha',
              status: 'completed',
              conclusion: 'success',
              workflowName: 'CI',
              url: 'https://example.com/runs/2',
            },
            {
              databaseId: 1,
              headSha: 'badsha',
              status: 'completed',
              conclusion: 'failure',
              workflowName: 'CI',
              url: 'https://example.com/runs/1',
            },
          ]),
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    const discovery = await pollGitHubDiscovery(
      repoRoot,
      getDefaultHarnessConfig(),
      runner,
    )

    expect(discovery.failingDefaultBranchRun).toBeNull()
  })
})
