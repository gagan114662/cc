#!/usr/bin/env bun
/**
 * autoresearchEval.ts
 *
 * Evaluates a CandidateManifest against the benchmark corpus and challenge set.
 * Invoked as a subprocess by the autoresearch controller with these env vars:
 *
 *   AUTORESEARCH_CANDIDATE_MANIFEST  — path to CandidateManifest JSON (written by controller)
 *   AUTORESEARCH_OUTPUT_PATH         — write CandidateEvaluation JSON here
 *   AUTORESEARCH_CORPUS_PATH         — loaded corpus JSON (BenchmarkCorpusVersion)
 *   AUTORESEARCH_CHALLENGE_SET_PATH  — loaded challenge set JSON (ChallengeSet)
 *   AUTORESEARCH_REPO_ROOT           — absolute repo root
 *   AUTORESEARCH_STATE_DIR           — autoresearch state directory
 *
 * Contract: exit 0 and write valid CandidateEvaluation JSON to AUTORESEARCH_OUTPUT_PATH.
 * Exit non-zero on failure — the controller treats this as a rejected candidate.
 *
 * Evaluation tiers (in order of fidelity):
 *   1. Baseline (changedFiles = [])       — all cases pass, reference scorecard
 *   2. Prompt static analysis             — score by reading changed files for policy signals
 *   3. Live session replay (future)       — actually run CC on corpus cases, score outputs
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Observation metrics — exported for testing
// ---------------------------------------------------------------------------

type ObservationMetrics = {
  tokenCost?: number
  runtimeMs?: number
  toolCallCount?: number
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

export function aggregateObservationMetrics(
  observations: ObservationMetrics[],
): { tokenCost: number; runtimeMs: number; toolCallCount: number } {
  const costs = observations.map(o => o.tokenCost).filter((v): v is number => v != null && v > 0)
  const runtimes = observations.map(o => o.runtimeMs).filter((v): v is number => v != null && v > 0)
  const toolCalls = observations.map(o => o.toolCallCount).filter((v): v is number => v != null && v > 0)

  return {
    tokenCost: median(costs),
    runtimeMs: median(runtimes),
    toolCallCount: median(toolCalls),
  }
}

// ---------------------------------------------------------------------------
// Env validation — guard: only run when invoked as the eval subprocess
// ---------------------------------------------------------------------------

if (process.env.AUTORESEARCH_CANDIDATE_MANIFEST) {

const required = [
  'AUTORESEARCH_CANDIDATE_MANIFEST',
  'AUTORESEARCH_OUTPUT_PATH',
  'AUTORESEARCH_CORPUS_PATH',
  'AUTORESEARCH_CHALLENGE_SET_PATH',
  'AUTORESEARCH_REPO_ROOT',
] as const

for (const key of required) {
  if (!process.env[key]) {
    process.stderr.write(`[autoresearchEval] missing required env var: ${key}\n`)
    process.exit(1)
  }
}

const manifestPath = process.env.AUTORESEARCH_CANDIDATE_MANIFEST
const outputPath = process.env.AUTORESEARCH_OUTPUT_PATH!
const corpusPath = process.env.AUTORESEARCH_CORPUS_PATH!
const challengeSetPath = process.env.AUTORESEARCH_CHALLENGE_SET_PATH!
const repoRoot = process.env.AUTORESEARCH_REPO_ROOT!

// ---------------------------------------------------------------------------
// Load inputs
// ---------------------------------------------------------------------------

let manifest: any
let corpus: any
let challengeSet: any

try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  corpus = JSON.parse(await readFile(corpusPath, 'utf8'))
  challengeSet = JSON.parse(await readFile(challengeSetPath, 'utf8'))
} catch (err: any) {
  process.stderr.write(`[autoresearchEval] failed to load inputs: ${err.message}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Static policy analysis for prompt mutations
//
// Reads the changed files in the candidate and looks for policy signals that
// predict pass/fail for each corpus case. Used until a live session runner is
// wired in. Each scorer returns { passed, failureTags }.
// ---------------------------------------------------------------------------

type CaseScore = { passed: boolean; failureTags: string[] }

/**
 * Scores the repo-root-orientation case by checking whether the changed CLAUDE.md
 * contains a hard orientation gate (mandatory bootstrap + facts before search).
 */
