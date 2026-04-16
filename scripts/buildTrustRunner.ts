#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  generateBuildTrustMediaArtifacts,
  type BuildTrustMediaArtifact,
} from './buildTrustMediaArtifacts.js'
import {
  renderBuildTrustHtml,
  type BuildTrustCommandResult,
  type BuildTrustRunnerReport,
  type BuildTrustRiskSuite,
  type BuildTrustStabilityRun,
} from './buildTrustReport.js'
import {
  runBuildTrustPreflight,
  type BuildTrustPreflightReport,
} from './buildTrustPreflight.js'
import { validateReport } from './reportUtils.ts'
import {
  mergeChangedLineSets,
  parseUnifiedDiffChangedLines,
  type BuildTrustCoverageReport,
  type ChangedLineSet,
} from './buildTrustCoverage.js'
import {
  runBuildTrustMutation,
  type BuildTrustMutationReport,
} from './buildTrustMutation.js'
import type { TestQualityReport } from './testQualityCheck.js'
import type {
  BuildTrustPolicy,
  BuildTrustProfileName,
} from 'src/services/buildTrust/types.js'

type BuildTrustRunnerOptions = {
  profile: BuildTrustProfileName
  repoRoot: string
  htmlPath?: string
  json?: boolean
}

type BuildTrustRunnerOverrides = {
  preflight?: BuildTrustPreflightReport
  runCommand?: typeof runCommand
  loadPolicy?: (repoRoot: string) => Promise<BuildTrustPolicy | null>
  loadQualityReport?: (repoRoot: string) => Promise<TestQualityReport>
  collectGitContext?: (repoRoot: string, policy: BuildTrustPolicy) => Promise<GitContext>
  buildCoverageReport?: (
    repoRoot: string,
    profile: BuildTrustProfileName,
    policy: BuildTrustPolicy,
    gitContext: GitContext,
  ) => Promise<BuildTrustCoverageReport | null>
  runMutationReport?: (
    repoRoot: string,
    profile: BuildTrustProfileName,
    policy: BuildTrustPolicy,
    gitContext: GitContext,
    commandRunner: typeof runCommand,
  ) => Promise<BuildTrustMutationReport | null>
  generateMediaArtifacts?: (
    repoRoot: string,
    report: BuildTrustRunnerReport,
  ) => Promise<BuildTrustMediaArtifact[]>
}

type GitContext = {
  baseRef: string | null
  changedFiles: string[]
  changedLines: Map<string, Set<number>>
}

type GitStatusEntry = {
  code: string
  path: string
}

export function parseArgs(argv: string[]): BuildTrustRunnerOptions {
  let profile: BuildTrustProfileName = 'local'
  let htmlPath: string | undefined
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') {
      const value = argv[index + 1]
      if (value === 'local' || value === 'ci' || value === 'release') {
        profile = value
      }
      index += 1
      continue
    }
    if (arg === '--html') {
      htmlPath = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--json') {
      json = true
    }
  }

  return {
    profile,
    repoRoot: process.cwd(),
    htmlPath,
    json,
  }
}

async function runCommand(
  label: string,
  command: string,
  cwd: string,
): Promise<BuildTrustCommandResult> {
  const startedAt = Date.now()
  return await new Promise(resolve => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)))
    child.on('close', exitCode => {
      resolve({
        label,
        command,
        status: exitCode === 0 ? 'passed' : 'failed',
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdoutChunks).toString('utf8').trim(),
        stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
      })
    })
    child.on('error', error => {
      resolve({
        label,
        command,
        status: 'failed',
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: String(error),
      })
    })
  })
}

async function resolveBaseRef(
  repoRoot: string,
  policy: BuildTrustPolicy,
): Promise<string | null> {
  for (const candidate of policy.baseRefResolution) {
    const result = await runCommand(
      `git-rev-parse-${candidate}`,
      `git rev-parse --verify ${candidate}`,
      repoRoot,
    )
    if (result.exitCode === 0) {
      return candidate
    }
  }
  return null
}

