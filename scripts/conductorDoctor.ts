#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'

type Remote = {
  name: string
  url: string
  kind: 'fetch' | 'push'
}

export type ConductorDoctorReport = {
  repoPath: string
  gitRepo: boolean
  branch: string | null
  remotes: Remote[]
  conductorReady: boolean
  problems: string[]
  recommendations: string[]
  appliedChange?: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa('git', args, { cwd })
  return stdout.trim()
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

  return {
    repoPath,
    gitRepo: true,
    branch: branch || null,
    remotes,
    conductorReady: problems.length === 0,
    problems,
    recommendations,
  }
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

function parseArgs(argv: string[]): {
  repoPath: string
  remoteUrl?: string
  json: boolean
  htmlPath?: string
} {
  let repoPath = process.cwd()
  let remoteUrl: string | undefined
  let json = false
  let htmlPath: string | undefined

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
    }
  }

  return { repoPath, remoteUrl, json, htmlPath }
}

if (import.meta.main) {
  const { repoPath, remoteUrl, json, htmlPath } = parseArgs(process.argv.slice(2))
  let appliedChange: string | undefined
  if (remoteUrl) {
    appliedChange = await setOrigin(repoPath, remoteUrl)
  }

  const report = await inspectConductorRepo(repoPath)
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
