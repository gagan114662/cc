#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'

type Remote = {
  name: string
  url: string
  kind: 'fetch' | 'push'
}

// Optional git-hygiene checks beyond the baseline origin-remote check.
// Kept opt-in so existing `bun run conductor:doctor` output stays stable
// for callers that only want the origin/conductor readiness verdict.
export type HygieneCheckName = 'dirty-tree' | 'stale-branch' | 'pre-merge-gate'

export type HygieneOptions = {
  checks?: HygieneCheckName[]
  // Stale-branch threshold in days — anything older flags. Default 30.
  maxBranchAgeDays?: number
  // Base branch used by the pre-merge-gate check. Default 'main'.
  baseBranch?: string
}

export type GitRunner = (args: string[], cwd: string) => Promise<string>

export type ConductorDoctorReport = {
  repoPath: string
  gitRepo: boolean
  branch: string | null
  remotes: Remote[]
  conductorReady: boolean
  problems: string[]
  recommendations: string[]
  hygiene?: {
    checksRun: HygieneCheckName[]
    dirtyTree?: { clean: boolean; files: string[] }
    staleBranch?: { stale: boolean; ageDays: number; threshold: number }
    preMergeGate?: { mergedFromBase: boolean; baseBranch: string }
  }
  appliedChange?: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const defaultGit: GitRunner = async (args, cwd) => {
  const { stdout } = await execa('git', args, { cwd })
  return stdout.trim()
}

// Kept as a thin wrapper so existing internal call sites keep working.
async function git(args: string[], cwd: string): Promise<string> {
  return defaultGit(args, cwd)
}

export async function checkDirtyTree(
  repoPath: string,
  runner: GitRunner = defaultGit,
): Promise<{ clean: boolean; files: string[] }> {
  const out = await runner(['status', '--porcelain'], repoPath)
  const files = out
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  return { clean: files.length === 0, files }
}

export async function checkStaleBranch(
  repoPath: string,
  maxBranchAgeDays: number,
  runner: GitRunner = defaultGit,
  now: Date = new Date(),
): Promise<{ stale: boolean; ageDays: number; threshold: number }> {
  const tipTimestamp = await runner(['log', '-1', '--format=%ct', 'HEAD'], repoPath)
  const tipSeconds = Number(tipTimestamp)
  if (!tipTimestamp || !Number.isFinite(tipSeconds) || tipSeconds <= 0) {
    return { stale: false, ageDays: 0, threshold: maxBranchAgeDays }
  }
  const ageMs = now.getTime() - tipSeconds * 1000
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))
  return { stale: ageDays > maxBranchAgeDays, ageDays, threshold: maxBranchAgeDays }
}

export async function checkPreMergeGate(
  repoPath: string,
  baseBranch: string,
  runner: GitRunner = defaultGit,
): Promise<{ mergedFromBase: boolean; baseBranch: string }> {
  // `git merge-base --is-ancestor <base> HEAD` exits 0 when <base> is
  // reachable from HEAD — i.e. base is already merged in. Exit 1 means
  // base has commits not yet merged into the current branch.
  try {
    await runner(
      ['merge-base', '--is-ancestor', `origin/${baseBranch}`, 'HEAD'],
      repoPath,
    )
    return { mergedFromBase: true, baseBranch }
  } catch {
    return { mergedFromBase: false, baseBranch }
  }
}

function parseRemotes(stdout: string): Remote[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
      if (!match) return null
      return {
        name: match[1]!,
        url: match[2]!,
        kind: match[3]! as 'fetch' | 'push',
      }
    })
    .filter((remote): remote is Remote => Boolean(remote))
}