function parseStatusChangedFiles(statusOutput: string): string[] {
  return parseStatusEntries(statusOutput)
    .map(entry => entry.path)
    .sort()
}

function parseStatusEntries(statusOutput: string): GitStatusEntry[] {
  return statusOutput
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(.{1,2})\s+(.*)$/)
      const code = match?.[1] ?? line.slice(0, 2)
      const rawPath = (match?.[2] ?? line.slice(3)).trim()
      const pathText = rawPath.includes(' -> ')
        ? rawPath.split(' -> ').at(-1) ?? rawPath
        : rawPath
      return {
        code,
        path: path.normalize(pathText),
      }
    })
}

async function collectUntrackedChangedLines(
  repoRoot: string,
  statusEntries: GitStatusEntry[],
): Promise<ChangedLineSet> {
  const changedLines: ChangedLineSet = new Map()

  for (const entry of statusEntries) {
    if (entry.code !== '??') {
      continue
    }
    const absolutePath = path.join(repoRoot, entry.path)
    const source = await readFile(absolutePath, 'utf8').catch(() => null)
    if (source === null) {
      continue
    }
    const lineCount = Math.max(1, source.split('\n').length)
    const lines = new Set<number>()
    for (let line = 1; line <= lineCount; line += 1) {
      lines.add(line)
    }
    changedLines.set(entry.path, lines)
  }

  return changedLines
}

async function collectWorktreeContext(
  repoRoot: string,
  commandRunner: typeof runCommand = runCommand,
): Promise<{
  changedFiles: string[]
  changedLines: ChangedLineSet
}> {
  const statusResult = await commandRunner('git-status', 'git status --short', repoRoot)
  const stagedDiffResult = await commandRunner(
    'git-diff-cached-patch',
    'git diff --cached --unified=0',
    repoRoot,
  )
  const worktreeDiffResult = await commandRunner(
    'git-diff-worktree-patch',
    'git diff --unified=0',
    repoRoot,
  )
  const statusEntries = parseStatusEntries(statusResult.stdout)
  const untrackedChangedLines = await collectUntrackedChangedLines(
    repoRoot,
    statusEntries,
  )

  return {
    changedFiles: statusEntries.map(entry => entry.path).sort(),
    changedLines: mergeChangedLineSets(
      parseUnifiedDiffChangedLines(stagedDiffResult.stdout),
      parseUnifiedDiffChangedLines(worktreeDiffResult.stdout),
      untrackedChangedLines,
    ),
  }
}

export async function collectGitContext(
  repoRoot: string,
  policy: BuildTrustPolicy,
): Promise<GitContext> {
  const baseRef = await resolveBaseRef(repoRoot, policy)
  const worktreeContext = await collectWorktreeContext(repoRoot)
  if (!baseRef) {
    return {
      baseRef: null,
      changedFiles: worktreeContext.changedFiles,
      changedLines: worktreeContext.changedLines,
    }
  }

  const changedFilesResult = await runCommand(
    'git-diff-name-only',
    `git diff --name-only ${baseRef}...HEAD`,
    repoRoot,
  )
  const diffResult = await runCommand(
    'git-diff-patch',
    `git diff --unified=0 ${baseRef}...HEAD`,
    repoRoot,
  )

  return {
    baseRef,
    changedFiles: [...new Set([
      ...changedFilesResult.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => path.normalize(line)),
      ...worktreeContext.changedFiles,
    ])].sort(),
    changedLines: mergeChangedLineSets(
      parseUnifiedDiffChangedLines(diffResult.stdout),
      worktreeContext.changedLines,
    ),
  }
}

function parseFailingTests(junitXml: string): string[] {
  const failing: string[] = []
  const testcaseRe =
    /<testcase\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/testcase>|<testcase\b[^>]*name="([^"]+)"[^>]*\/>/g
  for (const match of junitXml.matchAll(testcaseRe)) {
    const name = match[1] ?? match[3]
    const body = match[2] ?? ''
    if (!name) continue
    if (/<failure\b|<error\b/.test(body)) {
      failing.push(name)
    }
  }
  return failing.sort()
}

