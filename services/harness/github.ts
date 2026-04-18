import { readFile } from 'node:fs/promises'
import { safeParseJSON } from 'src/utils/json.js'
import { RemoteTriggerEventSchema, type HarnessConfig, type RemoteTriggerEvent } from './types.js'
import type { ShellCommandRunner } from './shell.js'
import { resolveRepoPath } from './utils.js'

export type PullRequestSnapshot = {
  number: number
  title: string
  url: string
  isDraft: boolean
  state?: string
  headSha: string
  headRefName?: string
  baseRefName?: string
  changedFiles?: number
  additions?: number
  deletions?: number
  mergeable?: string
  reviewDecision?: string
  mergedAt?: string
  mergeCommitSha?: string
}

export type PullRequestCheck = {
  name: string
  state: string
  bucket?: string
}

export type DefaultBranchRunSnapshot = {
  databaseId: number
  headSha: string
  status: string
  conclusion: string
  workflowName: string
  url?: string
  displayTitle?: string
}

export type GitHubDiscovery = {
  repoNameWithOwner?: string
  defaultBranch?: string
  pullRequests: PullRequestSnapshot[]
  failingDefaultBranchRun: DefaultBranchRunSnapshot | null
}

async function runGhJson<T>(
  repoRoot: string,
  runner: ShellCommandRunner,
  args: string[],
): Promise<T | null> {
  const result = await runner('gh', args, { cwd: repoRoot })
  if (result.code !== 0) {
    return null
  }
  const parsed = safeParseJSON(result.stdout, false)
  return (parsed as T | null) ?? null
}

export async function pollGitHubDiscovery(
  repoRoot: string,
  config: HarnessConfig,
  runner: ShellCommandRunner,
): Promise<GitHubDiscovery> {
  if (!config.sources.github.enabled) {
    return {
      pullRequests: [],
      failingDefaultBranchRun: null,
    }
  }

  const repoView = await runGhJson<{
    nameWithOwner?: string
    defaultBranchRef?: { name?: string }
  }>(repoRoot, runner, [
    'repo',
    'view',
    '--json',
    'nameWithOwner,defaultBranchRef',
  ])

  const defaultBranch =
    config.sources.github.defaultBranch ??
    repoView?.defaultBranchRef?.name ??
    undefined

  const pullRequests =
    (await runGhJson<
      Array<{
        number: number
        title: string
        url: string
        isDraft?: boolean
        headRefOid?: string
        headRefName?: string
        baseRefName?: string
      }>
    >(repoRoot, runner, [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,url,isDraft,headRefOid,headRefName,baseRefName',
    ])) ?? []

  const runs =
    defaultBranch == null
      ? []
      : ((await runGhJson<
          Array<{
            databaseId: number
            headSha: string
            status: string
            conclusion: string
            workflowName?: string
            url?: string
            displayTitle?: string
          }>
        >(repoRoot, runner, [
          'run',
          'list',
          '--branch',
          defaultBranch,
          '--limit',
          '10',
          '--json',
          'databaseId,headSha,status,conclusion,workflowName,url,displayTitle',
        ])) ?? [])

  const latestDefaultBranchRun = runs[0] ?? null
  const failingDefaultBranchRun =
    latestDefaultBranchRun == null
      ? null
      : (() => {
          const conclusion = (latestDefaultBranchRun.conclusion ?? '').toLowerCase()
          return latestDefaultBranchRun.status === 'completed' &&
              !['success', 'neutral', 'skipped'].includes(conclusion)
            ? latestDefaultBranchRun
            : null
        })()

  return {
    repoNameWithOwner: repoView?.nameWithOwner,
    defaultBranch,
    pullRequests: pullRequests.map(pr => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft ?? false,
      headSha: pr.headRefOid ?? '',
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
    })),
    failingDefaultBranchRun:
      failingDefaultBranchRun == null
        ? null
        : {
            databaseId: failingDefaultBranchRun.databaseId,
            headSha: failingDefaultBranchRun.headSha,
            status: failingDefaultBranchRun.status,
            conclusion: failingDefaultBranchRun.conclusion,
            workflowName:
              failingDefaultBranchRun.workflowName ?? 'unknown workflow',
            url: failingDefaultBranchRun.url,
            displayTitle: failingDefaultBranchRun.displayTitle,
          },
  }
}

