import { basename } from 'node:path'
import { getCwd } from '../utils/cwd.js'
import { getSessionId } from '../bootstrap/state.js'
import { formatAgentId } from '../utils/agentId.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import {
  type TeamFile,
  getTeamFilePath,
  sanitizeName,
  writeTeamFileAsync,
} from '../utils/swarm/teamHelpers.js'
import { setCliTeammateModeOverride } from '../utils/swarm/backends/teammateModeSnapshot.js'
import { setLeaderTeamName } from '../utils/tasks.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

let assistantForced = false

function getAssistantSettings(): {
  assistant?: boolean
  assistantName?: string
} {
  return (getSettings_DEPRECATED() || {}) as {
    assistant?: boolean
    assistantName?: string
  }
}

function getAssistantTeamName(): string {
  const cwdName = basename(getCwd()) || 'assistant'
  return sanitizeName(`assistant-${cwdName}`) || 'assistant'
}

export function markAssistantForced(): void {
  assistantForced = true
}

export function isAssistantForced(): boolean {
  return assistantForced
}

export function isAssistantMode(): boolean {
  return assistantForced || getAssistantSettings().assistant === true
}

export function getAssistantActivationPath(): string {
  return assistantForced ? 'cli-flag' : 'settings'
}

export function getAssistantSystemPromptAddendum(): string {
  const assistantName = getAssistantSettings().assistantName || 'Assistant'
  return [
    '# Assistant Mode',
    `${assistantName} is running in assistant mode.`,
    'Prefer concise user-facing updates, keep ownership of follow-ups, and maintain continuity across restarts.',
    'Use proactive check-ins, teammate orchestration, and persistent project context when useful.',
  ].join('\n\n')
}

export async function initializeAssistantTeam(): Promise<{
  teamName: string
  teamFilePath: string
  leadAgentId: string
  teammates: Record<
    string,
    { name: string; agentType: string; color: string; cwd: string; spawnedAt: number }
  >
}> {
  setCliTeammateModeOverride('in-process')

  const teamName = getAssistantTeamName()
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
  const now = Date.now()
  const teamFilePath = getTeamFilePath(teamName)
  const teamFile: TeamFile = {
    name: teamName,
    description: 'Assistant mode lead team',
    createdAt: now,
    leadAgentId,
    leadSessionId: getSessionId(),
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        agentType: 'assistant-lead',
        joinedAt: now,
        tmuxPaneId: '',
        cwd: getCwd(),
        sessionId: getSessionId(),
        subscriptions: [],
      },
    ],
  }

  await writeTeamFileAsync(teamName, teamFile)
  setLeaderTeamName(sanitizeName(teamName))

  return {
    teamName,
    teamFilePath,
    leadAgentId,
    teammates: {
      [leadAgentId]: {
        name: TEAM_LEAD_NAME,
        agentType: 'assistant-lead',
        color: 'cyan',
        cwd: getCwd(),
        spawnedAt: now,
      },
    },
  }
}