async function runStabilityTests(
  repoRoot: string,
  profile: BuildTrustProfileName,
  policy: BuildTrustPolicy,
  commandRunner: typeof runCommand = runCommand,
): Promise<{
  commandResults: BuildTrustCommandResult[]
  stabilityRuns: BuildTrustStabilityRun[]
}> {
  const commandResults: BuildTrustCommandResult[] = []
  const stabilityRuns: BuildTrustStabilityRun[] = []
  const coverageDir = path.join('coverage', `build-trust-${profile}`)
  const reporterDir = path.join(repoRoot, coverageDir, 'junit')
  await mkdir(reporterDir, { recursive: true })

  for (const seed of policy.profiles[profile].randomSeeds) {
    const junitPath = path.join(reporterDir, `seed-${seed}.xml`)
    const coverageArgs =
      seed === policy.profiles[profile].randomSeeds[0] &&
      policy.profiles[profile].runCoverage
        ? ` --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir ${coverageDir}`
        : ''
    const command =
      `bun test ./test --randomize --seed ${seed} --rerun-each ${policy.profiles[profile].rerunEach}` +
      ` --retry 0 --reporter=junit --reporter-outfile ${junitPath}${coverageArgs}`
    const result = await commandRunner(`bun-test-seed-${seed}`, command, repoRoot)
    commandResults.push(result)
    const junitXml =
      result.status === 'passed'
        ? await readFile(junitPath, 'utf8').catch(() => '')
        : await readFile(junitPath, 'utf8').catch(() => result.stdout)
    stabilityRuns.push({
      seed,
      status: result.status === 'passed' ? 'passed' : 'failed',
      junitPath,
      failingTests: junitXml ? parseFailingTests(junitXml) : [],
    })
  }

  return {
    commandResults,
    stabilityRuns,
  }
}

function determineVerdict(input: {
  preflight: BuildTrustPreflightReport
  commandResults: BuildTrustCommandResult[]
  qualityReport: TestQualityReport
  coverage: BuildTrustCoverageReport | null
  mutation: BuildTrustMutationReport | null
  stabilityRuns: BuildTrustStabilityRun[]
}): BuildTrustRunnerReport['verdict'] {
  if (input.preflight.status === 'failed') {
    return 'blocked_environment'
  }
  if (input.qualityReport.errorCount > 0 || input.qualityReport.warningCount > 0) {
    return 'blocked_quality'
  }
  const failedStabilityRuns = input.stabilityRuns.filter(
    run => run.status === 'failed',
  )
  if (failedStabilityRuns.length > 0) {
    const passedSeeds = input.stabilityRuns.filter(run => run.status === 'passed')
    if (passedSeeds.length > 0) {
      return 'blocked_flakiness'
    }
    const canonicalFailures = new Set(
      failedStabilityRuns.map(run => run.failingTests.slice().sort().join('\n')),
    )
    if (canonicalFailures.size > 1) {
      return 'blocked_flakiness'
    }
    return 'blocked_verification'
  }
  if (input.coverage && input.coverage.status === 'failed') {
    return 'blocked_coverage'
  }
  if (input.mutation && input.mutation.status === 'failed') {
    return 'blocked_quality'
  }
  if (input.commandResults.some(result => result.status === 'failed')) {
    return 'blocked_verification'
  }
  return 'trusted'
}

function shouldRunTriggeredSuite(
  changedFiles: string[],
  globs: string[],
): boolean {
  const matchers = globs.map(glob =>
    new RegExp(
      `^${glob
        .replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
        .replaceAll('**', '::double-star::')
        .replaceAll('*', '[^/]*')
        .replaceAll('::double-star::', '.*')}$`,
    ),
  )
  return changedFiles.some(filePath => matchers.some(match => match.test(filePath)))
}

