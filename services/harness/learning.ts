import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  HarnessConfig,
  HarnessRuntimeState,
  JobOutcome,
  ReviewDecision,
} from './types.js'
import { resolveRepoPath } from './utils.js'

function incrementCounter(
  target: Record<string, number>,
  key: string,
  amount: number = 1,
): void {
  target[key] = (target[key] ?? 0) + amount
}

export function updateLearningState(
  state: HarnessRuntimeState,
  outcome: JobOutcome,
  reviewerDecisions: ReviewDecision[],
): HarnessRuntimeState {
  const next = structuredClone(state)

  for (const decision of reviewerDecisions) {
    if (decision.status === 'block' || decision.status === 'warn') {
      incrementCounter(
        next.learning.reviewerFindings,
        `${decision.reviewerId}:${decision.summary}`,
      )
    }
  }

  for (const tag of outcome.failureTags) {
    incrementCounter(next.learning.failureReasons, tag)
  }

  next.learning.humanTouches += outcome.humanTouchCount
  if (outcome.regressionDetected) {
    next.learning.mergeRegressions += 1
  }
  if (outcome.autoMergeRequested && !outcome.regressionDetected) {
    next.learning.autoMerges += 1
  }

  return next
}

export async function buildLearningContext(
  repoRoot: string,
  config: HarnessConfig,
): Promise<string> {
  if (!config.learning.attachToJobPrompts) {
    return ''
  }

  const knowledgePath = resolveRepoPath(repoRoot, config.learning.knowledgePath)
  try {
    const raw = await readFile(knowledgePath, 'utf-8')
    const trimmed = raw.trim()
    if (!trimmed) {
      return ''
    }
    return `Harness knowledge to apply before you act:\n${trimmed}`
  } catch {
    return ''
  }
}

export async function writeCompiledLearning(
  repoRoot: string,
  config: HarnessConfig,
  state: HarnessRuntimeState,
): Promise<void> {
  const minimumRepeatCount = config.learning.minimumRepeatCount
  const repeatedFindings = Object.entries(state.learning.reviewerFindings)
    .filter(([, count]) => count >= minimumRepeatCount)
    .sort((left, right) => right[1] - left[1])
  const repeatedFailures = Object.entries(state.learning.failureReasons)
    .filter(([, count]) => count >= minimumRepeatCount)
    .sort((left, right) => right[1] - left[1])

  const lines = [
    '# Harness Feedback',
    '',
    'This file is compiled by the unattended harness and attached to future work.',
    '',
    '## Repeated reviewer findings',
    ...(repeatedFindings.length > 0
      ? repeatedFindings.map(
          ([finding, count]) => `- ${finding} (${count} repeated runs)`,
        )
      : ['- None yet.']),
    '',
    '## Repeated failure reasons',
    ...(repeatedFailures.length > 0
      ? repeatedFailures.map(
          ([failure, count]) => `- ${failure} (${count} repeated runs)`,
        )
      : ['- None yet.']),
    '',
    '## Harness metrics',
    `- Human touches observed: ${state.learning.humanTouches}`,
    `- Auto-merges completed: ${state.learning.autoMerges}`,
    `- Merge regressions observed: ${state.learning.mergeRegressions}`,
  ]

  const target = resolveRepoPath(repoRoot, config.learning.knowledgePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${lines.join('\n')}\n`, 'utf-8')
}
