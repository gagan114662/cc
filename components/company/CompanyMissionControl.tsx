import React, { useEffect, useMemo, useState } from 'react'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type {
  MissionControlActionResult,
  MissionControlSnapshot,
} from '../../services/harness/types.js'
import {
  applyMissionControlAction,
  type CompanyMissionControl,
  getCompanyMissionControl,
} from '../../services/harness/company.js'
import { Box, Text, useInput } from '../../ink.js'
import { Dialog } from '../design-system/Dialog.js'
import TextInput from '../TextInput.js'

type Props = {
  onDone: LocalJSXCommandOnDone
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      <Box flexDirection="column" marginLeft={2}>
        {children}
      </Box>
    </Box>
  )
}

function renderList(lines: string[]): React.ReactNode {
  if (lines.length === 0) {
    return <Text dimColor>None yet.</Text>
  }
  return (
    <>
      {lines.map(line => (
        <Text key={line}>- {line}</Text>
      ))}
    </>
  )
}

function summarizeSpecialists(snapshot: MissionControlSnapshot): string[] {
  return snapshot.specialists.slice(0, 6).map(role => {
    const retired = role.status === 'retired' ? ' [retired]' : ''
    return `${role.title} (${role.domain}, ${role.agentKind})${retired}`
  })
}

function summarizeWorkstreams(snapshot: MissionControlSnapshot): string[] {
  const laneLines = snapshot.standingLanes.slice(0, 5).map(card => {
    const owner = card.ownerRole?.title ?? 'PM'
    const latest = card.latestArtifact
      ? `latest ${card.latestArtifact.artifactKind}`
      : 'no useful artifact yet'
    return `${card.lane.title} [${card.lane.cadence}] · ${owner} · readiness ${card.connectorReadiness} · ${latest}${card.nextScheduledAt ? ` · next ${card.nextScheduledAt.slice(0, 10)}` : ''}`
  })
  const workstreamLines = snapshot.workstreams.slice(0, 6).map(card => {
    const owner = card.ownerRole?.title ?? 'PM'
    const blocker = card.linkedExceptionId
      ? 'owner exception'
      : card.linkedGapId
        ? 'gap'
        : null
    return `${card.workstream.title} [${card.workstream.status}] · ${card.workstream.domain} · ${owner}${blocker ? ` · blocked by ${blocker}` : ''}${card.latestSummary ? ` · ${card.latestSummary}` : ''}`
  })
  return [...laneLines, ...workstreamLines]
}

function summarizeExceptions(snapshot: MissionControlSnapshot): string[] {
  return snapshot.exceptions.slice(0, 5).map(
    exception =>
      `${exception.title} [${exception.status}] · ${exception.summary}`,
  )
}

function summarizeGaps(snapshot: MissionControlSnapshot): string[] {
  return snapshot.gaps.slice(0, 5).map(
    gap => `${gap.kind} [${gap.status}] · ${gap.summary}`,
  )
}

function summarizeConnectorsAndPacks(snapshot: MissionControlSnapshot): string[] {
  const connectorPolicies = snapshot.connectorPolicies
    .slice(0, 4)
    .map(
      policy =>
        `Connector policy ${policy.connector} [${policy.status}] · lanes ${policy.laneTypes.join(', ') || 'none'}`,
    )
  const lines = snapshot.connectorRecommendations
    .slice(0, 3)
    .map(
      recommendation =>
        `Connector ${recommendation.connector} [${recommendation.status}] · ${recommendation.reason}`,
    )
  const activePacks = snapshot.packs
    .filter(pack => pack.status === 'active')
    .slice(0, 3)
    .map(pack => `Active pack ${pack.pack.title} · ${pack.reason}`)
  const availablePacks = snapshot.packs
    .filter(pack => pack.status !== 'active')
    .slice(0, 2)
    .map(pack => `Available pack ${pack.pack.title} [${pack.status}] · ${pack.reason}`)
  return [...connectorPolicies, ...lines, ...activePacks, ...availablePacks]
}

