import { describe, expect, test } from 'bun:test'
import {
  getPooledWorkerRestartDelayMs,
  resolveHarnessWorkerExecution,
} from 'src/daemon/workerRegistry.js'

describe('worker registry', () => {
  test('falls back to the default restart delay when the env var is invalid', () => {
    expect(getPooledWorkerRestartDelayMs('not-a-number')).toBe(1000)
    expect(getPooledWorkerRestartDelayMs('-25')).toBe(1000)
    expect(getPooledWorkerRestartDelayMs('2500')).toBe(2500)
  })

  test('supervises single-worker runners when a runner id is available', () => {
    const execution = resolveHarnessWorkerExecution({
      workerId: 'claude-primary-worker-1',
      runnerId: 'claude-primary',
      agentKind: 'claude',
      workerSlots: 1,
      runnerLabels: ['shared', 'cc', 'claude'],
      effectiveLeaseLimit: 1,
    })

    expect(execution.kind).toBe('supervised')
    if (execution.kind !== 'supervised') {
      throw new Error('expected supervised worker execution')
    }

    expect(execution.workers).toEqual([
      {
        workerId: 'claude-primary-worker-1',
        runnerId: 'claude-primary',
        agentKind: 'claude',
        workerSlots: 1,
        runnerLabels: ['shared', 'cc', 'claude'],
        workerIndex: 0,
      },
    ])
  })

  test('runs directly when no runner id is configured', () => {
    const execution = resolveHarnessWorkerExecution({
      workerId: 'ad-hoc-worker',
      agentKind: 'codex',
      workerSlots: 3,
      runnerLabels: ['adhoc'],
      effectiveLeaseLimit: 2,
    })

    expect(execution).toEqual({
      kind: 'direct',
      workerId: 'ad-hoc-worker',
      runnerId: undefined,
      agentKind: 'codex',
      workerSlots: 3,
      runnerLabels: ['adhoc'],
      leaseLimit: 2,
    })
  })
})
