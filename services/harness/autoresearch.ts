import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { JobOutcome, ReviewDecision } from './types.js'

function getAutoresearchStateDir(repoRoot: string): string {
  const digest = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)
  return path.join(getClaudeConfigHomeDir(), 'autoresearch', digest)
}

async function writeObservation(
  dir: string,
  id: string,
  value: unknown,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${id}.json`), `${jsonStringify(value, null, 2)}\n`)
}

export async function recordHarnessOutcomeObservation(
  repoRoot: string,
  outcome: JobOutcome,
  decisions: ReviewDecision[],
): Promise<void> {
  const stateDir = getAutoresearchStateDir(repoRoot)
  const dogfoodDir = path.join(stateDir, 'incoming', 'dogfood-observations')
  const sessionDir = path.join(stateDir, 'incoming', 'claude-code-sessions')
  const failureTags = [
    ...new Set([
      ...outcome.failureTags,
      ...decisions
        .filter(decision => decision.status !== 'pass')
        .map(decision => decision.reviewerId),
    ]),
  ]

  await writeObservation(dogfoodDir, outcome.jobInstanceId, {
    id: outcome.jobInstanceId,
    candidateId: 'harness-v1',
    lane: 'dogfood',
    success: outcome.status === 'completed',
    predictedRegression: false,
    actualRegression: outcome.regressionDetected,
    transcriptPath: outcome.outputPath,
    fingerprint: `${outcome.jobId}:${outcome.attempt}`,
    failureTags,
    summary: outcome.summary,
    recordedAt: outcome.completedAt,
  })

  await writeObservation(sessionDir, outcome.jobInstanceId, {
    id: outcome.jobInstanceId,
    sessionId: outcome.jobInstanceId,
    eventType: outcome.status === 'completed' ? 'session_end' : 'stop_failure',
    transcriptPath: outcome.outputPath ?? '',
    cwd: repoRoot,
    exitReason: outcome.status,
    summary: outcome.summary,
    success: outcome.status === 'completed',
    actualRegression: outcome.regressionDetected,
    heuristicConfidence: outcome.regressionDetected ? 0.8 : 0.4,
    failureTags,
    source: 'harness-daemon',
    recordedAt: outcome.completedAt,
  })
}
