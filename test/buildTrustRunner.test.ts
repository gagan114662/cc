// test-intent: proves the trust runner stops on environment failures and includes local worktree changes in verification.
// test-spec: specs/build-trust-harness.md#trust-runner
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  collectGitContext,
  parseArgs,
  runBuildTrust,
} from '../scripts/buildTrustRunner.js'

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-'))
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: 'tmp-build-trust',
      private: true,
      packageManager: `bun@${Bun.version}`,
      dependencies: {},
    }),
    'utf8',
  )
  await writeFile(path.join(repoRoot, 'bun.lock'), '', 'utf8')
  return repoRoot
}

function runGit(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  }
  return result.stdout
}

const policy = {
  version: '1',
  baseRefResolution: ['origin/main', 'main'],
  criticalGlobs: ['services/deterministicHarness/**'],
  profiles: {
    local: {
      rerunEach: 2,
      randomSeeds: [101, 202],
      runCoverage: true,
      runSmokeEmployee: false,
      requireProofArtifact: true,
    },
    ci: {
      rerunEach: 3,
      randomSeeds: [101, 202],
      runCoverage: true,
      runSmokeEmployee: false,
      requireProofArtifact: true,
    },
    release: {
      rerunEach: 3,
      randomSeeds: [101, 202],
      runCoverage: true,
      runSmokeEmployee: true,
      requireProofArtifact: true,
    },
  },
  thresholds: {
    minChangedLineCoveragePct: 90,
    minCriticalChangedLineCoveragePct: 95,
    maxFlakyFiles: 0,
    maxUnexplainedSuppressions: 0,
    maxQualityWarningsInCi: 0,
    maxSurvivingMutations: 0,
  },
  qualityRules: {
    computedExpectedSeverity: {
      local: 'error',
      ci: 'error',
      release: 'error',
    },
    requireIntentTraceForChangedTests: true,
    requireNegativeCaseForChangedTests: true,
    forbidSnapshotOnlyAssertions: true,
    forbidAnswerLeakage: true,
    requireSuppressionReason: true,
  },
  mutationRules: {
    enabled: true,
    maxTrialsPerRun: 4,
    testCommand: 'bun test ./test',
  },
} as any

