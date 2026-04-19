import { describe, expect, test } from 'bun:test'
import { buildExecutionFailureTags } from 'src/services/harness/runtime.js'
import {
  classifyAgentSessionSeverity,
  classifyHarnessEventSeverity,
  classifyHarnessSystemState,
  classifyHarnessTrafficClass,
} from 'src/services/harness/telemetry.js'

describe('harness telemetry classification', () => {
  test('classifies failed and blocked outcomes with explicit severity', () => {
    expect(
      classifyHarnessEventSeverity({
        eventName: 'cc_harness_job_outcome',
        outcome: { status: 'failed' } as never,
      }),
    ).toBe('ERROR')

    expect(
      classifyHarnessEventSeverity({
        eventName: 'cc_harness_job_outcome',
        outcome: { status: 'blocked' } as never,
      }),
    ).toBe('WARN')

    expect(
      classifyHarnessEventSeverity({
        eventName: 'cc_harness_poll_snapshot',
      }),
    ).toBe('INFO')
  })

  test('classifies manual, system, and synthetic traffic separately', () => {
    expect(
      classifyHarnessTrafficClass({
        job: {
          sourceKind: 'manual',
          metadata: { requestedBy: 'cli' },
        } as never,
      }),
    ).toBe('manual')

    expect(
      classifyHarnessTrafficClass({
        job: {
          sourceKind: 'manual',
          metadata: { requestedBy: 'pm-refresh' },
        } as never,
      }),
    ).toBe('system')

    expect(
      classifyHarnessTrafficClass({
        job: {
          sourceKind: 'webhook',
          metadata: { webhookSource: 'cli' },
        } as never,
      }),
    ).toBe('synthetic')
  })

  test('classifies failed agent sessions as errors', () => {
    expect(
      classifyAgentSessionSeverity({
        result: 'failure',
      } as never),
    ).toBe('ERROR')
    expect(
      classifyAgentSessionSeverity({
        result: 'blocked',
      } as never),
    ).toBe('WARN')
  })

  test('classifies cold start, warming, and idle fleet states', () => {
    expect(classifyHarnessSystemState({})).toBe('cold_start')

    expect(
      classifyHarnessSystemState({
        repoId: 'repo-1',
        state: {
          jobs: {},
          queue: [],
          workerHeartbeats: {
            'worker-1': {
              workerId: 'worker-1',
              runnerId: 'runner-1',
              healthy: true,
            },
          },
          runners: {
            'runner-1': {
              runnerId: 'runner-1',
              healthy: true,
            },
          },
          repoHealth: {
            'repo-1': { repoId: 'repo-1', status: 'healthy' },
          },
          observability: {
            exportFresh: false,
            telemetryStaleWorkers: [],
          },
        } as never,
      }),
    ).toBe('warming')

    expect(
      classifyHarnessSystemState({
        repoId: 'repo-1',
        state: {
          jobs: {},
          queue: [],
          workerHeartbeats: {
            'worker-1': {
              workerId: 'worker-1',
              runnerId: 'runner-1',
              healthy: true,
            },
          },
          runners: {
            'runner-1': {
              runnerId: 'runner-1',
              healthy: true,
            },
          },
          repoHealth: {
            'repo-1': { repoId: 'repo-1', status: 'healthy' },
          },
          observability: {
            exportFresh: true,
            telemetryStaleWorkers: [],
          },
        } as never,
      }),
    ).toBe('idle')
  })

  test('adds explicit remote auth failure tags for environment 401s', () => {
    expect(
      buildExecutionFailureTags({
        remoteDispatchSummary:
          'remote shadow dispatch unavailable: Failed to fetch environments: Request failed with status code 401',
      }),
    ).toEqual(['remote_dispatch_failed', 'remote_auth_failed'])
  })
})
