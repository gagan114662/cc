import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyClaudeCodeSessionObservation, summarizeClaudeCodeSessionObservations } from 'src/services/autoresearch/claudeCodeSessions.js'
import {
  AutoresearchController,
  resolveAutoresearchConfig,
} from 'src/services/autoresearch/runtime.js'
import { RolloutStateSchema } from 'src/services/autoresearch/types.js'

describe('autoresearch Claude Code session analytics', () => {
  test('classifies explicit incomplete sessions as regressions', () => {
    const observation = classifyClaudeCodeSessionObservation({
      sessionId: 'session-1',
      eventType: 'session_end',
      transcriptPath: '/tmp/session-1.jsonl',
      cwd: '/repo',
      summary:
        'I was not able to finish the HTML report and could not run the verification commands.',
      recordedAt: '2026-04-15T00:00:00.000Z',
    })

    expect(observation.actualRegression).toBe(true)
    expect(observation.failureTags).toContain('task_incomplete')
    expect(observation.failureTags).toContain('verification_gap')
    expect(observation.failureTags).toContain('artifact_incomplete')
  })

  test('summarizes new and repeated mistake tags across session windows', () => {
    const observations = [
      classifyClaudeCodeSessionObservation({
        sessionId: 'session-a',
        eventType: 'session_end',
        transcriptPath: '/tmp/session-a.jsonl',
        cwd: '/repo',
        summary: 'Could not finish the task because the report generation failed.',
        recordedAt: '2026-04-15T00:00:00.000Z',
      }),
      classifyClaudeCodeSessionObservation({
        sessionId: 'session-b',
        eventType: 'session_end',
        transcriptPath: '/tmp/session-b.jsonl',
        cwd: '/repo',
        summary: 'Could not run the verification commands after the change.',
        recordedAt: '2026-04-15T00:10:00.000Z',
      }),
      classifyClaudeCodeSessionObservation({
        sessionId: 'session-c',
        eventType: 'session_end',
        transcriptPath: '/tmp/session-c.jsonl',
        cwd: '/repo',
        summary:
          'Could not finish the task because the report generation failed, and verification stayed blocked.',
        recordedAt: '2026-04-15T00:20:00.000Z',
      }),
      classifyClaudeCodeSessionObservation({
        sessionId: 'session-d',
        eventType: 'session_end',
        transcriptPath: '/tmp/session-d.jsonl',
        cwd: '/repo',
        summary: 'Authentication error blocked the task outright.',
        recordedAt: '2026-04-15T00:30:00.000Z',
      }),
    ]

    const trend = summarizeClaudeCodeSessionObservations(observations, 2)

    expect(trend.currentMistakeTags).toContain('auth_or_env_blocker')
    expect(trend.currentMistakeTags).toContain('verification_gap')
    expect(trend.newMistakeTags).toContain('auth_or_env_blocker')
    expect(trend.repeatedMistakeTags).toContain('verification_gap')
    expect(trend.fixedMistakeTags).toEqual([])
  })

  test('controller ingests Claude Code session observations into state', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'cc-autoresearch-'))
    const claudeDir = path.join(repoRoot, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await Bun.write(
      path.join(repoRoot, 'autoresearch.seed-corpus.json'),
      JSON.stringify({ version: 'seed', cases: [] }, null, 2),
    )
    await Bun.write(
      path.join(repoRoot, 'autoresearch.seed-challenge-set.json'),
      JSON.stringify({ version: 'challenge', challengeCandidates: [] }, null, 2),
    )
    await Bun.write(
      path.join(repoRoot, 'autoresearch.config.json'),
      JSON.stringify(
        {
          version: '1',
          seedCorpusPath: './autoresearch.seed-corpus.json',
          seedChallengeSetPath: './autoresearch.seed-challenge-set.json',
          mutationSources: [],
          immutableCandidateGlobs: ['services/autoresearch/**'],
          reliabilityFloors: {
            unsupportedClaimRate: 0,
            verifierBypassRate: 0,
            phaseViolationRate: 0,
            missingEvidenceCompletionRate: 0,
            challengeSetCatchRate: 1,
            hiddenHoldoutPredictiveAccuracy: 1,
            dogfoodMissRate: 0,
            benchmarkStabilityRate: 0.9,
          },
          costCeilings: {
            maxTokenCostDeltaPct: 5,
            maxRuntimeDeltaPct: 10,
          },
          admissionThresholds: {
            minimumReplayCount: 2,
            minimumStabilityScore: 0.9,
            requireChallengeDiscrimination: true,
          },
          rolloutThresholds: {
            shadowSuccessCount: 2,
            dogfoodSuccessCount: 2,
            canarySuccessCount: 3,
            maxRegressionRate: 0,
          },
          teacherFreezeThresholds: {
            challengeEscapeRate: 0,
            dogfoodMissRate: 0,
            benchmarkInstabilityRate: 0.2,
          },
        },
        null,
        2,
      ),
    )
    await Bun.write(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(
        {
          autoresearch: {
            enabled: true,
            configPath: './autoresearch.config.json',
            experimentStatePath: './.autoresearch-state',
            emitTelemetry: false,
          },
        },
        null,
        2,
      ),
    )

    const resolved = await resolveAutoresearchConfig(repoRoot, {
      enabled: true,
      configPath: './autoresearch.config.json',
      experimentStatePath: './.autoresearch-state',
      emitTelemetry: false,
    })

    expect(resolved.enabled).toBe(true)
    if (!resolved.enabled) {
      return
    }

    const controller = new AutoresearchController(resolved)
    await controller.runCycle()

    const observation = classifyClaudeCodeSessionObservation({
      sessionId: 'session-live',
      eventType: 'session_end',
      transcriptPath: '/tmp/session-live.jsonl',
      cwd: repoRoot,
      summary:
        'Could not finish the HTML deck, but the repo orientation was otherwise correct.',
      recordedAt: '2026-04-15T00:00:00.000Z',
    })

    const observationDir = path.join(
      resolved.statePath,
      'incoming',
      'claude-code-sessions',
    )
    await writeFile(
      path.join(observationDir, `${observation.id}.json`),
      `${JSON.stringify(observation, null, 2)}\n`,
      'utf8',
    )

    await controller.runCycle()

    const rawState = await readFile(path.join(resolved.statePath, 'state.json'), 'utf8')
    const state = RolloutStateSchema().parse(JSON.parse(rawState))

    expect(state.processedClaudeCodeObservationIds).toContain(observation.id)
    expect(state.lastClaudeCodeTrendSnapshot?.totalSessionCount).toBe(1)
    expect(state.lastClaudeCodeTrendSnapshot?.currentMistakeTags).toContain(
      'artifact_incomplete',
    )
  })
})
