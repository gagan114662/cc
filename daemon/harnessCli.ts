import { readFile } from 'node:fs/promises'
import {
  annotateHarnessIncident,
  getHarnessPullRequestQuality,
  getHarnessQualityStatus,
  getHarnessStatus,
  ingestGitHubWebhookEvent,
  pauseHarness,
  resumeHarness,
  runHarnessJob,
} from 'src/services/harness/runtime.js'

function formatStatus(status: Awaited<ReturnType<typeof getHarnessStatus>>): string {
  const recent = status.state.history[0]
  return [
    `paused: ${status.state.paused ? 'yes' : 'no'}`,
    `control plane: ${status.controlPlane.kind}`,
    `queue: ${status.queuedCount}`,
    `active: ${status.activeCount}`,
    `runners: ${status.runners.length}`,
    `fleet: expected ${status.fleet.expectedRunners.length}, registered ${status.fleet.registeredRunners.length}, missing ${status.fleet.missingRunners.length}`,
    `slots: ${status.totalSlotCapacity} (claude ${status.slotCapacityByAgentKind.claude}, codex ${status.slotCapacityByAgentKind.codex})`,
    `fleet slots: expected ${status.fleet.expectedSlotCapacity}, registered ${status.fleet.registeredSlotCapacity}, missing ${status.fleet.missingSlots}`,
    `active by kind: claude ${status.activeByAgentKind.claude}, codex ${status.activeByAgentKind.codex}`,
    `capacity shortfalls: claude ${status.queuedCapacityShortfalls.claude}, codex ${status.queuedCapacityShortfalls.codex}`,
    `observability: internal=${status.observability.internalQueryLive ? 'live' : 'down'}, export=${status.observability.honeycombExportLive ? 'live' : 'down'}, query=${status.observability.honeycombQueryLive ? 'live' : 'unavailable'}`,
    `telemetry: last export ${status.observability.exportLastSuccessAt ?? 'never'}, fresh=${status.observability.exportFresh ? 'yes' : 'no'}, loaded workers=${status.observability.observabilityEnvLoadedWorkers.length}, stale workers=${status.observability.telemetryStaleWorkers.length}`,
    `jobs configured: ${status.config.jobs.length}`,
    `reviewers configured: ${status.config.reviewers.length}`,
    recent ? `last outcome: ${recent.jobId} (${recent.status})` : 'last outcome: none',
  ].join('\n')
}

function formatQualityStatus(
  status: Awaited<ReturnType<typeof getHarnessQualityStatus>>,
): string {
  const snapshots = [...status.quality.snapshots].sort(
    (left, right) => left.windowDays - right.windowDays,
  )
  const lines = [
    `repo: ${status.state.repos[status.quality.repoId]?.repoNameWithOwner ?? status.quality.repoId}`,
    `open incidents: ${status.quality.openIncidentCount} (${status.quality.openCriticalIncidentCount} critical)`,
  ]
  for (const snapshot of snapshots) {
    lines.push(
      `${snapshot.windowDays}d: deployed=${snapshot.deployedPrCount}, premerge=${snapshot.preMergeFindingCount}, escaped=${snapshot.postMergeIncidentCount}, CFR=${snapshot.changeFailureRate.toFixed(4)}, escaped rate=${snapshot.escapedBugRate.toFixed(4)}, MTTD=${snapshot.meanTimeToDetectMs}ms, MTTR=${snapshot.meanTimeToRecoverMs}ms`,
    )
  }
  const hottest = status.quality.recentPrs
    .slice(0, 5)
    .map(
      pr =>
        `#${pr.record.prNumber} ${pr.metrics.postMergeIncidentCount > 0 ? 'post-merge issues' : 'clean'} premerge=${pr.metrics.preMergeFindingCount} escaped=${pr.metrics.postMergeIncidentCount} size=${pr.logicalChangeSize?.weightedSize ?? 0}`,
    )
  if (hottest.length > 0) {
    lines.push('recent PRs:')
    lines.push(...hottest.map(line => `  ${line}`))
  }
  return lines.join('\n')
}

function formatPullRequestQuality(
  status: Awaited<ReturnType<typeof getHarnessPullRequestQuality>>,
): string {
  if (!status.quality) {
    return 'No quality record found for that PR.'
  }
  const quality = status.quality
  return [
    `PR #${quality.record.prNumber}: ${quality.record.title}`,
    `state: ${quality.record.state}`,
    `logical size: ${quality.logicalChangeSize?.weightedSize ?? 0}`,
    `pre-merge findings: ${quality.metrics.preMergeFindingCount}`,
    `post-merge incidents: ${quality.metrics.postMergeIncidentCount}`,
    `reverts: ${quality.metrics.revertCount}`,
    `change failure: ${quality.metrics.changeFailure ? 'yes' : 'no'}`,
    `MTTD: ${quality.metrics.meanTimeToDetectMs}ms`,
    `MTTR: ${quality.metrics.meanTimeToRecoverMs}ms`,
    `pre-merge density: ${quality.metrics.preMergeDefectDensity.toFixed(4)}`,
    `escaped density: ${quality.metrics.escapedDefectDensity.toFixed(4)}`,
  ].join('\n')
}