async function maybeRunRiskSuite(
  repoRoot: string,
  shouldRun: boolean,
  label: string,
  command: string,
  reason: string,
  commandRunner: typeof runCommand = runCommand,
): Promise<{
  suite: BuildTrustRiskSuite
  commandResult: BuildTrustCommandResult | null
}> {
  if (!shouldRun) {
    return {
      suite: {
        label,
        status: 'skipped',
        reason,
      },
      commandResult: null,
    }
  }

  const result = await commandRunner(label, command, repoRoot)
  return {
    suite: {
      label,
      status: result.status,
      reason,
    },
    commandResult: result,
  }
}

async function buildCoverageReport(
  repoRoot: string,
  profile: BuildTrustProfileName,
  policy: BuildTrustPolicy,
  gitContext: GitContext,
): Promise<BuildTrustCoverageReport | null> {
  if (!policy.profiles[profile].runCoverage) {
    return null
  }

  const coveragePath = path.join(
    repoRoot,
    'coverage',
    `build-trust-${profile}`,
    'lcov.info',
  )
  const lcov = await readFile(coveragePath, 'utf8').catch(() => null)
  if (!lcov) {
    return {
      mode: gitContext.baseRef ? 'changed_lines' : 'full_repo_fallback',
      baseRef: gitContext.baseRef,
      status: 'failed',
      summary: `Coverage data is missing at ${coveragePath}.`,
      changedExecutableLines: 0,
      changedCoveredLines: 0,
      changedLineCoveragePct: 0,
      criticalExecutableLines: 0,
      criticalCoveredLines: 0,
      criticalLineCoveragePct: 0,
      uncoveredRanges: [],
      nonExecutableFiles: [],
    }
  }

  if (!gitContext.baseRef && profile !== 'local') {
    return {
      mode: 'full_repo_fallback',
      baseRef: null,
      status: 'failed',
      summary: 'CI and release profiles require a resolvable base ref.',
      changedExecutableLines: 0,
      changedCoveredLines: 0,
      changedLineCoveragePct: 0,
      criticalExecutableLines: 0,
      criticalCoveredLines: 0,
      criticalLineCoveragePct: 0,
      uncoveredRanges: [],
      nonExecutableFiles: [],
    }
  }

  const { evaluateCoverageAgainstChanges, parseLcov } = await import(
    './buildTrustCoverage.js'
  )
  const coverageMap = parseLcov(lcov)
  if (gitContext.baseRef) {
    return evaluateCoverageAgainstChanges(
      coverageMap,
      gitContext.changedLines,
      policy,
      'changed_lines',
      gitContext.baseRef,
    )
  }

  const fullRepoLines = new Map<string, Set<number>>()
  for (const [filePath, lineMap] of coverageMap.entries()) {
    fullRepoLines.set(filePath, new Set(lineMap.keys()))
  }
  return evaluateCoverageAgainstChanges(
    coverageMap,
    fullRepoLines,
    policy,
    'full_repo_fallback',
    null,
  )
}