export async function loadPullRequestSnapshot(
  repoRoot: string,
  prNumber: number,
  runner: ShellCommandRunner,
): Promise<PullRequestSnapshot | null> {
  const pr = await runGhJson<{
    number: number
    title: string
    url: string
    isDraft?: boolean
    state?: string
    headRefOid?: string
    headRefName?: string
    baseRefName?: string
    changedFiles?: number
    additions?: number
    deletions?: number
    mergeable?: string
    reviewDecision?: string
    mergedAt?: string
    mergeCommit?: { oid?: string }
  }>(repoRoot, runner, [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'number,title,url,isDraft,state,headRefOid,headRefName,baseRefName,changedFiles,additions,deletions,mergeable,reviewDecision,mergedAt,mergeCommit',
  ])

  if (!pr) {
    return null
  }

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft ?? false,
    state: pr.state,
    headSha: pr.headRefOid ?? '',
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    changedFiles: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    mergedAt: pr.mergedAt,
    mergeCommitSha: pr.mergeCommit?.oid,
  }
}

export async function loadPullRequestChecks(
  repoRoot: string,
  prNumber: number,
  runner: ShellCommandRunner,
): Promise<PullRequestCheck[]> {
  const checks = await runGhJson<
    Array<{ name?: string; state?: string; bucket?: string }>
  >(repoRoot, runner, [
    'pr',
    'checks',
    String(prNumber),
    '--json',
    'name,state,bucket',
  ])

  return (checks ?? []).map(check => ({
    name: check.name ?? 'unknown check',
    state: check.state ?? 'unknown',
    bucket: check.bucket,
  }))
}

export async function loadPullRequestFiles(
  repoRoot: string,
  prNumber: number,
  runner: ShellCommandRunner,
): Promise<string[]> {
  const result = await runner(
    'gh',
    ['pr', 'diff', String(prNumber), '--name-only'],
    { cwd: repoRoot },
  )
  if (result.code !== 0) {
    return []
  }
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

export async function loadPullRequestDiff(
  repoRoot: string,
  prNumber: number,
  runner: ShellCommandRunner,
): Promise<string> {
  const result = await runner('gh', ['pr', 'diff', String(prNumber)], {
    cwd: repoRoot,
  })
  return result.code === 0 ? result.stdout : ''
}

export async function tryAutoMergePullRequest(
  repoRoot: string,
  prNumber: number,
  runner: ShellCommandRunner,
): Promise<{ ok: boolean; summary: string }> {
  const result = await runner(
    'gh',
    ['pr', 'merge', String(prNumber), '--auto', '--squash', '--delete-branch'],
    { cwd: repoRoot },
  )
  if (result.code === 0) {
    return {
      ok: true,
      summary: result.stdout.trim() || `auto-merge requested for PR #${prNumber}`,
    }
  }

  const error = result.stderr.trim() || result.error || result.stdout.trim()
  return {
    ok: false,
    summary: error || `auto-merge failed for PR #${prNumber}`,
  }
}

export async function readRemoteTriggerEvents(
  repoRoot: string,
  config: HarnessConfig,
): Promise<RemoteTriggerEvent[]> {
  const inboxPath = resolveRepoPath(repoRoot, config.sources.remoteTriggers.inboxPath)
  try {
    const raw = await readFile(inboxPath, 'utf-8')
    const parsed = safeParseJSON(raw, false)
    const values = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { events?: unknown[] }).events)
        ? (parsed as { events: unknown[] }).events
        : []
    return values
      .map(value => {
        try {
          return RemoteTriggerEventSchema().parse(value)
        } catch {
          return null
        }
      })
      .filter((value): value is RemoteTriggerEvent => value != null)
  } catch {
    return []
  }
}
