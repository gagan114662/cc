#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ansiToPng } from 'src/utils/ansiToPng.js'
import type { BuildTrustRunnerReport } from './buildTrustReport.js'

export type BuildTrustMediaArtifact = {
  label: string
  kind: 'screenshot' | 'replay'
  filePath: string
  mediaType: 'image/png' | 'application/asciicast'
  description: string
}

const MAX_COMMANDS = 12
const MAX_FINDINGS = 8
const MAX_CHANGED_FILES = 10

function colorize(status: string, text: string): string {
  if (status === 'passed' || status === 'trusted') {
    return `\x1b[32m${text}\x1b[0m`
  }
  if (status === 'failed' || status.startsWith('blocked')) {
    return `\x1b[31m${text}\x1b[0m`
  }
  return `\x1b[33m${text}\x1b[0m`
}

function formatOverview(report: BuildTrustRunnerReport): string {
  const changedFiles = report.changedFiles.slice(0, MAX_CHANGED_FILES)
  const lines = [
    'Build Trust Overview',
    '',
    `Profile: ${report.profile}`,
    `Verdict: ${colorize(report.verdict, report.verdict)}`,
    `Generated: ${report.generatedAt}`,
    `Changed files: ${report.changedFiles.length}`,
    `Quality findings: ${report.qualityReport.findings.length}`,
    `Mutation survivors: ${report.mutation?.survivingTrialCount ?? 0}`,
    `Coverage: ${report.coverage ? `${report.coverage.changedLineCoveragePct.toFixed(2)}%` : 'n/a'}`,
    '',
    'Changed files:',
    ...changedFiles.map(filePath => `  - ${filePath}`),
  ]

  if (report.changedFiles.length > changedFiles.length) {
    lines.push(`  ... ${report.changedFiles.length - changedFiles.length} more`)
  }

  return lines.join('\n')
}

function formatVerification(report: BuildTrustRunnerReport): string {
  const lines = [
    'Verification Status',
    '',
    ...report.commandResults.slice(0, MAX_COMMANDS).map(result =>
      `${colorize(result.status, result.status.toUpperCase())} ${result.label} (${result.exitCode ?? 'n/a'}) ${result.durationMs}ms`,
    ),
    '',
    'Stability:',
    ...(report.stabilityRuns.length > 0
      ? report.stabilityRuns.map(run =>
          `${colorize(run.status, run.status.toUpperCase())} seed ${run.seed}${run.failingTests.length > 0 ? ` -> ${run.failingTests.join(', ')}` : ''}`,
        )
      : ['  (none)']),
    '',
    'Risk suites:',
    ...(report.riskSuites.length > 0
      ? report.riskSuites.map(suite =>
          `${colorize(suite.status, suite.status.toUpperCase())} ${suite.label} — ${suite.reason}`,
        )
      : ['  (none)']),
  ]

  return lines.join('\n')
}

function formatEvidence(report: BuildTrustRunnerReport): string {
  const findings = report.qualityReport.findings.slice(0, MAX_FINDINGS)
  const mutationTrials = report.mutation?.trials.slice(0, MAX_FINDINGS) ?? []
  const coverageRanges = report.coverage?.uncoveredRanges.slice(0, MAX_FINDINGS) ?? []

  const lines = [
    'Evidence Review',
    '',
    'Test-quality findings:',
    ...(findings.length > 0
      ? findings.map(
          finding =>
            `${colorize(finding.severity, finding.severity.toUpperCase())} ${finding.ruleId} ${finding.filePath}:${finding.line}`,
        )
      : ['  none']),
    '',
    'Mutation trials:',
    ...(mutationTrials.length > 0
      ? mutationTrials.map(
          trial =>
            `${colorize(trial.status, trial.status.toUpperCase())} ${trial.filePath}:${trial.line} ${trial.description}`,
        )
      : ['  none']),
    '',
    'Coverage gaps:',
    ...(coverageRanges.length > 0
      ? coverageRanges.map(
          range =>
            `${range.filePath} ${range.ranges.join(', ')}${range.critical ? ' (critical)' : ''}`,
        )
      : ['  none']),
  ]

  return lines.join('\n')
}

function buildAsciicast(report: BuildTrustRunnerReport): string {
  const now = Math.floor(Date.now() / 1000)
  const header = JSON.stringify({
    version: 2,
    width: 120,
    height: 36,
    timestamp: now,
    env: {
      SHELL: 'build-trust',
      TERM: 'xterm-256color',
    },
  })

  const events = [
    [0.0, 'o', `${formatOverview(report)}\n\n`],
    [0.7, 'o', `${formatVerification(report)}\n\n`],
    [1.4, 'o', `${formatEvidence(report)}\n`],
  ].map(event => JSON.stringify(event))

  return `${header}\n${events.join('\n')}\n`
}

async function writePng(filePath: string, text: string): Promise<void> {
  const png = ansiToPng(text, {
    scale: 1,
    paddingX: 32,
    paddingY: 32,
    borderRadius: 18,
  })
  await writeFile(filePath, png)
}

export async function generateBuildTrustMediaArtifacts(
  repoRoot: string,
  report: BuildTrustRunnerReport,
): Promise<BuildTrustMediaArtifact[]> {
  const artifactDir = path.join(repoRoot, 'build-trust-artifacts')
  await mkdir(artifactDir, { recursive: true })

  const prefix = `build-trust-${report.profile}`
  const overviewPath = path.join(artifactDir, `${prefix}-overview.png`)
  const verificationPath = path.join(artifactDir, `${prefix}-verification.png`)
  const evidencePath = path.join(artifactDir, `${prefix}-evidence.png`)
  const replayPath = path.join(artifactDir, `${prefix}-replay.cast`)

  await Promise.all([
    writePng(overviewPath, formatOverview(report)),
    writePng(verificationPath, formatVerification(report)),
    writePng(evidencePath, formatEvidence(report)),
    writeFile(replayPath, buildAsciicast(report), 'utf8'),
  ])

  return [
    {
      label: 'Overview screenshot',
      kind: 'screenshot',
      filePath: path.relative(repoRoot, overviewPath),
      mediaType: 'image/png',
      description: 'Compact PNG summary of the verdict, changed files, and top-line trust signals.',
    },
    {
      label: 'Verification screenshot',
      kind: 'screenshot',
      filePath: path.relative(repoRoot, verificationPath),
      mediaType: 'image/png',
      description: 'Compact PNG view of command results, stability runs, and risk-triggered suites.',
    },
    {
      label: 'Evidence screenshot',
      kind: 'screenshot',
      filePath: path.relative(repoRoot, evidencePath),
      mediaType: 'image/png',
      description: 'Compact PNG view of quality findings, mutation trials, and coverage gaps.',
    },
    {
      label: 'Terminal replay',
      kind: 'replay',
      filePath: path.relative(repoRoot, replayPath),
      mediaType: 'application/asciicast',
      description: 'Asciicast replay of the trust summary and verification evidence.',
    },
  ]
}
