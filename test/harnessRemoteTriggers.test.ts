import { describe, expect, test } from 'bun:test'
import type { ShellCommandRunner } from 'src/services/harness/shell.js'
import { getDefaultHarnessConfig } from 'src/services/harness/config.js'
import { dispatchHarnessJobToRemoteTrigger } from 'src/services/harness/remoteTriggers.js'
import type { JobSpec, QueuedHarnessJob } from 'src/services/harness/types.js'

const leadJobSpec: JobSpec =
  getDefaultHarnessConfig().jobs.find(job => job.id === 'red-main-repair')!

const queuedJob: QueuedHarnessJob = {
  instanceId: 'job-1',
  jobId: 'red-main-repair',
  sourceKind: 'manual',
  repoId: 'repo_test',
  dedupeKey: 'dedupe-1',
  concurrencyKey: 'default-branch-main',
  prompt:
    'Default branch main is red at abc123 from workflow CI. Fix or revert it without waiting for a human.',
  status: 'queued',
  priority: 100,
  timeoutSeconds: 3600,
  maxParallelism: 1,
  metadata: {},
  promptVariables: {
    defaultBranch: 'main',
    headSha: 'abc123',
    workflowName: 'CI',
  },
  createdAt: '2026-04-18T00:00:00.000Z',
  updatedAt: '2026-04-18T00:00:00.000Z',
  attempt: 1,
  reviewerDecisions: [],
  verificationResults: [],
  failureTags: [],
}

