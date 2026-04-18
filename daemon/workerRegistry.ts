import { runHarnessDaemonWorker } from 'src/services/harness/runtime.js'

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
          await Promise.all(
            Array.from({ length: effectiveLeaseLimit }, (_, index) =>
              runHarnessDaemonWorker(process.cwd(), {
                workerId: `${runnerId}-worker-${index + 1}`,
                runnerId,
                agentKind,
                workerSlots,
                runnerLabels,
                leaseLimit: 1,
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
