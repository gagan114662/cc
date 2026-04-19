import {
  getCompanyMissionControl,
  onboardCompany,
  refreshCompanyBrief,
  recordOwnerMessage,
} from 'src/services/harness/company.js'

function readFlagValue(args: string[], flag: string): string | undefined {
  const exact = args.find(arg => arg.startsWith(`${flag}=`))
  if (exact) {
    return exact.slice(flag.length + 1)
  }
  const index = args.findIndex(arg => arg === flag)
  return index >= 0 ? args[index + 1] : undefined
}

function readFlagValues(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === flag && args[index + 1]) {
      values.push(args[index + 1]!)
      index += 1
      continue
    }
    if (arg?.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1))
    }
  }
  return values
}

function formatMissionControl(
  snapshot: Awaited<ReturnType<typeof getCompanyMissionControl>>,
): string {
  if (!snapshot.company || !snapshot.pmAgent) {
    return 'No company is onboarded yet. Run `claude company onboard <url>` to create a PM-led org.'
  }
  const workstreamLines = snapshot.workstreams
    .slice(0, 6)
    .map(
      workstream =>
        `  - ${workstream.title} [${workstream.status}] (${workstream.domain})`,
    )
  const laneLines = snapshot.standingLanes
    .slice(0, 6)
    .map(
      laneCard =>
        `  - ${laneCard.lane.title} [${laneCard.lane.cadence}] readiness=${laneCard.connectorReadiness}${laneCard.latestArtifact ? ` latest=${laneCard.latestArtifact.artifactKind}` : ''}`,
    )
  const artifactLines = snapshot.usefulArtifacts
    .slice(0, 4)
    .map(
      artifact =>
        `  - ${artifact.artifactKind}: ${artifact.title} (${artifact.createdAt.slice(0, 10)})`,
    )
  const exceptionLines = snapshot.exceptions
    .filter(exception => exception.status === 'open')
    .slice(0, 4)
    .map(exception => `  - ${exception.title}: ${exception.summary}`)
  const gapLines = snapshot.gaps
    .filter(gap => gap.status === 'open')
    .slice(0, 4)
    .map(gap => `  - ${gap.kind}: ${gap.summary}`)
  const connectorLines = snapshot.connectorRecommendations
    .filter(recommendation => recommendation.status === 'pending')
    .slice(0, 4)
    .map(
      recommendation =>
        `  - ${recommendation.connector}: ${recommendation.reason}`,
    )

  return [
    `${snapshot.company.companyName} (${snapshot.company.businessArchetype})`,
    `PM: ${snapshot.pmAgent.name} / ${snapshot.pmAgent.title}`,
    snapshot.summary,
    `queue: ${snapshot.queuedCount}`,
    `active: ${snapshot.activeCount}`,
    `specialists: ${snapshot.specialistAgents.length}`,
    `standing lanes: ${snapshot.standingLanes.length}`,
    `observability: internal=${snapshot.observability.internalQueryLive ? 'live' : 'down'}, export=${snapshot.observability.honeycombExportLive ? 'live' : 'down'}, query=${snapshot.observability.honeycombQueryLive ? 'live' : 'unavailable'}`,
    'lanes:',
    ...(laneLines.length > 0 ? laneLines : ['  - none']),
    'workstreams:',
    ...(workstreamLines.length > 0 ? workstreamLines : ['  - none']),
    'useful artifacts:',
    ...(artifactLines.length > 0 ? artifactLines : ['  - none']),
    'exceptions:',
    ...(exceptionLines.length > 0 ? exceptionLines : ['  - none']),
    'gaps:',
    ...(gapLines.length > 0 ? gapLines : ['  - none']),
    'connector recommendations:',
    ...(connectorLines.length > 0 ? connectorLines : ['  - none']),
  ].join('\n')
}

export async function companyMain(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status'
  const json = args.includes('--json')

  if (
    subcommand === '--help' ||
    subcommand === '-h' ||
    subcommand === 'help'
  ) {
    console.log(
      'Usage: claude company [onboard <website-url> [--social <url>]...|status [--company <id>]|message <text> [--company <id>]|refresh [--company <id>]] [--json]',
    )
    return
  }

  switch (subcommand) {
    case 'onboard': {
      const websiteUrl = args[1]
      if (!websiteUrl) {
        throw new Error(
          'Usage: claude company onboard <website-url> [--social <url>]... [--json]',
        )
      }
      const socialUrls = readFlagValues(args, '--social')
      const snapshot = await onboardCompany(process.cwd(), {
        websiteUrl,
        socialUrls,
      })
      if (json) {
        console.log(JSON.stringify(snapshot, null, 2))
      } else {
        console.log(formatMissionControl(snapshot))
      }
      return
    }
    case 'status': {
      const companyId = readFlagValue(args, '--company')
      const snapshot = await getCompanyMissionControl(process.cwd(), companyId)
      if (json) {
        console.log(JSON.stringify(snapshot, null, 2))
      } else {
        console.log(formatMissionControl(snapshot))
      }
      return
    }
    case 'message': {
      const companyId = readFlagValue(args, '--company')
      const messageParts: string[] = []
      for (let index = 1; index < args.length; index += 1) {
        const arg = args[index]
        if (arg === '--company') {
          index += 1
          continue
        }
        if (arg?.startsWith('--company=')) {
          continue
        }
        if (arg === '--json') {
          continue
        }
        messageParts.push(arg)
      }
      const text = messageParts.join(' ').trim()
      if (!text) {
        throw new Error(
          'Usage: claude company message <text> [--company <id>] [--json]',
        )
      }
      const result = await recordOwnerMessage(process.cwd(), {
        companyId,
        text,
      })
      if (json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(result.response)
      }
      return
    }
    case 'refresh': {
      const companyId = readFlagValue(args, '--company')
      const snapshot = await refreshCompanyBrief(process.cwd(), companyId)
      if (json) {
        console.log(JSON.stringify(snapshot, null, 2))
      } else {
        console.log(formatMissionControl(snapshot))
      }
      return
    }
    default:
      throw new Error(
        'Usage: claude company [onboard <website-url> [--social <url>]...|status [--company <id>]|message <text> [--company <id>]|refresh [--company <id>]] [--json]',
      )
  }
}