describe('harness remote triggers', () => {
  test('prefers creating a visible CCR session for immediate shadow work', async () => {
    const requests: Array<{
      method: string
      url: string
      data: unknown
    }> = []
    const runner: ShellCommandRunner = async (_file, args) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return {
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return {
          stdout: 'main\n',
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    const result = await dispatchHarnessJobToRemoteTrigger(
      {
        repoRoot: '/tmp/repo',
        config: getDefaultHarnessConfig(),
        jobSpec: leadJobSpec,
        job: queuedJob,
        commandRunner: runner,
      },
      {
        request: async input => {
          requests.push({
            method: input.method,
            url: input.url,
            data: input.data,
          })
          if (input.url.endsWith('/v1/sessions')) {
            return {
              status: 200,
              data: { id: 'session-123', title: 'Harness shadow' },
            }
          }
          throw new Error(`unexpected request: ${input.url}`)
        },
        prepareApiRequest: async () => ({
          accessToken: 'token-123',
          orgUUID: 'org-123',
        }),
        isFeatureEnabled: () => true,
        isPolicyAllowed: () => true,
        fetchEnvironments: async () => [
          {
            environment_id: 'env-123',
            kind: 'anthropic_cloud',
            name: 'default',
            created_at: '2026-04-18T00:00:00.000Z',
            state: 'active',
          },
        ],
        createDefaultEnvironment: async () => {
          throw new Error('should not create environment when one exists')
        },
        getDefaultEnvironmentId: () => 'env-123',
        uuid: () => '00000000-0000-4000-8000-000000000000',
      },
    )

    expect(result.ok).toBe(true)
    expect(result.backend).toBe('session')
    expect(result.sessionId).toBe('session-123')
    expect(result.observationMode).toBe('session')
    expect(result.summary).toContain('CCR session session-123')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain('/v1/sessions')

    const createBody = requests[0]?.data as {
      title: string
      environment_id: string
      session_context: {
        model: string
        environment_variables: Record<string, string>
        sources: Array<{ type: string; url: string; revision?: string }>
      }
      events: Array<{
        type: string
        data: {
          uuid: string
          message: { content: string; role: string }
        }
      }>
      source: string
    }
    expect(createBody.title).toContain('Harness claude:')
    expect(createBody.environment_id).toBe('env-123')
    expect(createBody.source).toBe('remote-control')
    expect(createBody.session_context.model).toBe('claude-sonnet-4-6')
    expect(createBody.session_context.environment_variables).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'token-123',
      CLAUDE_CODE_HARNESS_JOB_ID: queuedJob.instanceId,
      CLAUDE_CODE_HARNESS_REMOTE_SHADOW: '1',
    })
    expect(createBody.session_context.sources[0]).toEqual({
      type: 'git_repository',
      url: 'https://github.com/owner/repo',
      revision: 'main',
    })
    expect(createBody.events[0]?.type).toBe('event')
    expect(createBody.events[0]?.data.uuid).toBe(
      '00000000-0000-4000-8000-000000000000',
    )
    expect(createBody.events[0]?.data.message.content).toContain(queuedJob.prompt)
  })

  test('falls back to a CCR trigger when session creation fails', async () => {
    const runner: ShellCommandRunner = async (_file, args) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return {
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return {
          stdout: 'main\n',
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    const result = await dispatchHarnessJobToRemoteTrigger(
      {
        repoRoot: '/tmp/repo',
        config: getDefaultHarnessConfig(),
        jobSpec: leadJobSpec,
        job: queuedJob,
        commandRunner: runner,
      },
      {
        request: async input => {
          if (input.url.endsWith('/v1/sessions')) {
            return {
              status: 400,
              data: { error: { message: 'session create rejected' } },
            }
          }
          if (input.url.endsWith('/v1/code/triggers')) {
            return {
              status: 200,
              data: { trigger_id: 'trigger-123' },
            }
          }
          if (input.url.endsWith('/v1/code/triggers/trigger-123')) {
            return {
              status: 200,
              data: { trigger: { id: 'trigger-123', persist_session: false } },
            }
          }
          if (input.url.endsWith('/v1/code/triggers/trigger-123/run')) {
            return {
              status: 202,
              data: { ok: true },
            }
          }
          throw new Error(`unexpected request: ${input.url}`)
        },
        prepareApiRequest: async () => ({
          accessToken: 'token-123',
          orgUUID: 'org-123',
        }),
        isPolicyAllowed: () => true,
        fetchEnvironments: async () => [
          {
            environment_id: 'env-123',
            kind: 'anthropic_cloud',
            name: 'default',
            created_at: '2026-04-18T00:00:00.000Z',
            state: 'active',
          },
        ],
        createDefaultEnvironment: async () => {
          throw new Error('should not create environment when one exists')
        },
        getDefaultEnvironmentId: () => 'env-123',
        uuid: () => '00000000-0000-4000-8000-000000000000',
      },
    )

    expect(result.ok).toBe(true)
    expect(result.backend).toBe('trigger')
    expect(result.triggerId).toBe('trigger-123')
    expect(result.observationMode).toBe('trigger')
    expect(result.persistSessionObserved).toBe(false)
    expect(result.summary).toContain('fell back to CCR trigger trigger-123')
    expect(result.summary).toContain('session create returned 400')
  })

  test('does not let a stale local feature gate block explicit CCR dispatch', async () => {
    const runner: ShellCommandRunner = async (_file, args) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return {
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return {
          stdout: 'main\n',
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }
    const requests: string[] = []

    const result = await dispatchHarnessJobToRemoteTrigger(
      {
        repoRoot: '/tmp/repo',
        config: getDefaultHarnessConfig(),
        jobSpec: leadJobSpec,
        job: queuedJob,
        commandRunner: runner,
      },
      {
        request: async input => {
          requests.push(input.url)
          if (input.url.endsWith('/v1/sessions')) {
            return {
              status: 200,
              data: { id: 'session-123', title: 'Harness shadow' },
            }
          }
          if (input.url.endsWith('/v1/code/triggers')) {
            return {
              status: 200,
              data: { trigger_id: 'trigger-123' },
            }
          }
          if (input.url.endsWith('/v1/code/triggers/trigger-123')) {
            return {
              status: 200,
              data: { trigger: { id: 'trigger-123', persist_session: true } },
            }
          }
          if (input.url.endsWith('/v1/code/triggers/trigger-123/run')) {
            return {
              status: 202,
              data: { ok: true },
            }
          }
          throw new Error(`unexpected request: ${input.url}`)
        },
        prepareApiRequest: async () => ({
          accessToken: 'token-123',
          orgUUID: 'org-123',
        }),
        isFeatureEnabled: () => false,
        isPolicyAllowed: () => true,
        fetchEnvironments: async () => [
          {
            environment_id: 'env-123',
            kind: 'anthropic_cloud',
            name: 'default',
            created_at: '2026-04-18T00:00:00.000Z',
            state: 'active',
          },
        ],
        createDefaultEnvironment: async () => {
          throw new Error('should not create environment when one exists')
        },
        getDefaultEnvironmentId: () => 'env-123',
        uuid: () => '00000000-0000-4000-8000-000000000000',
      },
    )

    expect(result.ok).toBe(true)
    expect(result.backend).toBe('session')
    expect(requests).toHaveLength(1)
  })

  test('retries environment discovery once after an auth-like failure', async () => {
    const runner: ShellCommandRunner = async (_file, args) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return {
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return {
          stdout: 'main\n',
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    let fetchAttempt = 0
    let refreshCount = 0

    const result = await dispatchHarnessJobToRemoteTrigger(
      {
        repoRoot: '/tmp/repo',
        config: getDefaultHarnessConfig(),
        jobSpec: leadJobSpec,
        job: queuedJob,
        commandRunner: runner,
      },
      {
        request: async input => {
          if (input.url.endsWith('/v1/sessions')) {
            return {
              status: 200,
              data: { id: 'session-456', title: 'Harness shadow' },
            }
          }
          throw new Error(`unexpected request: ${input.url}`)
        },
        refreshAuth: async () => {
          refreshCount += 1
        },
        prepareApiRequest: async () => ({
          accessToken: 'token-123',
          orgUUID: 'org-123',
        }),
        isPolicyAllowed: () => true,
        fetchEnvironments: async () => {
          fetchAttempt += 1
          if (fetchAttempt === 1) {
            throw new Error(
              'Failed to fetch environments: Request failed with status code 401',
            )
          }
          return [
            {
              environment_id: 'env-123',
              kind: 'anthropic_cloud',
              name: 'default',
              created_at: '2026-04-18T00:00:00.000Z',
              state: 'active',
            },
          ]
        },
        createDefaultEnvironment: async () => {
          throw new Error('should not create environment when one exists')
        },
        getDefaultEnvironmentId: () => 'env-123',
        uuid: () => '00000000-0000-4000-8000-000000000000',
      },
    )

    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe('session-456')
    expect(fetchAttempt).toBe(2)
    expect(refreshCount).toBeGreaterThanOrEqual(1)
  })

  test('fails open when remote sessions are blocked by policy', async () => {
    const runner: ShellCommandRunner = async () => {
      throw new Error('runner should not be called when policy is off')
    }

    const result = await dispatchHarnessJobToRemoteTrigger(
      {
        repoRoot: '/tmp/repo',
        config: getDefaultHarnessConfig(),
        jobSpec: leadJobSpec,
        job: queuedJob,
        commandRunner: runner,
      },
      {
        isPolicyAllowed: () => false,
      },
    )

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('policy')
  })
})