export async function harnessMain(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status'
  const json = args.includes('--json')

  switch (subcommand) {
    case 'status': {
      const status = await getHarnessStatus(process.cwd())
      if (json) {
        console.log(JSON.stringify(status, null, 2))
      } else {
        console.log(formatStatus(status))
      }
      return
    }
    case 'quality': {
      const qualityCommand = args[1] ?? 'status'
      switch (qualityCommand) {
        case 'status': {
          const status = await getHarnessQualityStatus(process.cwd())
          if (json) {
            console.log(JSON.stringify(status, null, 2))
          } else {
            console.log(formatQualityStatus(status))
          }
          return
        }
        case 'pr': {
          const prNumber = Number(args[2] ?? '')
          if (!Number.isFinite(prNumber) || prNumber <= 0) {
            throw new Error('Usage: claude harness quality pr <number>')
          }
          const status = await getHarnessPullRequestQuality(process.cwd(), prNumber)
          if (json) {
            console.log(JSON.stringify(status, null, 2))
          } else {
            console.log(formatPullRequestQuality(status))
          }
          return
        }
        case 'annotate-incident': {
          const prFlagIndex = args.findIndex(arg => arg === '--pr')
          const summaryFlagIndex = args.findIndex(arg => arg === '--summary')
          const severityFlagIndex = args.findIndex(arg => arg === '--severity')
          const detectedAtFlagIndex = args.findIndex(arg => arg === '--detected-at')
          const mergeShaFlagIndex = args.findIndex(arg => arg === '--merge-sha')
          const prNumber =
            prFlagIndex >= 0 ? Number(args[prFlagIndex + 1] ?? '') : Number.NaN
          const summary =
            summaryFlagIndex >= 0 ? args[summaryFlagIndex + 1] ?? '' : ''
          const severity =
            severityFlagIndex >= 0
              ? args[severityFlagIndex + 1] ?? 'high'
              : 'high'
          if (!Number.isFinite(prNumber) || prNumber <= 0 || !summary) {
            throw new Error(
              'Usage: claude harness quality annotate-incident --pr <number> --summary <text> [--severity low|medium|high|critical] [--detected-at <iso>] [--merge-sha <sha>]',
            )
          }
          const result = await annotateHarnessIncident(process.cwd(), {
            prNumber,
            summary,
            severity:
              severity === 'low' ||
              severity === 'medium' ||
              severity === 'high' ||
              severity === 'critical'
                ? severity
                : 'high',
            detectedAt:
              detectedAtFlagIndex >= 0
                ? args[detectedAtFlagIndex + 1]
                : undefined,
            mergeSha:
              mergeShaFlagIndex >= 0 ? args[mergeShaFlagIndex + 1] : undefined,
          })
          if (json) {
            console.log(JSON.stringify(result, null, 2))
          } else {
            console.log(
              `Annotated incident ${result.incident.id} for PR #${result.incident.prNumber}.`,
            )
          }
          return
        }
        default:
          throw new Error(
            'Usage: claude harness quality [status|pr <number>|annotate-incident --pr <number> --summary <text> [--severity low|medium|high|critical] [--detected-at <iso>] [--merge-sha <sha>]] [--json]',
          )
      }
    }
    case 'run': {
      const jobId = args[1]
      if (!jobId) {
        throw new Error('Usage: claude harness run <job-id>')
      }
      const result = await runHarnessJob(process.cwd(), jobId)
      console.log(`Harness job ${jobId} executed as ${result.instanceId}.`)
      return
    }
    case 'pause':
      await pauseHarness(process.cwd(), 'paused via harness command')
      console.log('Harness paused.')
      return
    case 'resume':
      await resumeHarness(process.cwd())
      console.log('Harness resumed.')
      return
    case 'webhook': {
      const provider = args[1]
      const eventName = args[2]
      const fileFlagIndex = args.findIndex(arg => arg === '--file')
      const filePath =
        fileFlagIndex >= 0 && args[fileFlagIndex + 1]
          ? args[fileFlagIndex + 1]
          : undefined

      if (provider !== 'github' || !eventName || !filePath) {
        throw new Error(
          'Usage: claude harness webhook github <event-name> --file <payload.json>',
        )
      }

      const payload = JSON.parse(await readFile(filePath, 'utf-8')) as Record<
        string,
        unknown
      >
      const result = await ingestGitHubWebhookEvent(
        process.cwd(),
        eventName,
        payload,
      )
      if (json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(
          `Ingested ${eventName}; enqueued ${result.enqueued.length} harness job(s).`,
        )
      }
      return
    }
    default:
      throw new Error(
        'Usage: claude harness [status|quality ...|run <job-id>|pause|resume|webhook github <event-name> --file <payload.json>] [--json]',
      )
  }
}
