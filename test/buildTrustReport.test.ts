// test-intent: proves the trust proof report surfaces blocking causes, uncovered changes, and suite results for reviewers.
// test-spec: specs/build-trust-harness.md#proof-report
import { describe, expect, test } from 'bun:test'
import {
  renderBuildTrustHtml,
  type BuildTrustRunnerReport,
} from '../scripts/buildTrustReport.js'

describe('buildTrustReport', () => {
  test('renders findings, coverage ranges, and risk suites', () => {
    const report: BuildTrustRunnerReport = {
      repoRoot: '/repo',
      profile: 'ci',
      verdict: 'blocked_coverage',
      generatedAt: '2026-04-15T00:00:00.000Z',
      baseRef: 'origin/main',
      changedFiles: ['scripts/buildTrustRunner.ts'],
      preflight: {
        repoRoot: '/repo',
        packageManager: 'bun@1.3.11',
        bunVersion: '1.3.11',
        status: 'failed',
        checks: [
          {
            name: 'bun_version',
            status: 'failed',
            detail: 'Expected Bun 1.2.0, found 1.3.11.',
          },
        ],
      },
      commandResults: [
        {
          label: 'typecheck',
          command: 'bun run typecheck',
          status: 'failed',
          exitCode: 2,
          durationMs: 10,
          stdout: 'stdout detail',
          stderr: 'stderr detail',
        },
      ],
      qualityReport: {
        errorCount: 1,
        warningCount: 0,
        findings: [
          {
            filePath: 'test/example.test.ts',
            line: 10,
            ruleId: 'snapshot_only_assertion',
            severity: 'error',
            message: 'Need semantic assertions.',
            snippet: 'expect(result).toMatchSnapshot()',
          },
        ],
      },
      stabilityRuns: [
        {
          seed: 101,
          status: 'failed',
          junitPath: '/tmp/junit.xml',
          failingTests: ['fails loudly'],
        },
      ],
      coverage: {
        mode: 'changed_lines',
        baseRef: 'origin/main',
        status: 'failed',
        summary: 'coverage summary',
        changedExecutableLines: 10,
        changedCoveredLines: 7,
        changedLineCoveragePct: 70,
        criticalExecutableLines: 4,
        criticalCoveredLines: 3,
        criticalLineCoveragePct: 75,
        uncoveredRanges: [
          {
            filePath: 'scripts/buildTrustRunner.ts',
            critical: true,
            ranges: ['12-15', '20'],
          },
        ],
        nonExecutableFiles: ['README.md'],
      },
      mutation: {
        status: 'failed',
        summary: '1 mutation trial survived.',
        changedSourceFileCount: 1,
        candidateCount: 2,
        executedTrialCount: 1,
        survivingTrialCount: 1,
        trials: [
          {
            filePath: 'scripts/buildTrustRunner.ts',
            line: 42,
            description: 'invert strict equality',
            original: '===',
            replacement: '!==',
            status: 'survived',
            command: "bun test 'test/buildTrustRunner.test.ts'",
          },
        ],
      },
      mediaArtifacts: [
        {
          label: 'Overview screenshot',
          kind: 'screenshot',
          filePath: 'build-trust-artifacts/build-trust-ci-overview.png',
          mediaType: 'image/png',
          description: 'Compact PNG summary.',
        },
        {
          label: 'Terminal replay',
          kind: 'replay',
          filePath: 'build-trust-artifacts/build-trust-ci-replay.cast',
          mediaType: 'application/asciicast',
          description: 'Asciicast replay.',
        },
      ],
      riskSuites: [
        {
          label: 'test:autoresearch',
          status: 'failed',
          reason: 'Triggered by autoresearch changes.',
        },
      ],
    }

    const html = renderBuildTrustHtml(report)

    expect(html.includes('snapshot_only_assertion')).toBe(true)
    expect(html.includes('scripts/buildTrustRunner.ts 12-15, 20')).toBe(true)
    expect(html.includes('README.md')).toBe(true)
    expect(html.includes('test:autoresearch: failed')).toBe(true)
    expect(html.includes('Mutation Sensitivity')).toBe(true)
    expect(html.includes('scripts/buildTrustRunner.ts:42')).toBe(true)
    expect(html.includes('Review Media')).toBe(true)
    expect(html.includes('id="review-console"')).toBe(true)
    expect(html.includes('id="review-search"')).toBe(true)
    expect(html.includes('Blockers only')).toBe(true)
    expect(html.includes('data-review-item')).toBe(true)
    expect(html.includes('reviewQuery')).toBe(true)
    expect(html.includes('data-proof-nav="command-results"')).toBe(true)
    expect(html.includes('data-proof-nav="review-console"')).toBe(true)
    expect(html.includes('id="final-verdict"')).toBe(true)
    expect(html.includes('build-trust-artifacts/build-trust-ci-overview.png')).toBe(true)
    expect(html.includes('<img src="build-trust-artifacts/build-trust-ci-overview.png"')).toBe(true)
    expect(html.includes('failing tests: fails loudly'.toUpperCase())).toBe(
      false,
    )
    expect(html.includes('Failing tests: fails loudly')).toBe(true)
  })

  test('renders missing coverage state without findings', () => {
    const html = renderBuildTrustHtml({
      repoRoot: '/repo',
      profile: 'local',
      verdict: 'trusted',
      generatedAt: '2026-04-15T00:00:00.000Z',
      baseRef: null,
      changedFiles: [],
      preflight: {
        repoRoot: '/repo',
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
    })

    expect(html.includes('No suspicious test-quality shortcuts detected.')).toBe(
      true,
    )
    expect(html.includes('No coverage report generated.')).toBe(true)
  })

  test('maps warning and informational quality findings into review-console severities', () => {
    const html = renderBuildTrustHtml({
      repoRoot: '/repo',
      profile: 'local',
      verdict: 'blocked_quality',
      generatedAt: '2026-04-15T00:00:00.000Z',
      baseRef: 'origin/main',
      changedFiles: ['scripts/testQualityCheck.ts'],
      preflight: {
        repoRoot: '/repo',
        packageManager: 'bun@1.3.11',
        bunVersion: '1.3.11',
        status: 'passed',
        checks: [],
      },
      commandResults: [],
      qualityReport: {
        errorCount: 0,
        warningCount: 1,
        findings: [
          {
            filePath: 'test/example-warning.test.ts',
            line: 8,
            ruleId: 'missing_negative_case',
            severity: 'warning',
            message: 'Needs a neighboring case.',
            snippet: 'test("happy path", () => {})',
          },
          {
            filePath: 'test/example-info.test.ts',
            line: 12,
            ruleId: 'manual_review_note',
            severity: 'note',
            message: 'Reviewer note.',
            snippet: 'expect(true).toBe(true)',
          },
        ],
      },
      stabilityRuns: [],
      coverage: null,
      mutation: null,
      mediaArtifacts: [],
      riskSuites: [],
    })

    expect(html.includes('QUALITY · WARNING')).toBe(true)
    expect(html.includes('QUALITY · INFO')).toBe(true)
    expect(html.includes('data-review-severity="warning"')).toBe(true)
    expect(html.includes('data-review-severity="info"')).toBe(true)
  })
})