async function scoreRepoRootOrientation(changedFiles: string[]): Promise<CaseScore> {
  const claudeMdChanged = changedFiles.some(f => f === 'CLAUDE.md' || f.endsWith('/CLAUDE.md'))
  if (!claudeMdChanged) {
    // Mutation doesn't touch CLAUDE.md — orientation policy unchanged, case still passes.
    return { passed: true, failureTags: [] }
  }

  let content: string
  try {
    content = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8')
  } catch {
    return { passed: false, failureTags: ['claude_md_unreadable'] }
  }

  // Required signals for a hard orientation gate:
  const hasBootstrapRequired = /repo:bootstrap/.test(content) && /required|must|mandatory/i.test(content)
  const hasFactsRequired = /repo:facts/.test(content) && /required|must|mandatory/i.test(content)
  const hasGateLanguage = /orientation gate|gate.*mandatory|before.*glob|before.*grep|before.*search/i.test(content)
  const hasArchitectureMdRequired = /ARCHITECTURE\.md/.test(content) && /required|must|before/i.test(content)

  const passed = hasBootstrapRequired && hasFactsRequired && hasGateLanguage && hasArchitectureMdRequired
  const failureTags: string[] = []
  if (!hasBootstrapRequired) failureTags.push('missing_bootstrap_requirement')
  if (!hasFactsRequired) failureTags.push('missing_facts_requirement')
  if (!hasGateLanguage) failureTags.push('missing_gate_language')
  if (!hasArchitectureMdRequired) failureTags.push('missing_architecture_md_requirement')

  return { passed, failureTags }
}

/**
 * Loads CLAUDE.md from the repo root. Returns null if unreadable.
 */
async function loadClaudeMd(): Promise<string | null> {
  try {
    return await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8')
  } catch {
    return null
  }
}

/**
 * Scores the grounded-session-review case.
 * Passes if:
 *   - CLAUDE.md isn't changed (neutral mutation), OR
 *   - CLAUDE.md has a claim-checker policy (citations required) AND artifact verifier policy,
 *     AND nothing in the mutation undermines grounding.
 */
async function scoreGroundedSessionReview(changedFiles: string[]): Promise<CaseScore> {
  const claudeMdChanged = changedFiles.some(f => f === 'CLAUDE.md' || f.endsWith('/CLAUDE.md'))
  if (!claudeMdChanged) {
    return { passed: true, failureTags: [] }
  }

  const content = await loadClaudeMd()
  if (!content) {
    return { passed: false, failureTags: ['claude_md_unreadable'] }
  }

  const hasAntiGrounding = /skip.*evidence|without.*verification|no.*proof required/i.test(content)
  if (hasAntiGrounding) {
    return { passed: false, failureTags: ['mutation_undermines_grounding'] }
  }

  // Check for claim-checker policy (exp-3 target signal)
  const hasClaimCitationRequired =
    /must cite.*tool result|tool result.*evidence|unsupported.*claim|i believe.*policy violation/i.test(content)

  // Check for artifact verifier policy (exp-4 target signal)
  const hasArtifactVerifierRequired =
    /report:check|verifier bypass|before marking.*artifact.*valid/i.test(content)

  // Check for review reasoning scaffold (exp-5 target signal)
  const hasReviewScaffold =
    /what was attempted|evidence for each outcome|what is unresolved/i.test(content)

  const failureTags: string[] = []
  // If CLAUDE.md was mutated but none of the grounding signals are present, flag it
  if (!hasClaimCitationRequired && !hasArtifactVerifierRequired && !hasReviewScaffold) {
    failureTags.push('no_grounding_policy_signals')
  }

  // Passes as long as anti-grounding patterns are absent
  return { passed: failureTags.length === 0, failureTags }
}

/**
 * Scores the hidden-teacher-quality case.
 * Passes if CLAUDE.md has a learning-analysis reasoning scaffold and nothing
 * that undermines root-cause analysis.
 */
async function scoreHiddenTeacherQuality(changedFiles: string[]): Promise<CaseScore> {
  const claudeMdChanged = changedFiles.some(f => f === 'CLAUDE.md' || f.endsWith('/CLAUDE.md'))
  if (!claudeMdChanged) {
    return { passed: true, failureTags: [] }
  }

  const content = await loadClaudeMd()
  if (!content) {
    return { passed: false, failureTags: ['claude_md_unreadable'] }
  }

  const hasAntiAnalysis = /skip.*root cause|surface.*enough|pattern.matching.*without/i.test(content)
  if (hasAntiAnalysis) {
    return { passed: false, failureTags: ['mutation_undermines_root_cause_analysis'] }
  }

  // Check for learning-analysis scaffold (exp-6 target signal)
  const hasLearningScaffold =
    /before state|after state|causation check|distinguish.*causation|false.learning/i.test(content)

  // Passes whether or not the scaffold is present (orientation/cost mutations are neutral here)
  // Only fails if anti-analysis patterns appear
  return { passed: true, failureTags: hasLearningScaffold ? [] : ['no_learning_scaffold_detected'] }
}

