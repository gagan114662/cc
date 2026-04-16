// test-intent: proves the changed-line coverage gate blocks uncovered changed behavior and reports exact gaps.
// test-spec: specs/build-trust-harness.md#changed-line-coverage
import { describe, expect, test } from 'bun:test'
import {
  evaluateCoverageAgainstChanges,
  parseLcov,
  parseUnifiedDiffChangedLines,
} from '../scripts/buildTrustCoverage.js'

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
  },
  qualityRules: {
    computedExpectedSeverity: {
      local: 'error',
      ci: 'error',
      release: 'error',
    },
    requireNegativeCaseForChangedTests: true,
    forbidSnapshotOnlyAssertions: true,
    forbidAnswerLeakage: true,
    requireSuppressionReason: true,
  },
} as any

describe('buildTrustCoverage', () => {
  test('ignores DA records before the first source file header', () => {
    const coverage = parseLcov(`
      TN:
      DA:1,1
      SF:src/example.ts
      DA:10,1
      end_of_record
    `)

    expect(coverage.size).toBe(1)
    expect([...coverage.keys()]).toEqual(['src/example.ts'])
    expect(coverage.get('src/example.ts')?.get(10)).toBe(1)
  })

  test('passes when changed-line coverage meets thresholds', () => {
    const coverage = parseLcov(`
      TN:
      SF:src/example.ts
      DA:10,1
      DA:11,1
      end_of_record
    `)
    const changedLines = new Map([['src/example.ts', new Set([10, 11])]])

    const report = evaluateCoverageAgainstChanges(
      coverage,
      changedLines,
      policy,
      'changed_lines',
      'origin/main',
    )

    expect(report.status).toBe('passed')
    expect(report.changedLineCoveragePct).toBe(100)
  })

  test('parses unified diff hunks without adding an extra changed line', () => {
    const changed = parseUnifiedDiffChangedLines(
      [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -4,0 +5,2 @@',
      ].join('\n'),
    )

    expect([...((changed.get('src/example.ts') as Set<number>) ?? new Set())]).toEqual([
      5,
      6,
    ])
  })

  test('fails with exact uncovered ranges', () => {
    const coverage = parseLcov(`
      TN:
      SF:services/deterministicHarness/runtime.ts
      DA:20,1
      DA:21,0
      DA:22,1
      DA:23,0
      end_of_record
    `)
    const changedLines = new Map([
      ['services/deterministicHarness/runtime.ts', new Set([20, 21, 22, 23])],
    ])

    const report = evaluateCoverageAgainstChanges(
      coverage,
      changedLines,
      policy,
      'changed_lines',
      'origin/main',
    )

    expect(report.status).toBe('failed')
    expect(report.uncoveredRanges[0]?.ranges).toEqual(['21', '23'])
  })

  test('compresses contiguous uncovered lines into a single range', () => {
    const coverage = parseLcov(`
      TN:
      SF:src/ranged.ts
      DA:20,1
      DA:21,0
      DA:22,0
      DA:23,1
      end_of_record
    `)
    const changedLines = new Map([['src/ranged.ts', new Set([20, 21, 22, 23])]])

    const report = evaluateCoverageAgainstChanges(
      coverage,
      changedLines,
      policy,
      'changed_lines',
      'origin/main',
    )

    expect(report.uncoveredRanges[0]?.ranges).toEqual(['21-22'])
  })

  test('treats non-executable changed lines separately', () => {
    const coverage = parseLcov(`
      TN:
      SF:src/example.ts
      DA:10,1
      end_of_record
    `)
    const changedLines = new Map([
      ['src/example.ts', new Set([99])],
    ])

    const report = evaluateCoverageAgainstChanges(
      coverage,
      changedLines,
      policy,
      'changed_lines',
      'origin/main',
    )

    expect(report.nonExecutableFiles).toEqual(['src/example.ts'])
    expect(report.changedExecutableLines).toBe(0)
  })
})
