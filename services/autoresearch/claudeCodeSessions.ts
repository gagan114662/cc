import { createHash } from 'node:crypto'
import {
  ClaudeCodeSessionObservationSchema,
  ClaudeCodeTrendSnapshotSchema,
  type ClaudeCodeSessionEventType,
  type ClaudeCodeSessionObservation,
  type ClaudeCodeTrendSnapshot,
} from './types.js'

export const DEFAULT_CLAUDE_CODE_TREND_WINDOW = 10
export const HIGH_CONFIDENCE_CLAUDE_CODE_REGRESSION_THRESHOLD = 0.75

type ClaudeCodeSessionObservationInput = {
  sessionId: string
  eventType: ClaudeCodeSessionEventType
  transcriptPath: string
  cwd: string
  exitReason?: string
  summary?: string
  firstPrompt?: string
  messageCount?: number
  projectPath?: string
  lastAssistantMessage?: string
  errorDetails?: string
  recordedAt?: string
  tokenCost?: number
  runtimeMs?: number
  toolCallCount?: number
}

type ConsolidatedClaudeCodeSession = {
  sessionId: string
  recordedAt: string
  success: boolean
  actualRegression: boolean
  heuristicConfidence: number
  failureTags: string[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function stableObservationId(
  sessionId: string,
  eventType: ClaudeCodeSessionEventType,
  recordedAt: string,
): string {
  return createHash('sha256')
    .update(`${sessionId}:${eventType}:${recordedAt}`)
    .digest('hex')
    .slice(0, 16)
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function detectFailureTags(text: string): string[] {
  const tags = new Set<string>()
  const normalized = text.toLowerCase()

  if (
    /\b(could not|couldn't|unable to|was not able to|wasn't able to|blocked|failed to|did not finish|didn't finish|not complete|incomplete)\b/.test(
      normalized,
    )
  ) {
    tags.add('task_incomplete')
  }

  if (
    /\b(could not|couldn't|unable to|did not|didn't|not claiming).*\b(test|tests|verify|verified|verification|validate|validated|typecheck|type-check|smoke)\b/.test(
      normalized,
    ) ||
    /\b(test|tests|typecheck|type-check|verification|validation)\b.*\b(failed|blocked|skipped|not run|could not|couldn't|unable)\b/.test(
      normalized,
    )
  ) {
    tags.add('verification_gap')
  }

  if (
    /\b(could not|couldn't|unable to|was not able to|wasn't able to|not able to|failed to|did not|didn't).*\b(html|report|deck|preview|artifact)\b/.test(
      normalized,
    )
  ) {
    tags.add('artifact_incomplete')
  }

  if (
    /\b(authentication|auth|invalid api key|permission denied|missing credentials|not initialized|login required)\b/.test(
      normalized,
    )
  ) {
    tags.add('auth_or_env_blocker')
  }

  if (
    /\b(error|exception|enoent|eacces|exit code|timed out|timeout|crash|crashed)\b/.test(
      normalized,
    )
  ) {
    tags.add('tool_or_runtime_failure')
  }

  return uniqueSorted(tags)
}

function scoreHeuristicConfidence(
  eventType: ClaudeCodeSessionEventType,
  failureTags: string[],
): number {
  if (eventType === 'stop_failure') {
    return 0.95
  }
  if (failureTags.includes('auth_or_env_blocker')) {
    return 0.9
  }
  if (failureTags.includes('task_incomplete')) {
    return 0.85
  }
  if (failureTags.includes('artifact_incomplete')) {
    return 0.8
  }
  if (failureTags.includes('verification_gap')) {
    return 0.7
  }
  if (failureTags.includes('tool_or_runtime_failure')) {
    return 0.75
  }
  return 0.55
}

export function classifyClaudeCodeSessionObservation(
  input: ClaudeCodeSessionObservationInput,
): ClaudeCodeSessionObservation {
  const recordedAt = input.recordedAt ?? nowIso()
  const summaryParts = [
    input.summary,
    input.lastAssistantMessage,
    input.errorDetails,
    input.exitReason,
  ].filter(Boolean)
  const summaryText = summaryParts.join(' ').trim()
  const failureTags = detectFailureTags(summaryText)
  const actualRegression =
    input.eventType === 'stop_failure' ||
    failureTags.includes('task_incomplete') ||
    failureTags.includes('artifact_incomplete') ||
    failureTags.includes('auth_or_env_blocker') ||
    failureTags.includes('tool_or_runtime_failure')
  const success = !actualRegression

  return ClaudeCodeSessionObservationSchema().parse({
    id: stableObservationId(input.sessionId, input.eventType, recordedAt),
    sessionId: input.sessionId,
    eventType: input.eventType,
    transcriptPath: input.transcriptPath,
    cwd: input.cwd,
    exitReason: input.exitReason,
    summary: input.summary ?? input.lastAssistantMessage ?? input.errorDetails,
    firstPrompt: input.firstPrompt,
    messageCount: input.messageCount,
    projectPath: input.projectPath,
    success,
    actualRegression,
    heuristicConfidence: scoreHeuristicConfidence(input.eventType, failureTags),
    failureTags,
    source:
      input.eventType === 'session_end'
        ? 'claude_code_session_end_hook'
        : 'claude_code_stop_failure_hook',
    recordedAt,
    tokenCost: input.tokenCost,
    runtimeMs: input.runtimeMs,
    toolCallCount: input.toolCallCount,
  })
}

function buildLearningDelta(
  baselineMistakeTags: string[],
  currentMistakeTags: string[],
): Pick<
  ClaudeCodeTrendSnapshot,
  'currentMistakeTags' | 'newMistakeTags' | 'fixedMistakeTags' | 'repeatedMistakeTags'
> {
  const baselineSet = new Set(baselineMistakeTags)
  const currentSet = new Set(currentMistakeTags)
  return {
    currentMistakeTags: uniqueSorted(currentSet),
    newMistakeTags: uniqueSorted(
      [...currentSet].filter(mistakeTag => !baselineSet.has(mistakeTag)),
    ),
    fixedMistakeTags: uniqueSorted(
      [...baselineSet].filter(mistakeTag => !currentSet.has(mistakeTag)),
    ),
    repeatedMistakeTags: uniqueSorted(
      [...currentSet].filter(mistakeTag => baselineSet.has(mistakeTag)),
    ),
  }
}

function consolidateObservations(
  observations: ClaudeCodeSessionObservation[],
): ConsolidatedClaudeCodeSession[] {
  const grouped = new Map<string, ClaudeCodeSessionObservation[]>()
  for (const observation of observations) {
    const bucket = grouped.get(observation.sessionId) ?? []
    bucket.push(observation)
    grouped.set(observation.sessionId, bucket)
  }

  return [...grouped.values()]
    .map(sessionObservations => {
      const sorted = [...sessionObservations].sort((left, right) =>
        left.recordedAt.localeCompare(right.recordedAt),
      )
      const latest = sorted.at(-1)!
      const failureTags = uniqueSorted(
        sorted.flatMap(observation => observation.failureTags),
      )
      const actualRegression = sorted.some(
        observation => observation.actualRegression,
      )
      const success = !actualRegression && sorted.some(observation => observation.success)
      const heuristicConfidence = Math.max(
        ...sorted.map(observation => observation.heuristicConfidence),
      )
      return {
        sessionId: latest.sessionId,
        recordedAt: latest.recordedAt,
        success,
        actualRegression,
        heuristicConfidence,
        failureTags,
      }
    })
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
}

export function summarizeClaudeCodeSessionObservations(
  observations: ClaudeCodeSessionObservation[],
  windowSize: number = DEFAULT_CLAUDE_CODE_TREND_WINDOW,
): ClaudeCodeTrendSnapshot {
  const consolidated = consolidateObservations(observations)
  const boundedWindowSize = Math.max(1, windowSize)
  const currentWindow = consolidated.slice(-boundedWindowSize)
  const previousWindow = consolidated.slice(
    Math.max(0, consolidated.length - boundedWindowSize * 2),
    Math.max(0, consolidated.length - boundedWindowSize),
  )

  const learningDelta = buildLearningDelta(
    uniqueSorted(previousWindow.flatMap(session => session.failureTags)),
    uniqueSorted(currentWindow.flatMap(session => session.failureTags)),
  )

  return ClaudeCodeTrendSnapshotSchema().parse({
    totalObservationCount: observations.length,
    totalSessionCount: consolidated.length,
    successSessionCount: consolidated.filter(session => session.success).length,
    regressionSessionCount: consolidated.filter(
      session => session.actualRegression,
    ).length,
    highConfidenceRegressionSessionCount: consolidated.filter(
      session =>
        session.actualRegression &&
        session.heuristicConfidence >=
          HIGH_CONFIDENCE_CLAUDE_CODE_REGRESSION_THRESHOLD,
    ).length,
    currentWindowSize: currentWindow.length,
    previousWindowSize: previousWindow.length,
    ...learningDelta,
    lastRecordedAt: consolidated.at(-1)?.recordedAt,
  })
}