export async function inspectConductorRepo(
  repoPath: string,
  hygiene: HygieneOptions = {},
): Promise<ConductorDoctorReport> {
  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree'], repoPath)
    if (inside !== 'true') {
      return {
        repoPath,
        gitRepo: false,
        branch: null,
        remotes: [],
        conductorReady: false,
        problems: ['not_a_git_repo'],
        recommendations: ['Initialize git and publish the repo to GitHub before adding it to Conductor.'],
      }
    }
  } catch {
    return {
      repoPath,
      gitRepo: false,
      branch: null,
      remotes: [],
      conductorReady: false,
      problems: ['not_a_git_repo'],
      recommendations: ['Initialize git and publish the repo to GitHub before adding it to Conductor.'],
    }
  }

  const [branch, remoteStdout] = await Promise.all([
    git(['branch', '--show-current'], repoPath).catch(() => ''),
    git(['remote', '-v'], repoPath).catch(() => ''),
  ])

  const remotes = parseRemotes(remoteStdout)
  const fetchOrigin = remotes.find(
    remote => remote.name === 'origin' && remote.kind === 'fetch',
  )

  const problems: string[] = []
  const recommendations: string[] = []

  if (!fetchOrigin) {
    problems.push('missing_origin_remote')
    recommendations.push(
      'Add a real GitHub remote before opening this repo in Conductor: git remote add origin <github-url>',
    )
  } else if (fetchOrigin.url === '.' || fetchOrigin.url.startsWith('file://')) {
    problems.push('origin_is_local_only')
    recommendations.push(
      'Replace the local-only origin with a GitHub URL so Conductor can sync workspaces: git remote set-url origin <github-url>',
    )
  }

  const gbLocal = remotes.find(
    remote =>
      remote.name === 'gb-local' &&
      remote.kind === 'fetch' &&
      remote.url === '.',
  )
  if (gbLocal && !fetchOrigin) {
    problems.push('gitbutler_local_remote_only')
    recommendations.push(
      'This repo currently uses GitButler local syncing only (`gb-local -> .`). Conductor still needs a GitHub-backed `origin` remote.',
    )
  }

  const hygieneReport = await runHygieneChecks(repoPath, hygiene, problems, recommendations)

  return {
    repoPath,
    gitRepo: true,
    branch: branch || null,
    remotes,
    conductorReady: problems.length === 0,
    problems,
    recommendations,
    hygiene: hygieneReport,
  }
}

async function runHygieneChecks(
  repoPath: string,
  opts: HygieneOptions,
  problems: string[],
  recommendations: string[],
): Promise<ConductorDoctorReport['hygiene']> {
  const checks = opts.checks ?? []
  if (checks.length === 0) return undefined

  const report: NonNullable<ConductorDoctorReport['hygiene']> = {
    checksRun: [...checks],
  }

  if (checks.includes('dirty-tree')) {
    const result = await checkDirtyTree(repoPath).catch(() => ({
      clean: true,
      files: [],
    }))
    report.dirtyTree = result
    if (!result.clean) {
      problems.push('dirty_tree')
      recommendations.push(
        `Commit or stash ${result.files.length} uncommitted change(s) before handing off to Conductor: git status`,
      )
    }
  }

  if (checks.includes('stale-branch')) {
    const threshold = opts.maxBranchAgeDays ?? 30
    const result = await checkStaleBranch(repoPath, threshold).catch(() => ({
      stale: false,
      ageDays: 0,
      threshold,
    }))
    report.staleBranch = result
    if (result.stale) {
      problems.push('stale_branch')
      recommendations.push(
        `Current branch tip is ${result.ageDays} days old (threshold ${threshold}). Rebase onto main or retire the branch.`,
      )
    }
  }

  if (checks.includes('pre-merge-gate')) {
    const baseBranch = opts.baseBranch ?? 'main'
    const result = await checkPreMergeGate(repoPath, baseBranch).catch(() => ({
      mergedFromBase: true,
      baseBranch,
    }))
    report.preMergeGate = result
    if (!result.mergedFromBase) {
      problems.push('base_not_merged')
      recommendations.push(
        `origin/${baseBranch} has commits not in the current branch. Merge or rebase before landing: git merge origin/${baseBranch}`,
      )
    }
  }

  return report
}

async function setOrigin(repoPath: string, remoteUrl: string): Promise<string> {
  const remotes = parseRemotes(await git(['remote', '-v'], repoPath).catch(() => ''))
  const hasOrigin = remotes.some(remote => remote.name === 'origin')
  if (hasOrigin) {
    await git(['remote', 'set-url', 'origin', remoteUrl], repoPath)
    return `Updated origin to ${remoteUrl}`
  }
  await git(['remote', 'add', 'origin', remoteUrl], repoPath)
  return `Added origin ${remoteUrl}`
}

