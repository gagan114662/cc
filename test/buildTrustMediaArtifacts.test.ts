// test-intent: proves the trust harness emits reviewable screenshot and replay artifacts alongside the HTML proof.
// test-spec: specs/build-trust-harness.md#proof-report
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  generateBuildTrustMediaArtifacts,
} from '../scripts/buildTrustMediaArtifacts.js'
import type { BuildTrustRunnerReport } from '../scripts/buildTrustReport.js'

describe('buildTrustMediaArtifacts', () => {
  test('writes png screenshots and an asciicast replay', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-media-'))
    const report: BuildTrustRunnerReport = {
      repoRoot,
      profile: 'local',
      verdict: 'trusted',
      generatedAt: '2026-04-15T00:00:00.000Z',
      baseRef: 'origin/main',
      changedFiles: ['scripts/buildTrustRunner.ts'],
      preflight: {
        repoRoot,
        packageManager: 'bun@1.3.11',
        bunVersion: '1.3.11',
        status: 'passed',
        checks: [],
      },
      commandResults: [
        {
          label: 'typecheck',
          command: 'bun run typecheck',
          status: 'passed',
          exitCode: 0,
          durationMs: 10,
          stdout: '',
          stderr: '',
        },
      ],
      qualityReport: {
        errorCount: 0,
        warningCount: 0,
        findings: [],
      },
      stabilityRuns: [
        {
          seed: 101,
          status: 'passed',
          junitPath: null,
          failingTests: [],
        },
      ],
      coverage: null,
      mutation: {
        status: 'passed',
        summary: 'All mutation trials were killed.',
        changedSourceFileCount: 1,
        candidateCount: 1,
        executedTrialCount: 1,
        survivingTrialCount: 0,
        trials: [],
      },
      mediaArtifacts: [],
      riskSuites: [],
    }

    try {
      const artifacts = await generateBuildTrustMediaArtifacts(repoRoot, report)

      expect(artifacts).toHaveLength(4)
      expect(artifacts.filter(artifact => artifact.kind === 'screenshot')).toHaveLength(3)
      expect(artifacts.some(artifact => artifact.kind === 'replay')).toBe(true)

      for (const artifact of artifacts) {
        const absolutePath = path.join(repoRoot, artifact.filePath)
        const exists = await Bun.file(absolutePath).exists()
        expect(exists).toBe(true)
      }

      const replay = artifacts.find(artifact => artifact.kind === 'replay')
      expect(replay).toBeDefined()
      const replayText = await Bun.file(path.join(repoRoot, replay!.filePath)).text()
      expect(replayText.includes('"version":2')).toBe(true)
      expect(replayText.includes('\\u001b[32mtrusted\\u001b[0m')).toBe(true)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  test('keeps replay artifacts even when there are no findings to visualize', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-media-empty-'))
    const report: BuildTrustRunnerReport = {
      repoRoot,
      profile: 'local',
      verdict: 'trusted',
      generatedAt: '2026-04-15T00:00:00.000Z',
      baseRef: null,
      changedFiles: [],
      preflight: {
        repoRoot,
        packageManager: 'bun@1.3.11',
        bunVersion: '1.3.11',
        status: 'passed',
        checks: [],
      },
      commandResults: [],
      qualityReport: {
        errorCount: 0,
        warningCount: 0,
        findings: [],
      },
      stabilityRuns: [],
      coverage: null,
      mutation: null,
      mediaArtifacts: [],
      riskSuites: [],
    }

    try {
      const artifacts = await generateBuildTrustMediaArtifacts(repoRoot, report)

      expect(artifacts.some(artifact => artifact.kind === 'replay')).toBe(true)
      expect(artifacts.some(artifact => artifact.kind === 'screenshot')).toBe(true)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  test('renders blocked verdicts and failed commands as failures in the replay', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-media-failed-'))
    const report: BuildTrustRunnerReport = {
      repoRoot,
      profile: 'ci',
      verdict: 'blocked_quality',
      generatedAt: '2026-04-15T00:00:00.000Z',
      baseRef: 'origin/main',
      changedFiles: ['scripts/buildTrustMediaArtifacts.ts'],
      preflight: {
        repoRoot,
        packageManager: 'bun@1.3.11',
        bunVersion: '1.3.11',
        status: 'passed',
        checks: [],
      },
      commandResults: [
        {
          label: 'test:test-quality',
          command: 'bun run test:test-quality',
          status: 'failed',
          exitCode: 1,
          durationMs: 12,
          stdout: '1 error',
          stderr: '',
        },
      ],
      qualityReport: {
        errorCount: 1,
        warningCount: 0,
        findings: [],
      },
      stabilityRuns: [],
      coverage: null,
      mutation: null,
      mediaArtifacts: [],
      riskSuites: [],
    }

    try {
      const artifacts = await generateBuildTrustMediaArtifacts(repoRoot, report)
      const replay = artifacts.find(artifact => artifact.kind === 'replay')
      expect(replay).toBeDefined()
      const replayText = await Bun.file(path.join(repoRoot, replay!.filePath)).text()

      expect(replayText.includes('\\u001b[31mblocked_quality\\u001b[0m')).toBe(true)
      expect(replayText.includes('\\u001b[31mFAILED\\u001b[0m test:test-quality')).toBe(true)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  test('summarizes truncated changed files and coverage gaps in the replay', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-media-gaps-'))
    const report: BuildTrustRunnerReport = {
      repoRoot,
      profile: 'local',
      verdict: 'blocked_coverage',
      generatedAt: '2026-04-15T00:00:00.000Z',
      baseRef: 'origin/main',
      changedFiles: Array.from({ length: 11 }, (_, index) => `src/file-${index}.ts`),
      preflight: {
        repoRoot,
        packageManager: 'bun@1.3.11',
        bunVersion: '1.3.11',
        status: 'passed',
        checks: [],
      },
      commandResults: [],
      qualityReport: {
        errorCount: 0,
        warningCount: 0,
        findings: [],
      },
      stabilityRuns: [],
      coverage: {
        mode: 'changed_lines',
        baseRef: 'origin/main',
        status: 'failed',
        summary: 'coverage gap',
        changedExecutableLines: 4,
        changedCoveredLines: 3,
        changedLineCoveragePct: 75,
        criticalExecutableLines: 0,
        criticalCoveredLines: 0,
        criticalLineCoveragePct: 100,
        uncoveredRanges: [
          {
            filePath: 'src/file-10.ts',
            critical: false,
            ranges: ['10-12'],
          },
        ],
        nonExecutableFiles: [],
      },
      mutation: null,
      mediaArtifacts: [],
      riskSuites: [],
    }

    try {
      const artifacts = await generateBuildTrustMediaArtifacts(repoRoot, report)
      const replay = artifacts.find(artifact => artifact.kind === 'replay')
      expect(replay).toBeDefined()
      const replayText = await Bun.file(path.join(repoRoot, replay!.filePath)).text()

      expect(replayText.includes('  ... 1 more')).toBe(true)
      expect(replayText.includes('src/file-10.ts 10-12')).toBe(true)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})