describe('buildTrustRunner', () => {
  test('parses cli arguments for profile, html output, and json mode', () => {
    const parsed = parseArgs([
      '--profile',
      'release',
      '--html',
      './custom-proof.html',
      '--json',
    ])

    expect(parsed.profile).toBe('release')
    expect(parsed.htmlPath).toBe('./custom-proof.html')
    expect(parsed.json).toBe(true)
    expect(parsed.repoRoot).toBe(process.cwd())
  })

  test('keeps defaults when cli arguments are missing or invalid', () => {
    const parsed = parseArgs(['--profile', 'unknown'])

    expect(parsed.profile).toBe('local')
    expect(parsed.htmlPath).toBeUndefined()
    expect(parsed.json).toBe(false)
  })

  test('stops immediately on preflight failure', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-fail-'))
    await writeFile(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'tmp-build-trust',
        private: true,
        packageManager: 'bun@0.0.0',
        dependencies: {},
      }),
      'utf8',
    )

    const report = await runBuildTrust({
      profile: 'local',
      repoRoot,
    })

    expect(report.verdict).toBe('blocked_environment')
  })

  test('records per-seed stability results and fails on a cross-seed mismatch', async () => {
    const repoRoot = await createTempRepo()
    const report = await runBuildTrust(
      {
        profile: 'ci',
        repoRoot,
      },
      {
        loadPolicy: async () => policy,
        preflight: {
          repoRoot,
          packageManager: `bun@${Bun.version}`,
          bunVersion: Bun.version,
          status: 'passed',
          checks: [],
        },
        collectGitContext: async () => ({
          baseRef: 'origin/main',
          changedFiles: ['services/deterministicHarness/runtime.ts'],
          changedLines: new Map(),
        }),
        loadQualityReport: async () => ({
          repoRoot,
          scannedFileCount: 1,
          errorCount: 0,
          warningCount: 0,
          findings: [],
        }),
        buildCoverageReport: async () => ({
          mode: 'changed_lines',
          baseRef: 'origin/main',
          status: 'passed',
          summary: 'synthetic coverage',
          changedExecutableLines: 1,
          changedCoveredLines: 1,
          changedLineCoveragePct: 100,
          criticalExecutableLines: 1,
          criticalCoveredLines: 1,
          criticalLineCoveragePct: 100,
          uncoveredRanges: [],
          nonExecutableFiles: [],
        }),
        runCommand: async label => ({
          label,
          command: label,
          status:
            label === 'bun-test-seed-202'
              ? 'failed'
              : 'passed',
          exitCode: label === 'bun-test-seed-202' ? 1 : 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
        }),
      },
    )

    expect(report.stabilityRuns).toHaveLength(2)
    expect(report.verdict).toBe('blocked_flakiness')
    expect(report.stabilityRuns.some(run => run.seed === 202 && run.status === 'failed')).toBe(true)
  })

  test('classifies deterministic stability failures as verification failures', async () => {
    const repoRoot = await createTempRepo()
    const report = await runBuildTrust(
      {
        profile: 'local',
        repoRoot,
      },
      {
        loadPolicy: async () => ({
          ...policy,
          profiles: {
            ...policy.profiles,
            local: {
              ...policy.profiles.local,
              randomSeeds: [101],
            },
          },
        }),
        preflight: {
          repoRoot,
          packageManager: `bun@${Bun.version}`,
          bunVersion: Bun.version,
          status: 'passed',
          checks: [],
        },
        collectGitContext: async () => ({
          baseRef: 'origin/main',
          changedFiles: [],
          changedLines: new Map(),
        }),
        loadQualityReport: async () => ({
          repoRoot,
          scannedFileCount: 1,
          errorCount: 0,
          warningCount: 0,
          findings: [],
        }),
        buildCoverageReport: async () => ({
          mode: 'changed_lines',
          baseRef: 'origin/main',
          status: 'passed',
          summary: 'synthetic coverage',
          changedExecutableLines: 1,
          changedCoveredLines: 1,
          changedLineCoveragePct: 100,
          criticalExecutableLines: 0,
          criticalCoveredLines: 0,
          criticalLineCoveragePct: 100,
          uncoveredRanges: [],
          nonExecutableFiles: [],
        }),
        runCommand: async label => ({
          label,
          command: label,
          status: label === 'bun-test-seed-101' ? 'failed' : 'passed',
          exitCode: label === 'bun-test-seed-101' ? 1 : 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
        }),
      },
    )

    expect(report.verdict).toBe('blocked_verification')
  })

  test('writes an HTML artifact with the overview anchor', async () => {
    const repoRoot = process.cwd()
    const htmlPath = `./build-trust-proof-test-${process.pid}-${Date.now()}.html`
    const absoluteHtmlPath = path.join(repoRoot, htmlPath.slice(2))

    try {
      const report = await runBuildTrust(
        {
          profile: 'local',
          repoRoot,
          htmlPath,
        },
        {
          preflight: {
            repoRoot,
            packageManager: `bun@${Bun.version}`,
            bunVersion: Bun.version,
            status: 'passed',
            checks: [],
          },
          loadPolicy: async () => policy,
          collectGitContext: async () => ({
            baseRef: 'origin/main',
            changedFiles: [],
            changedLines: new Map(),
          }),
          loadQualityReport: async () => ({
            repoRoot,
            scannedFileCount: 1,
            errorCount: 0,
            warningCount: 0,
            findings: [],
          }),
          buildCoverageReport: async () => ({
            mode: 'changed_lines',
            baseRef: 'origin/main',
            status: 'passed',
            summary: 'synthetic coverage',
            changedExecutableLines: 1,
            changedCoveredLines: 1,
            changedLineCoveragePct: 100,
            criticalExecutableLines: 0,
            criticalCoveredLines: 0,
            criticalLineCoveragePct: 100,
            uncoveredRanges: [],
            nonExecutableFiles: [],
          }),
          generateMediaArtifacts: async () => [
            {
              label: 'Overview screenshot',
              kind: 'screenshot',
              filePath: 'build-trust-artifacts/test-overview.png',
              mediaType: 'image/png',
              description: 'Synthetic test artifact.',
            },
          ],
          runCommand: async label => ({
            label,
            command: label,
            status: 'passed',
            exitCode: 0,
            durationMs: 1,
            stdout: '',
            stderr: '',
          }),
        },
      )

      expect(report.verdict).toBe('trusted')
      expect(report.mediaArtifacts.length).toBeGreaterThan(0)
      const html = await Bun.file(absoluteHtmlPath).text()
      expect(html.includes('id="overview"')).toBe(true)
      expect(html.includes('Review Media')).toBe(true)
    } finally {
      await rm(absoluteHtmlPath, {
        force: true,
      })
    }
  })

  test('collects staged and unstaged worktree changes on top of the base diff', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-git-'))
    await mkdir(path.join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'tmp-build-trust',
        private: true,
        packageManager: `bun@${Bun.version}`,
        dependencies: {},
      }),
      'utf8',
    )
    await writeFile(path.join(repoRoot, 'bun.lock'), '', 'utf8')
    await writeFile(
      path.join(repoRoot, 'src/example.ts'),
      ['export const value = 1', 'export const untouched = 2', ''].join('\n'),
      'utf8',
    )

    try {
      runGit(repoRoot, ['init', '-b', 'main'])
      runGit(repoRoot, ['config', 'user.email', 'build-trust@example.com'])
      runGit(repoRoot, ['config', 'user.name', 'Build Trust'])
      runGit(repoRoot, ['add', '.'])
      runGit(repoRoot, ['commit', '-m', 'initial'])

      await writeFile(
        path.join(repoRoot, 'src/example.ts'),
        ['export const value = 42', 'export const untouched = 2', ''].join('\n'),
        'utf8',
      )

      const gitContext = await collectGitContext(repoRoot, policy)

      expect(gitContext.baseRef).toBe('main')
      expect(gitContext.changedFiles).toContain('src/example.ts')
      expect([...((gitContext.changedLines.get('src/example.ts') as Set<number>) ?? new Set())]).toContain(1)
    } finally {
      await rm(repoRoot, { force: true, recursive: true })
    }
  })

  test('records a policy load failure as blocked verification', async () => {
    const repoRoot = await createTempRepo()
    const report = await runBuildTrust(
      {
        profile: 'local',
        repoRoot,
      },
      {
        preflight: {
          repoRoot,
          packageManager: `bun@${Bun.version}`,
          bunVersion: Bun.version,
          status: 'passed',
          checks: [],
        },
        loadPolicy: async () => {
          throw new Error('policy boom')
        },
      },
    )

    expect(report.verdict).toBe('blocked_verification')
    expect(
      report.commandResults.some(result => result.label === 'load-build-trust-policy'),
    ).toBe(true)
  })

  test('records quality checker load failures as blocked quality', async () => {
    const repoRoot = await createTempRepo()
    const report = await runBuildTrust(
      {
        profile: 'local',
        repoRoot,
      },
      {
        loadPolicy: async () => policy,
        preflight: {
          repoRoot,
          packageManager: `bun@${Bun.version}`,
          bunVersion: Bun.version,
          status: 'passed',
          checks: [],
        },
        collectGitContext: async () => ({
          baseRef: 'origin/main',
          changedFiles: [],
          changedLines: new Map(),
        }),
        loadQualityReport: async () => {
          throw new Error('quality boom')
        },
      },
    )

    expect(report.verdict).toBe('blocked_quality')
    expect(
      report.commandResults.some(
        result => result.label === 'load-test-quality-checker',
      ),
    ).toBe(true)
  })

  test('fails ci coverage when no base ref is available even if lcov exists', async () => {
    const repoRoot = await createTempRepo()
    await mkdir(path.join(repoRoot, 'coverage', 'build-trust-ci'), {
      recursive: true,
    })
    await writeFile(
      path.join(repoRoot, 'coverage', 'build-trust-ci', 'lcov.info'),
      ['TN:', 'SF:src/example.ts', 'DA:1,1', 'end_of_record'].join('\n'),
      'utf8',
    )

    const report = await runBuildTrust(
      {
        profile: 'ci',
        repoRoot,
      },
      {
        loadPolicy: async () => policy,
        preflight: {
          repoRoot,
          packageManager: `bun@${Bun.version}`,
          bunVersion: Bun.version,
          status: 'passed',
          checks: [],
        },
        collectGitContext: async () => ({
          baseRef: null,
          changedFiles: [],
          changedLines: new Map(),
        }),
        loadQualityReport: async () => ({
          repoRoot,
          scannedFileCount: 0,
          errorCount: 0,
          warningCount: 0,
          findings: [],
        }),
        runCommand: async label => ({
          label,
          command: label,
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
        }),
      },
    )

    expect(report.verdict).toBe('blocked_coverage')
    expect(report.coverage?.summary.includes('require a resolvable base ref')).toBe(
      true,
    )
  })

  test('uses full repo fallback coverage for local runs without a base ref', async () => {
    const repoRoot = await createTempRepo()
    await mkdir(path.join(repoRoot, 'coverage', 'build-trust-local'), {
      recursive: true,
    })
    await writeFile(
      path.join(repoRoot, 'coverage', 'build-trust-local', 'lcov.info'),
      ['TN:', 'SF:src/example.ts', 'DA:1,1', 'end_of_record'].join('\n'),
      'utf8',
    )

    const report = await runBuildTrust(
      {
        profile: 'local',
        repoRoot,
      },
      {
        loadPolicy: async () => policy,
        preflight: {
          repoRoot,
          packageManager: `bun@${Bun.version}`,
          bunVersion: Bun.version,
          status: 'passed',
          checks: [],
        },
        collectGitContext: async () => ({
          baseRef: null,
          changedFiles: ['src/example.ts'],
          changedLines: new Map(),
        }),
        loadQualityReport: async () => ({
          repoRoot,
          scannedFileCount: 0,
          errorCount: 0,
          warningCount: 0,
          findings: [],
        }),
        runCommand: async label => ({
          label,
          command: label,
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
        }),
      },
    )

    expect(report.coverage?.mode).toBe('full_repo_fallback')
    expect(report.coverage?.status).toBe('passed')
  })

  test('blocks the build when a changed mutant survives', async () => {
    const repoRoot = await createTempRepo()
    const report = await runBuildTrust(
      {
        profile: 'local',
        repoRoot,
      },
      {
        loadPolicy: async () => policy,
        preflight: {
          repoRoot,
          packageManager: `bun@${Bun.version}`,
          bunVersion: Bun.version,
          status: 'passed',
          checks: [],
        },
        collectGitContext: async () => ({
          baseRef: 'origin/main',
          changedFiles: ['src/feature.ts', 'test/feature.test.ts'],
          changedLines: new Map([['src/feature.ts', new Set([10])]]),
        }),
        loadQualityReport: async () => ({
          repoRoot,
          scannedFileCount: 1,
          errorCount: 0,
          warningCount: 0,
          findings: [],
        }),
        buildCoverageReport: async () => ({
          mode: 'changed_lines',
          baseRef: 'origin/main',
          status: 'passed',
          summary: 'synthetic coverage',
          changedExecutableLines: 1,
          changedCoveredLines: 1,
          changedLineCoveragePct: 100,
          criticalExecutableLines: 0,
          criticalCoveredLines: 0,
          criticalLineCoveragePct: 100,
          uncoveredRanges: [],
          nonExecutableFiles: [],
        }),
        runMutationReport: async () => ({
          status: 'failed',
          summary: '1 mutation trial survived.',
          changedSourceFileCount: 1,
          candidateCount: 1,
          executedTrialCount: 1,
          survivingTrialCount: 1,
          trials: [
            {
              filePath: 'src/feature.ts',
              line: 10,
              description: 'invert strict equality',
              original: '===',
              replacement: '!==',
              status: 'survived',
              command: "bun test 'test/feature.test.ts'",
            },
          ],
        }),
        runCommand: async label => ({
          label,
          command: label,
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
        }),
      },
    )

    expect(report.verdict).toBe('blocked_quality')
    expect(report.mutation?.survivingTrialCount).toBe(1)
  })
})