function renderHtml(report: ConductorDoctorReport): string {
  const generatedAt = new Date().toISOString()
  const remoteMarkup =
    report.remotes.length === 0
      ? '<p>No git remotes detected.</p>'
      : `<ul>${report.remotes
          .map(
            remote =>
              `<li><strong>${escapeHtml(remote.name)}</strong> ${escapeHtml(
                remote.kind,
              )} ${escapeHtml(remote.url)}</li>`,
          )
          .join('')}</ul>`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Conductor Readiness Proof</title>
    <style>
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
        background: linear-gradient(180deg, #f5f3ff, #fff);
        color: #171717;
      }
      main {
        max-width: 920px;
        margin: 0 auto;
        padding: 48px 20px 80px;
      }
      section {
        background: #fff;
        border: 1px solid #ddd6fe;
        border-radius: 18px;
        padding: 20px 24px;
        box-shadow: 0 18px 40px rgba(76, 29, 149, 0.08);
        margin-top: 18px;
      }
      .ready {
        color: #166534;
      }
      .blocked {
        color: #991b1b;
      }
      code {
        background: #f5f3ff;
        border-radius: 8px;
        padding: 2px 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <section id="overview">
        <p>Generated ${escapeHtml(generatedAt)}</p>
        <h1>Conductor Readiness Proof</h1>
        <p class="${report.conductorReady ? 'ready' : 'blocked'}">
          ${report.conductorReady ? 'Ready for Conductor.' : 'Blocked for Conductor.'}
        </p>
        <p>Repo: <code>${escapeHtml(report.repoPath)}</code></p>
        <p>Branch: <code>${escapeHtml(report.branch ?? '(detached)')}</code></p>
      </section>
      <section>
        <h2>Remotes</h2>
        ${remoteMarkup}
      </section>
      <section>
        <h2>Problems</h2>
        ${
          report.problems.length === 0
            ? '<p>No blocking problems detected.</p>'
            : `<ul>${report.problems
                .map(problem => `<li>${escapeHtml(problem)}</li>`)
                .join('')}</ul>`
        }
      </section>
      <section>
        <h2>Recommendations</h2>
        ${
          report.recommendations.length === 0
            ? '<p>No follow-up needed.</p>'
            : `<ul>${report.recommendations
                .map(recommendation => `<li>${escapeHtml(recommendation)}</li>`)
                .join('')}</ul>`
        }
      </section>
    </main>
  </body>
</html>`
}

const ALL_HYGIENE_CHECKS: HygieneCheckName[] = [
  'dirty-tree',
  'stale-branch',
  'pre-merge-gate',
]

function isHygieneCheckName(value: string): value is HygieneCheckName {
  return (ALL_HYGIENE_CHECKS as string[]).includes(value)
}

function parseArgs(argv: string[]): {
  repoPath: string
  remoteUrl?: string
  json: boolean
  htmlPath?: string
  hygiene: HygieneOptions
} {
  let repoPath = process.cwd()
  let remoteUrl: string | undefined
  let json = false
  let htmlPath: string | undefined
  const checks: HygieneCheckName[] = []
  let maxBranchAgeDays: number | undefined
  let baseBranch: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') {
      repoPath = path.resolve(argv[index + 1] ?? repoPath)
      index += 1
      continue
    }
    if (arg === '--set-origin') {
      remoteUrl = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--html') {
      htmlPath = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--check') {
      const value = argv[index + 1]
      index += 1
      if (!value) continue
      if (value === 'all') {
        for (const c of ALL_HYGIENE_CHECKS) {
          if (!checks.includes(c)) checks.push(c)
        }
        continue
      }
      if (isHygieneCheckName(value) && !checks.includes(value)) {
        checks.push(value)
      }
      continue
    }
    if (arg === '--max-branch-age-days') {
      const value = Number(argv[index + 1])
      if (Number.isFinite(value) && value >= 0) {
        maxBranchAgeDays = value
      }
      index += 1
      continue
    }
    if (arg === '--base-branch') {
      baseBranch = argv[index + 1]
      index += 1
      continue
    }
  }

  return {
    repoPath,
    remoteUrl,
    json,
    htmlPath,
    hygiene: { checks, maxBranchAgeDays, baseBranch },
  }
}

if (import.meta.main) {
  const { repoPath, remoteUrl, json, htmlPath, hygiene } = parseArgs(
    process.argv.slice(2),
  )
  let appliedChange: string | undefined
  if (remoteUrl) {
    appliedChange = await setOrigin(repoPath, remoteUrl)
  }

  const report = await inspectConductorRepo(repoPath, hygiene)
  report.appliedChange = appliedChange

  if (htmlPath) {
    await writeFile(path.resolve(repoPath, htmlPath), renderHtml(report), 'utf8')
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(
      `${report.conductorReady ? 'Conductor ready.' : 'Conductor blocked.'}\n`,
    )
    if (appliedChange) {
      process.stdout.write(`${appliedChange}\n`)
    }
    for (const problem of report.problems) {
      process.stdout.write(`- ${problem}\n`)
    }
    for (const recommendation of report.recommendations) {
      process.stdout.write(`- ${recommendation}\n`)
    }
  }

  process.exit(report.conductorReady ? 0 : 1)
}