export async function runBuildTrust(
  options: BuildTrustRunnerOptions,
  overrides: BuildTrustRunnerOverrides = {},
): Promise<BuildTrustRunnerReport> {
  const preflight =
    overrides.preflight ?? (await runBuildTrustPreflight(options.repoRoot))
  const commandRunner = overrides.runCommand ?? runCommand
  const commandResults: BuildTrustCommandResult[] = []
  const riskSuites: BuildTrustRiskSuite[] = []
  let coverage: BuildTrustCoverageReport | null = null
  let mutation: BuildTrustMutationReport | null = null
  let mediaArtifacts: BuildTrustMediaArtifact[] = []
  let stabilityRuns: BuildTrustStabilityRun[] = []
  let gitContext: GitContext = {
    baseRef: null,
    changedFiles: [],
    changedLines: new Map(),
  }
  let qualityReport: TestQualityReport = {
    repoRoot: options.repoRoot,
    scannedFileCount: 0,
    errorCount: 0,
    warningCount: 0,
    findings: [],
  }
  let policy: BuildTrustPolicy | null = null

  if (preflight.status === 'passed') {
    policy = await (overrides.loadPolicy
      ? overrides.loadPolicy(options.repoRoot)
      : import('src/services/buildTrust/policy.js').then(module =>
          module.loadBuildTrustPolicy(options.repoRoot),
        ))
      .catch(error => {
        commandResults.push({
          label: 'load-build-trust-policy',
          command: 'load build trust policy',
          status: 'failed',
          exitCode: 1,
          durationMs: 0,
          stdout: '',
          stderr: String(error),
        })
        return null
      })
    if (policy) {
      gitContext = await (overrides.collectGitContext
        ? overrides.collectGitContext(options.repoRoot, policy)
        : collectGitContext(options.repoRoot, policy))
    }
  }

  if (preflight.status === 'passed' && policy) {
    for (const [label, command] of [
      ['typecheck', 'bun run typecheck'],
      ['lint', 'bun run lint'],
      ['build', 'bun run build'],
    ] as const) {
      const result = await commandRunner(label, command, options.repoRoot)
      commandResults.push(result)
      if (result.status === 'failed') {
        break
      }
    }
  }

  if (preflight.status === 'passed') {
    qualityReport = await (overrides.loadQualityReport
      ? overrides.loadQualityReport(options.repoRoot)
      : import('./testQualityCheck.js').then(module =>
          module.runTestQualityCheck(options.repoRoot),
        ))
      .catch(error => {
        commandResults.push({
          label: 'load-test-quality-checker',
          command: 'load AST test quality checker',
          status: 'failed',
          exitCode: 1,
          durationMs: 0,
          stdout: '',
          stderr: String(error),
        })
        return {
          repoRoot: options.repoRoot,
          scannedFileCount: 0,
          errorCount: 1,
          warningCount: 0,
          findings: [
            {
              filePath: 'scripts/testQualityCheck.ts',
              line: 1,
              ruleId: 'environment_failure',
              severity: 'error',
              message:
                'Failed to load the AST-based test quality checker in the current environment.',
              snippet: String(error),
            },
          ],
        } satisfies TestQualityReport
      })
  }

  commandResults.push({
    label: 'test:test-quality',
    command: 'bun run test:test-quality',
    status:
      preflight.status !== 'passed'
        ? 'skipped'
        : qualityReport.errorCount === 0 && qualityReport.warningCount === 0
          ? 'passed'
          : 'failed',
    exitCode:
      preflight.status !== 'passed'
        ? null
        : qualityReport.errorCount === 0 && qualityReport.warningCount === 0
          ? 0
          : 1,
    durationMs: 0,
    stdout:
      preflight.status !== 'passed'
        ? 'Skipped because dependency preflight failed.'
        : `${qualityReport.errorCount} errors, ${qualityReport.warningCount} warnings`,
    stderr: '',
  })

  const hasCommandFailures = commandResults.some(result => result.status === 'failed')
  if (preflight.status === 'passed' && policy && !hasCommandFailures) {
    const stability = await runStabilityTests(
      options.repoRoot,
      options.profile,
      policy,
      commandRunner,
    )
    commandResults.push(...stability.commandResults)
    stabilityRuns = stability.stabilityRuns

    const cliSmoke = await maybeRunRiskSuite(
      options.repoRoot,
      true,
      'smoke:cli',
      'bun run smoke:cli',
      'Required CLI verification.',
      commandRunner,
    )
    riskSuites.push(cliSmoke.suite)
    if (cliSmoke.commandResult) {
      commandResults.push(cliSmoke.commandResult)
    }

    const bundleSmoke = await maybeRunRiskSuite(
      options.repoRoot,
      true,
      'smoke:bundle',
      'bun run smoke:bundle',
      'Required bundle verification.',
      commandRunner,
    )
    riskSuites.push(bundleSmoke.suite)
    if (bundleSmoke.commandResult) {
      commandResults.push(bundleSmoke.commandResult)
    }

    const deterministicSuite = await maybeRunRiskSuite(
      options.repoRoot,
      shouldRunTriggeredSuite(gitContext.changedFiles, policy.criticalGlobs),
      'test:deterministic-harness',
      'bun run test:deterministic-harness',
      'Triggered by critical build-trust files.',
      commandRunner,
    )
    riskSuites.push(deterministicSuite.suite)
    if (deterministicSuite.commandResult) {
      commandResults.push(deterministicSuite.commandResult)
    }

    const autoresearchSuite = await maybeRunRiskSuite(
      options.repoRoot,
      shouldRunTriggeredSuite(gitContext.changedFiles, [
        'services/autoresearch/**',
        '.claude/**',
        'autoresearch.config.json',
        'CLAUDE.md',
      ]),
      'test:autoresearch',
      'bun run test:autoresearch',
      'Triggered by autoresearch or prompt-policy changes.',
      commandRunner,
    )
    riskSuites.push(autoresearchSuite.suite)
    if (autoresearchSuite.commandResult) {
      commandResults.push(autoresearchSuite.commandResult)
    }

    if (policy.profiles[options.profile].runSmokeEmployee) {
      const employeeSmoke = await maybeRunRiskSuite(
        options.repoRoot,
        true,
        'smoke:employee',
        'bun run smoke:employee',
        'Release profile requires employee smoke verification.',
        commandRunner,
      )
      riskSuites.push(employeeSmoke.suite)
      if (employeeSmoke.commandResult) {
        commandResults.push(employeeSmoke.commandResult)
      }
    }

    coverage = await (overrides.buildCoverageReport
      ? overrides.buildCoverageReport(
          options.repoRoot,
          options.profile,
          policy,
          gitContext,
        )
      : buildCoverageReport(options.repoRoot, options.profile, policy, gitContext))

    mutation = await (overrides.runMutationReport
      ? overrides.runMutationReport(
          options.repoRoot,
          options.profile,
          policy,
          gitContext,
          commandRunner,
        )
      : runBuildTrustMutation(
          {
            repoRoot: options.repoRoot,
            profile: options.profile,
            policy,
            changedFiles: gitContext.changedFiles,
            changedLines: gitContext.changedLines,
          },
          commandRunner,
        ))
    if (mutation) {
      commandResults.push({
        label: 'mutation-sensitivity',
        command: mutation.trials[0]?.command ?? (policy.mutationRules?.testCommand ?? 'bun test ./test'),
        status:
          mutation.status === 'passed'
            ? 'passed'
            : mutation.status === 'failed'
              ? 'failed'
              : 'skipped',
        exitCode:
          mutation.status === 'passed'
            ? 0
            : mutation.status === 'failed'
              ? 1
              : null,
        durationMs: 0,
        stdout: mutation.summary,
        stderr: '',
      })
    }
  }

  const report: BuildTrustRunnerReport = {
    repoRoot: options.repoRoot,
    profile: options.profile,
    verdict: determineVerdict({
      preflight,
      commandResults,
      qualityReport,
      coverage,
      mutation,
      stabilityRuns,
    }),
    generatedAt: new Date().toISOString(),
    baseRef: gitContext.baseRef,
    changedFiles: gitContext.changedFiles,
    preflight,
    commandResults,
    qualityReport,
    stabilityRuns,
    coverage,
    mutation,
    mediaArtifacts: [],
    riskSuites,
  }

  mediaArtifacts = await (overrides.generateMediaArtifacts
    ? overrides.generateMediaArtifacts(options.repoRoot, report)
    : generateBuildTrustMediaArtifacts(options.repoRoot, report))
  report.mediaArtifacts = mediaArtifacts

  if (options.htmlPath) {
    const outputPath = path.resolve(options.repoRoot, options.htmlPath)
    await writeFile(outputPath, renderBuildTrustHtml(report), 'utf8')
    await validateReport(outputPath)
  }

  return report
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  const report = await runBuildTrust(options)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(
      `Build trust verdict: ${report.verdict}\nProfile: ${report.profile}\n`,
    )
  }
  process.exit(report.verdict === 'trusted' ? 0 : 1)
}