export function CompanyMissionControl({ onDone }: Props): React.ReactNode {
  const [mission, setMission] = useState<CompanyMissionControl | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)

  const loadMission = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await getCompanyMissionControl(process.cwd())
      setMission(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadMission()
  }, [])

  const runAction = async (
    action: Parameters<typeof applyMissionControlAction>[1],
  ): Promise<MissionControlActionResult | null> => {
    setBusyLabel(action.type)
    setError(null)
    try {
      const result = await applyMissionControlAction(process.cwd(), action)
      const refreshed = await getCompanyMissionControl(process.cwd())
      setMission(refreshed)
      setStatusLine(result.response ?? null)
      return result
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return null
    } finally {
      setBusyLabel(null)
    }
  }

  useInput((input, key) => {
    if (key.escape && !busyLabel) {
      onDone('', { display: 'inline' })
      return
    }
    if ((input === 'r' || input === 'R') && !busyLabel) {
      void runAction({ type: 'refresh_brief' })
    }
  })

  const snapshot = mission?.snapshot ?? null
  const title = snapshot?.company
    ? `Mission Control: ${snapshot.company.companyName}`
    : 'Mission Control'
  const subtitle = busyLabel
    ? `Working: ${busyLabel.replaceAll('_', ' ')}`
    : snapshot?.summary ?? 'Owner-facing PM console'
  const pmLines = useMemo(() => {
    if (!snapshot?.pm?.agent) {
      return ['No PM-led company is onboarded yet. Run `claude company onboard <url>` to start.']
    }
    return [
      `PM: ${snapshot.pm.agent.name} / ${snapshot.pm.agent.title}`,
      ...snapshot.pm.recentDecisions.slice(0, 3).map(
        decision => `Decision · ${decision.summary}`,
      ),
      ...snapshot.pm.recentMessages.slice(0, 2).map(
        ownerMessage => `Owner said · ${ownerMessage.text}`,
      ),
    ]
  }, [snapshot])

  const inputGuide = () => (
    <Text>
      Enter sends a PM message. Press <Text bold>r</Text> to refresh the company brief. Press <Text bold>Esc</Text> to close.
    </Text>
  )

  return (
    <Dialog
      title={title}
      subtitle={subtitle}
      onCancel={() => onDone('', { display: 'inline' })}
      isCancelActive={!busyLabel}
      inputGuide={inputGuide}
    >
      <Box flexDirection="column">
        {loading && <Text dimColor>Loading Mission Control…</Text>}
        {error && <Text color="error">{error}</Text>}
        {statusLine && <Text color="success">{statusLine}</Text>}

        {!loading && (
          <>
            <Section title="PM Chat">
              {renderList(pmLines)}
              <Box marginTop={1}>
                <Text dimColor>Message the PM:</Text>
              </Box>
              <TextInput
                value={message}
                onChange={value => {
                  setMessage(value)
                  setCursorOffset(value.length)
                }}
                onSubmit={async value => {
                  const text = value.trim()
                  if (!text) {
                    return
                  }
                  const result = await runAction({
                    type: 'send_pm_message',
                    text,
                  })
                  if (result) {
                    setMessage('')
                    setCursorOffset(0)
                  }
                }}
                columns={100}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor
              />
            </Section>

            <Section title="Company Brief">
              <Text>
                {snapshot?.company
                  ? `${snapshot.company.companyName} (${snapshot.company.businessArchetype}) · ${snapshot.company.graph.summary}`
                  : 'No company is onboarded yet.'}
              </Text>
              {snapshot?.operatingModel ? (
                <Text dimColor>
                  Buyers: {snapshot.operatingModel.buyerRoles.slice(0, 3).join(', ') || 'unknown'} · Channels: {snapshot.operatingModel.coreChannels.slice(0, 3).join(', ') || 'unknown'} · Lanes: {snapshot.operatingModel.recurringLaneNeeds.join(', ') || 'none'}
                </Text>
              ) : null}
              {snapshot?.company?.graph.evidence?.length ? (
                <Text dimColor>
                  Evidence: {snapshot.company.graph.evidence.slice(0, 4).join(', ')}
                </Text>
              ) : null}
            </Section>

            <Section title="Org Chart">
              {snapshot?.pm?.agent ? (
                <>
                  <Text>Owner-facing: {snapshot.pm.agent.title}</Text>
                  <Text dimColor>
                    Specialists are collapsed by default. Active specialists: {snapshot.specialists.filter(role => role.status === 'active').length}
                  </Text>
                </>
              ) : (
                <Text dimColor>No org yet.</Text>
              )}
              {renderList(snapshot ? summarizeSpecialists(snapshot) : [])}
            </Section>

            <Section title="Active Workstreams">
              {renderList(snapshot ? summarizeWorkstreams(snapshot) : [])}
              {snapshot?.usefulArtifacts.length ? (
                <Text dimColor>
                  Recent useful outputs: {snapshot.usefulArtifacts
                    .slice(0, 3)
                    .map(artifact => `${artifact.artifactKind} (${artifact.createdAt.slice(0, 10)})`)
                    .join(', ')}
                </Text>
              ) : null}
            </Section>

            <Section title="Exceptions + Gaps">
              {renderList([
                ...(snapshot ? summarizeExceptions(snapshot) : []),
                ...(snapshot ? summarizeGaps(snapshot) : []),
              ])}
            </Section>

            <Section title="Connector Recommendations + Pack Catalog">
              {renderList(snapshot ? summarizeConnectorsAndPacks(snapshot) : [])}
              {snapshot ? (
                <Text dimColor>
                  Metrics · owner touches {snapshot.metrics.ownerTouchCount}, active workstreams {snapshot.metrics.activeWorkstreamCount}, open exceptions {snapshot.metrics.openExceptionCount}
                </Text>
              ) : null}
            </Section>
          </>
        )}
      </Box>
    </Dialog>
  )
}
