import { runHarnessDaemonWorker } from 'src/services/harness/runtime.js'
import { logError } from 'src/utils/log.js'

const POOLED_WORKER_START_STAGGER_MS = 150
const DEFAULT_POOLED_WORKER_RESTART_DELAY_MS = 1000

type HarnessWorkerDescriptor = {
  workerId: string
  runnerId: string
  agentKind: 'claude' | 'codex'
  workerSlots: number
  runnerLabels: string[]
  workerIndex: number
}

type HarnessWorkerExecution =
  | {
      kind: 'supervised'
      workers: HarnessWorkerDescriptor[]
    }
  | {
      kind: 'direct'
      workerId?: string
      runnerId?: string
      agentKind: 'claude' | 'codex'
      workerSlots: number
      runnerLabels: string[]
      leaseLimit: number
    }

export function getPooledWorkerRestartDelayMs(
  value = process.env.CLAUDE_CODE_HARNESS_WORKER_RESTART_DELAY_MS,
): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_POOLED_WORKER_RESTART_DELAY_MS
}

export function resolveHarnessWorkerExecution(input: {
  workerId?: string
  runnerId?: string
  agentKind: 'claude' | 'codex'
  workerSlots: number
  runnerLabels: string[]
  effectiveLeaseLimit: number
}): HarnessWorkerExecution {
  if (input.runnerId) {
    return {
      kind: 'supervised',
      workers: Array.from({ length: input.effectiveLeaseLimit }, (_, index) => ({
        workerId:
          input.effectiveLeaseLimit === 1
            ? input.workerId ?? `${input.runnerId}-worker-1`
            : `${input.runnerId}-worker-${index + 1}`,
        runnerId: input.runnerId,
        agentKind: input.agentKind,
        workerSlots: input.workerSlots,
        runnerLabels: input.runnerLabels,
        workerIndex: index,
      })),
    }
  }

  return {
    kind: 'direct',
    workerId: input.workerId,
    runnerId: input.runnerId,
    agentKind: input.agentKind,
    workerSlots: input.workerSlots,
    runnerLabels: input.runnerLabels,
    leaseLimit: input.effectiveLeaseLimit,
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function runSupervisedHarnessWorker(input: HarnessWorkerDescriptor & {
  shouldStop: () => boolean
}): Promise<void> {
  if (input.workerIndex > 0) {
    await sleep(input.workerIndex * POOLED_WORKER_START_STAGGER_MS)
  }

  while (!input.shouldStop()) {
    try {
      await runHarnessDaemonWorker(process.cwd(), {
        workerId: input.workerId,
        runnerId: input.runnerId,
        agentKind: input.agentKind,
        workerSlots: input.workerSlots,
        runnerLabels: input.runnerLabels,
        leaseLimit: 1,
      })
      return
    } catch (error) {
      if (input.shouldStop()) {
        return
      }
      logError(
        `Harness worker ${input.workerId} crashed and will restart: ${error instanceof Error ? error.message : String(error)}`,
      )
      await sleep(getPooledWorkerRestartDelayMs())
    }
  }
}

export async function runDaemonWorker(kind: string): Promise<void> {
  switch (kind) {
    case 'harness':
      {
        const workerSlots = Number(
          process.env.CLAUDE_CODE_HARNESS_WORKER_SLOTS ??
            process.env.CLAUDE_CODE_HARNESS_WORKERS ??
            '1',
        )
        const leaseLimit = Number(
          process.env.CLAUDE_CODE_HARNESS_LEASE_LIMIT ?? '1',
        )
        const runnerId = process.env.CLAUDE_CODE_HARNESS_RUNNER_ID
        const agentKind =
          process.env.CLAUDE_CODE_HARNESS_AGENT_KIND === 'codex'
            ? 'codex'
            : 'claude'
        const runnerLabels = (process.env.CLAUDE_CODE_HARNESS_RUNNER_LABELS ?? '')
          .split(',')
          .map(label => label.trim())
          .filter(Boolean)
        const effectiveLeaseLimit = Number.isFinite(leaseLimit)
          ? Math.max(1, Math.min(Math.max(1, workerSlots), leaseLimit))
          : 1

        const execution = resolveHarnessWorkerExecution({
          workerId: process.env.CLAUDE_CODE_HARNESS_WORKER_ID,
          runnerId,
          agentKind,
          workerSlots,
          runnerLabels,
          effectiveLeaseLimit,
        })

        if (execution.kind === 'supervised') {
          process.setMaxListeners(0)
          let stopping = false
          const stop = () => {
            stopping = true
          }
          process.on('SIGTERM', stop)
          process.on('SIGINT', stop)
          await Promise.all(
            execution.workers.map(worker =>
              runSupervisedHarnessWorker({
                ...worker,
                shouldStop: () => stopping,
              }),
            ),
          )
          return
        }

        await runHarnessDaemonWorker(process.cwd(), execution)
        return
      }
    default:
      throw new Error(`Unknown daemon worker kind: ${kind}`)
  }
}
