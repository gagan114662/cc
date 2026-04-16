// test-intent: proves changed source code must fail tests under simple adversarial mutations or the trust gate blocks the build.
// test-spec: specs/build-trust-harness.md#mutation-sensitivity
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  collectMutationCandidates,
  getMutationTestCommand,
  runBuildTrustMutation,
} from '../scripts/buildTrustMutation.js'

const policy = {
  version: '1',
  baseRefResolution: ['origin/main', 'main'],
  criticalGlobs: ['services/deterministicHarness/**'],
  profiles: {
    local: {
      rerunEach: 2,
      randomSeeds: [101],
      runCoverage: true,
      runSmokeEmployee: false,
      requireProofArtifact: true,
    },
    ci: {
      rerunEach: 3,
      randomSeeds: [101, 202, 303],
      runCoverage: true,
      runSmokeEmployee: false,
      requireProofArtifact: true,
    },
    release: {
      rerunEach: 3,
      randomSeeds: [101, 202, 303],
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
} as const

describe('buildTrustMutation', () => {
  test('collects boolean and boundary mutations only from changed lines', () => {
    const candidates = collectMutationCandidates(
      'src/example.ts',
      `
        export function isAllowed(count: number, enabled: boolean): boolean {
          if (count >= 2 && enabled) {
            return true
          }
          return false
        }
      `,
      new Set([3, 4]),
    )

    expect(candidates.map(candidate => candidate.replacement)).toEqual([
      '>',
      'false',
    ])
  })

  test('does not mutate boolean literals that are constructor or call arguments', () => {
    const candidates = collectMutationCandidates(
      'src/example.ts',
      `
        export function createFlag(): boolean {
          return Boolean(true)
        }
      `,
      new Set([3]),
    )

    expect(candidates).toEqual([])
  })

  test('returns no mutation candidates when no changed lines are provided', () => {
    const candidates = collectMutationCandidates(
      'src/example.ts',
      'export const featureFlag = true\n',
      new Set(),
    )

    expect(candidates).toEqual([])
  })

  test('parses tsx files when collecting mutation candidates', () => {
    const candidates = collectMutationCandidates(
      'src/example.tsx',
      `
        export function FeatureFlag(): boolean {
          return true
        }
      `,
      new Set([3]),
    )

    expect(candidates.map(candidate => candidate.replacement)).toEqual(['false'])
  })

  test('prefers changed test files when building the mutation command', () => {
    const command = getMutationTestCommand(policy as any, [
      'src/example.ts',
      'test/example.test.ts',
      'test/other.test.ts',
    ])

    expect(command).toBe(
      "bun test 'test/example.test.ts' 'test/other.test.ts'",
    )
  })

  test('skips mutation sensitivity when the policy disables mutation trials', async () => {
    const report = await runBuildTrustMutation(
      {
        repoRoot: '/repo',
        profile: 'local',
        policy: {
          ...policy,
          mutationRules: {
            ...policy.mutationRules,
            enabled: false,
          },
        } as any,
        changedFiles: ['src/example.ts'],
        changedLines: new Map([
          ['src/example.ts', new Set([3])],
        ]),
      },
      async (_label, command) => ({
        label: 'mutation',
        command,
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
      }),
    )

    expect(report.status).toBe('skipped')
    expect(report.executedTrialCount).toBe(0)
    expect(report.summary).toContain('disabled by policy')
  })

  test('skips mutation sensitivity when only changed test files are present', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-tests-only-'))
    await mkdir(path.join(repoRoot, 'test'), { recursive: true })
    await writeFile(
      path.join(repoRoot, 'test', 'feature.test.ts'),
      `
        // test-intent: proves the test-only change path should not be treated as source mutation work.
        import { expect, test } from 'bun:test'
        test('sanity', () => {
          expect('mutation-only'.startsWith('mutation')).toBe(true)
        })
      `,
      'utf8',
    )

    try {
      const report = await runBuildTrustMutation(
        {
          repoRoot,
          profile: 'local',
          policy: policy as any,
          changedFiles: ['test/feature.test.ts'],
          changedLines: new Map([
            ['test/feature.test.ts', new Set([4])],
          ]),
        },
        async (_label, command) => ({
          label: 'mutation',
          command,
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
        }),
      )

      expect(report.status).toBe('skipped')
      expect(report.changedSourceFileCount).toBe(0)
      expect(report.executedTrialCount).toBe(0)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  test('skips mutation sensitivity when changed source lines have no supported mutations', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-no-mutations-'))
    await mkdir(path.join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      path.join(repoRoot, 'src', 'constants.ts'),
      `
        export const BUILD_TRUST_LABEL = 'stable'
        export const BUILD_TRUST_VERSION = 1
      `,
      'utf8',
    )

    try {
      const report = await runBuildTrustMutation(
        {
          repoRoot,
          profile: 'local',
          policy: policy as any,
          changedFiles: ['src/constants.ts'],
          changedLines: new Map([
            ['src/constants.ts', new Set([2, 3])],
          ]),
        },
        async (_label, command) => ({
          label: 'mutation',
          command,
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
        }),
      )

      expect(report.status).toBe('skipped')
      expect(report.candidateCount).toBe(0)
      expect(report.summary.includes('No simple boolean or boundary mutations')).toBe(
        true,
      )
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  test('kills mutations and restores the original source afterwards', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-mutation-'))
    await mkdir(path.join(repoRoot, 'src'), { recursive: true })
    await mkdir(path.join(repoRoot, 'test'), { recursive: true })
    const sourcePath = path.join(repoRoot, 'src', 'feature.ts')
    const moduleBaseline = `
      export function allow(enabled: boolean): boolean {
        return enabled === true
      }
    `
    await writeFile(sourcePath, moduleBaseline, 'utf8')
    await writeFile(
      path.join(repoRoot, 'test', 'feature.test.ts'),
      `
        // test-intent: proves allow returns true only when the feature flag is enabled.
        import { allow } from '../src/feature.ts'
        import { expect, test } from 'bun:test'
        test('returns true when enabled', () => {
          expect(allow(true)).toBe(true)
        })
        test('returns false when disabled', () => {
          expect(allow(false)).toBe(false)
        })
      `,
      'utf8',
    )

    try {
      const report = await runBuildTrustMutation(
        {
          repoRoot,
          profile: 'local',
          policy: policy as any,
          changedFiles: ['src/feature.ts', 'test/feature.test.ts'],
          changedLines: new Map([
            ['src/feature.ts', new Set([3])],
          ]),
        },
        async (_label, command, cwd) => {
          const source = await readFile(path.join(cwd, 'src', 'feature.ts'), 'utf8')
          return {
            label: 'mutation',
            command,
            status: source === moduleBaseline ? 'passed' : 'failed',
            exitCode: source === moduleBaseline ? 0 : 1,
            durationMs: 1,
            stdout: '',
            stderr: '',
          }
        },
      )

      expect(report.status).toBe('passed')
      expect(report.trials.every(trial => trial.status === 'killed')).toBe(true)
      expect(await readFile(sourcePath, 'utf8')).toBe(moduleBaseline)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  test('fails when a mutant survives the targeted tests', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-survivor-'))
    await mkdir(path.join(repoRoot, 'src'), { recursive: true })
    const sourcePath = path.join(repoRoot, 'src', 'feature.ts')
    await writeFile(
      sourcePath,
      `
        export function allow(enabled: boolean): boolean {
          return enabled === true
        }
      `,
      'utf8',
    )

    try {
      const report = await runBuildTrustMutation(
        {
          repoRoot,
          profile: 'local',
          policy: policy as any,
          changedFiles: ['src/feature.ts'],
          changedLines: new Map([
            ['src/feature.ts', new Set([3])],
          ]),
        },
        async (_label, command) => ({
          label: 'mutation',
          command,
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
        }),
      )

      expect(report.status).toBe('failed')
      expect(report.survivingTrialCount).toBeGreaterThan(0)
      expect(report.summary.includes('survived')).toBe(true)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})
