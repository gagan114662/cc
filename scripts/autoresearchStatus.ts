import path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { parseSettingsFile } from 'src/utils/settings/settings.js'
import { resolveAutoresearchConfig } from 'src/services/autoresearch/runtime.js'
import { summarizeClaudeCodeSessionObservations } from 'src/services/autoresearch/claudeCodeSessions.js'
import {
  ClaudeCodeSessionObservationSchema,
  RolloutStateSchema,
  type ClaudeCodeSessionObservation,
} from 'src/services/autoresearch/types.js'

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function collectClaudeCodeObservations(
  directoryPath: string,
): Promise<ClaudeCodeSessionObservation[]> {
  let entries: string[]
  try {
    entries = await readdir(directoryPath)
  } catch {
    return []
  }

  const observations: ClaudeCodeSessionObservation[] = []
  for (const entry of entries.filter(name => name.endsWith('.json')).sort()) {
    const filePath = path.join(directoryPath, entry)
    const parsed = await readJsonFile<unknown>(filePath)
    if (!parsed) {
      continue
    }
    observations.push(ClaudeCodeSessionObservationSchema().parse(parsed))
  }
  return observations
}

const repoRoot = path.resolve(import.meta.dir, '..')
const projectSettingsPath = path.join(repoRoot, '.claude', 'settings.json')
const { settings, errors } = parseSettingsFile(projectSettingsPath)
if (errors.length > 0) {
  throw new Error(
    `Failed to parse ${projectSettingsPath}: ${errors.map(error => error.message).join('; ')}`,
  )
}

const resolved = await resolveAutoresearchConfig(repoRoot, settings?.autoresearch)
if (!resolved.enabled) {
  throw new Error(resolved.invalidReason ?? 'Autoresearch is disabled.')
}

const observationDir = path.join(
  resolved.statePath,
  'incoming',
  'claude-code-sessions',
)
const statePath = path.join(resolved.statePath, 'state.json')
const observations = await collectClaudeCodeObservations(observationDir)
const trend = summarizeClaudeCodeSessionObservations(observations)
const state = await readJsonFile<unknown>(statePath)
const parsedState = state ? RolloutStateSchema().parse(state) : null
const recentRegressions = observations
  .filter(observation => observation.actualRegression || observation.failureTags.length > 0)
  .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
  .slice(0, 5)
  .map(observation => ({
    sessionId: observation.sessionId,
    eventType: observation.eventType,
    recordedAt: observation.recordedAt,
    failureTags: observation.failureTags,
    summary: observation.summary,
  }))

const payload = {
  repoRoot,
  statePath: resolved.statePath,
  currentChampionCandidateId: parsedState?.currentChampionCandidateId,
  teacherFrozen: parsedState?.teacherFrozen ?? false,
  totalObservations: trend.totalObservationCount,
  totalSessions: trend.totalSessionCount,
  successSessions: trend.successSessionCount,
  regressionSessions: trend.regressionSessionCount,
  highConfidenceRegressionSessions: trend.highConfidenceRegressionSessionCount,
  currentMistakeTags: trend.currentMistakeTags,
  newMistakeTags: trend.newMistakeTags,
  fixedMistakeTags: trend.fixedMistakeTags,
  repeatedMistakeTags: trend.repeatedMistakeTags,
  lastRecordedAt: trend.lastRecordedAt,
  recentRegressions,
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log(`Claude Code status for ${repoRoot}`)
  console.log(`State path: ${resolved.statePath}`)
  console.log(
    `Sessions: ${trend.totalSessionCount} total, ${trend.successSessionCount} successful, ${trend.regressionSessionCount} regressions (${trend.highConfidenceRegressionSessionCount} high-confidence)`,
  )
  console.log(`Teacher frozen: ${parsedState?.teacherFrozen ? 'yes' : 'no'}`)
  console.log(
    `Current mistake tags: ${trend.currentMistakeTags.join(', ') || 'none'}`,
  )
  console.log(`New mistake tags: ${trend.newMistakeTags.join(', ') || 'none'}`)
  console.log(
    `Fixed mistake tags: ${trend.fixedMistakeTags.join(', ') || 'none'}`,
  )
  console.log(
    `Repeated mistake tags: ${trend.repeatedMistakeTags.join(', ') || 'none'}`,
  )
  if (recentRegressions.length > 0) {
    console.log('Recent regressions:')
    for (const regression of recentRegressions) {
      console.log(
        `- ${regression.recordedAt} ${regression.sessionId} [${regression.eventType}] ${regression.failureTags.join(', ') || 'no-tags'}${regression.summary ? ` :: ${regression.summary}` : ''}`,
      )
    }
  }
}
