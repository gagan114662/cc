import { runHarnessDaemonWorker } from 'src/services/harness/runtime.js'
import { logError } from 'src/utils/log.js'

const POOLED_WORKER_START_STAGGER_MS = 150
const POOLED_WORKER_RESTART_DELAY_MS = Number(
  process.env.CLAUDE_CODE_HARNESS_WORKER_RESTART_DELAY_MS ?? '1000',
)

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function runPooledHarnessWorker(input: {
  runnerId: string
  agentKind: 'claude' | 'codex'
  workerSlots: number
  runnerLabels: string[]
  workerIndex: number
  shouldStop: () => boolean
}): Promise<void> {
  if (input.workerIndex > 0) {
    await sleep(input.workerIndex * POOLED_WORKER_START_STAGGER_MS)
  }

  while (!input.shouldStop()) {
    try {
      await runHarnessDaemonWorker(process.cwd(), {
        workerId: `${input.runnerId}-worker-${input.workerIndex + 1}`,
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
        `Harness pooled worker ${input.runnerId}-worker-${input.workerIndex + 1} crashed and will restart: ${error instanceof Error ? error.message : String(error)}`,
      )
      await sleep(POOLED_WORKER_RESTART_DELAY_MS)
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

        if (effectiveLeaseLimit > 1 && runnerId) {
          process.setMaxListeners(0)
          let stopping = false
          const stop = () => {
            stopping = true
          }
          process.on('SIGTERM', stop)
          process.on('SIGINT', stop)
          await Promise.all(
            Array.from({ length: effectiveLeaseLimit }, (_, index) =>
              runPooledHarnessWorker({
                runnerId,
                agentKind,
                workerSlots,
                runnerLabels,
                workerIndex: index,
                shouldStop: () => stopping,
              }),
            ),
          )
          return
        }

      await runHarnessDaemonWorker(process.cwd(), {
        workerId: process.env.CLAUDE_CODE_HARNESS_WORKER_ID,
        runnerId,
        agentKind,
        workerSlots,
        runnerLabels,
        leaseLimit: effectiveLeaseLimit,
      })
      return
      }
    default:
      throw new Error(`Unknown daemon worker kind: ${kind}`)
  }
}
