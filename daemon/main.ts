import { execa } from 'execa'
import {
  getHarnessStatus,
  pauseHarness,
  readDaemonControl,
  resumeHarness,
  runHarnessDaemonWorker,
  runHarnessJob,
  writeDaemonControl,
} from 'src/services/harness/runtime.js'

function formatStatus(status: Awaited<ReturnType<typeof getHarnessStatus>>): string {
  const recent = status.state.history[0]
  const repoHealth = Object.values(status.state.repoHealth)[0]
  return [
    `paused: ${status.state.paused ? 'yes' : 'no'}`,
    `repo health: ${repoHealth?.status ?? 'healthy'}`,
    `queue: ${status.queuedCount}`,
    `active: ${status.activeCount}`,
    `runners: ${status.runners.length}`,
    `fleet: expected ${status.fleet.expectedRunners.length}, registered ${status.fleet.registeredRunners.length}, missing ${status.fleet.missingRunners.length}`,
    `slots: ${status.totalSlotCapacity} (claude ${status.slotCapacityByAgentKind.claude}, codex ${status.slotCapacityByAgentKind.codex})`,
    `fleet slots: expected ${status.fleet.expectedSlotCapacity}, registered ${status.fleet.registeredSlotCapacity}, missing ${status.fleet.missingSlots}`,
    `active by kind: claude ${status.activeByAgentKind.claude}, codex ${status.activeByAgentKind.codex}`,
    `shortfalls: claude ${status.queuedCapacityShortfalls.claude}, codex ${status.queuedCapacityShortfalls.codex}`,
    `observability: internal=${status.observability.internalQueryLive ? 'live' : 'down'}, export=${status.observability.honeycombExportLive ? 'live' : 'down'}, query=${status.observability.honeycombQueryLive ? 'live' : 'unavailable'}`,
    `telemetry: last export ${status.observability.exportLastSuccessAt ?? 'never'}, fresh=${status.observability.exportFresh ? 'yes' : 'no'}, loaded workers=${status.observability.observabilityEnvLoadedWorkers.length}, stale workers=${status.observability.telemetryStaleWorkers.length}`,
    `last poll: ${status.state.lastPolledAt ?? 'never'}`,
    recent ? `last outcome: ${recent.jobId} (${recent.status})` : 'last outcome: none',
  ].join('\n')
}

async function printStatus(json: boolean): Promise<void> {
  const status = await getHarnessStatus(process.cwd())
  const control = await readDaemonControl(process.cwd())
  const liveWorkerPids = Array.from(
    new Set(
      Object.values(status.state.workerHeartbeats)
        .map(heartbeat => heartbeat.pid)
        .filter((pid): pid is number => typeof pid === 'number'),
    ),
  )
  if (json) {
    console.log(
      JSON.stringify(
        {
          daemon: control,
          harness: status,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(
    [
      `daemon pid: ${control.pid ?? 'not running'}`,
      `control plane: ${status.controlPlane.kind}`,
      `worker pids: ${liveWorkerPids.join(', ') || 'none'}`,
      `daemon heartbeat: ${control.lastHeartbeatAt ?? 'never'}`,
      `registered runners: ${status.runners.map(runner => `${runner.runnerId}:${runner.agentKind}:${runner.slotCapacity}`).join(', ') || 'none'}`,
      formatStatus(status),
    ].join('\n'),
  )
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const exact = args.find(arg => arg.startsWith(`${flag}=`))
  if (exact) {
    return exact.slice(flag.length + 1)
  }
  const index = args.findIndex(arg => arg === flag)
  return index >= 0 ? args[index + 1] : undefined
}

export async function daemonMain(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status'
  const json = args.includes('--json')
  switch (subcommand) {
    case 'start': {
      const workerSlots = Math.max(
        1,
        Number(
          readFlagValue(args, '--worker-slots') ??
            readFlagValue(args, '--workers') ??
            process.env.CLAUDE_CODE_HARNESS_WORKER_SLOTS ??
            process.env.CLAUDE_CODE_HARNESS_WORKERS ??
            '4',
        ),
      )
      const runnerId =
        readFlagValue(args, '--runner-id') ??
        process.env.CLAUDE_CODE_HARNESS_RUNNER_ID ??
        `runner-${process.pid}`
      const agentKind =
        readFlagValue(args, '--agent-kind') ??
        process.env.CLAUDE_CODE_HARNESS_AGENT_KIND ??
        'claude'
      const labels = (
        readFlagValue(args, '--labels') ??
        process.env.CLAUDE_CODE_HARNESS_RUNNER_LABELS ??
        ''
      )
        .split(',')
        .map(label => label.trim())
        .filter(Boolean)
      if (args.includes('--foreground')) {
        await runHarnessDaemonWorker(process.cwd(), {
          workerId: 'foreground-worker',
          runnerId,
          agentKind:
            agentKind === 'codex' ? 'codex' : 'claude',
          workerSlots,
          runnerLabels: labels,
          leaseLimit: workerSlots,
        })
        return
      }

      const workerPids: number[] = []
      for (let index = 0; index < workerSlots; index += 1) {
        const child = execa(process.execPath, [process.argv[1]!, '--daemon-worker', 'harness'], {
          cwd: process.cwd(),
          detached: true,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
          env: {
            ...process.env,
            CLAUDE_CODE_HARNESS_WORKER_ID: `${runnerId}-worker-${index + 1}`,
            CLAUDE_CODE_HARNESS_RUNNER_ID: runnerId,
            CLAUDE_CODE_HARNESS_AGENT_KIND: agentKind,
            CLAUDE_CODE_HARNESS_WORKER_SLOTS: String(workerSlots),
            CLAUDE_CODE_HARNESS_RUNNER_LABELS: labels.join(','),
            CLAUDE_CODE_HARNESS_LEASE_LIMIT: '1',
          },
        })
        child.unref?.()
        if (child.pid) {
          workerPids.push(child.pid)
        }
      }
      await writeDaemonControl(process.cwd(), {
        pid: process.pid,
        workerPids,
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: undefined,
        mode: 'hosted',
      })
      console.log(
        `Harness daemon started (${workerPids.length} workers, runner ${runnerId}, ${agentKind}, ${workerSlots} slots).`,
      )
      return
    }
    case 'status':
      await printStatus(json)
      return
    case 'stop': {
      const control = await readDaemonControl(process.cwd())
      for (const pid of control.workerPids ?? []) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // Process already exited.
        }
      }
      await writeDaemonControl(process.cwd(), {})
      console.log('Harness daemon stopped.')
      return
    }
    case 'pause':
      await pauseHarness(process.cwd(), 'paused via daemon command')
      console.log('Harness paused.')
      return
    case 'resume':
      await resumeHarness(process.cwd())
      console.log('Harness resumed.')
      return
    case 'run': {
      const jobId = args[1]
      if (!jobId) {
        throw new Error('Usage: claude daemon run <job-id>')
      }
      const result = await runHarnessJob(process.cwd(), jobId)
      console.log(`Harness job ${jobId} executed as ${result.instanceId}.`)
      return
    }
    default:
      throw new Error(
        'Usage: claude daemon [start|status|stop|pause|resume|run <job-id>] [--json] [--foreground] [--workers=N|--worker-slots=N] [--runner-id=ID] [--agent-kind=claude|codex] [--labels=a,b]',
      )
  }
}