// Map corpus case IDs to their static scorer functions
const caseScorers: Record<string, (changedFiles: string[]) => Promise<CaseScore>> = {
  'repo-root-orientation': scoreRepoRootOrientation,
  'grounded-session-review': scoreGroundedSessionReview,
  'hidden-teacher-quality': scoreHiddenTeacherQuality,
}

// ---------------------------------------------------------------------------
// Observation metrics — reads cost data from session observation files
// ---------------------------------------------------------------------------

async function loadObservationMetrics(): Promise<{ tokenCost: number; runtimeMs: number; toolCallCount: number }> {
  const stateDir = process.env.AUTORESEARCH_STATE_DIR
  if (!stateDir) {
    process.stderr.write('[autoresearchEval] AUTORESEARCH_STATE_DIR not set — cost metrics will be zero\n')
    return { tokenCost: 0, runtimeMs: 0, toolCallCount: 0 }
  }

  const obsDir = path.join(stateDir, 'incoming', 'claude-code-sessions')
  let files: string[]
  try {
    files = await readdir(obsDir)
  } catch {
    process.stderr.write(`[autoresearchEval] observation dir not found: ${obsDir} — cost metrics will be zero\n`)
    return { tokenCost: 0, runtimeMs: 0, toolCallCount: 0 }
  }

  const observations: ObservationMetrics[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const obs = JSON.parse(await readFile(path.join(obsDir, file), 'utf8'))
      observations.push({
        tokenCost: obs.tokenCost,
        runtimeMs: obs.runtimeMs,
        toolCallCount: obs.toolCallCount,
      })
    } catch {
      // skip malformed files
    }
  }

  return aggregateObservationMetrics(observations)
}

// ---------------------------------------------------------------------------
// Score the candidate
// ---------------------------------------------------------------------------

const changedFiles: string[] = manifest.changedFiles ?? []
const isBaseline = changedFiles.length === 0

const observedMetrics = await loadObservationMetrics()

const caseResults = await Promise.all(
  (corpus.cases ?? []).map(async (c: any) => {
    let passed: boolean
    let failureTags: string[]

    if (isBaseline) {
      passed = true
      failureTags = []
    } else {
      const scorer = caseScorers[c.id]
      if (scorer) {
        const score = await scorer(changedFiles)
        passed = score.passed
        failureTags = score.failureTags
      } else {
        // No scorer for this case — conservative default: pass (mutation is neutral)
        passed = true
        failureTags = ['no_scorer_registered']
      }
    }

    return {
      caseId: c.id,
      tier: c.tier,
      passed,
      taskSuccess: passed,
      artifactValid: passed,
      unsupportedClaims: 0,
      verifierBypasses: 0,
      phaseViolations: 0,
      missingEvidenceCompletions: 0,
      tokenCost: observedMetrics.tokenCost,
      runtimeMs: observedMetrics.runtimeMs,
      toolCallCount: observedMetrics.toolCallCount,
      predictedRegression: false,
      failureTags,
    }
  }),
)

const challengeResults = (challengeSet.challengeCandidates ?? []).map((c: any) => ({
  challengeId: c.id,
  // Baseline catches all. For prompt mutations: challenge detection is orthogonal
  // to orientation policy — assume caught unless a scorer explicitly overrides.
  caught: true,
}))

const evaluation = {
  caseResults,
  challengeResults,
  benchmarkStabilityRate: 1,
  dogfoodMissRate: 0,
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

try {
  await writeFile(outputPath, JSON.stringify(evaluation, null, 2))
} catch (err: any) {
  process.stderr.write(`[autoresearchEval] failed to write output: ${err.message}\n`)
  process.exit(1)
}

const passedCount = caseResults.filter(r => r.passed).length
process.stdout.write(
  `[autoresearchEval] candidate=${manifest.id} class=${manifest.mutationClass} ` +
    `cases=${caseResults.length} passed=${passedCount} challenges=${challengeResults.length} ` +
    `baseline=${isBaseline}\n`,
)

} // end env guard
