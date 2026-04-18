import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeHarnessConfig, getDefaultHarnessConfig } from 'src/services/harness/config.js'
import {
  annotateHarnessIncident,
  getHarnessPullRequestQuality,
  getHarnessQualityStatus,
} from 'src/services/harness/runtime.js'

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-quality-'))
  await mkdir(path.join(repoRoot, '.claude'), { recursive: true })
  return repoRoot
}

async function installFakeGh(binDir: string): Promise<void> {
  const ghPath = path.join(binDir, 'gh')
  await Bun.write(
    ghPath,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const key = args.join(' ')
const write = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
if (key === 'repo view --json nameWithOwner,defaultBranchRef') {
  write({ nameWithOwner: 'owner/repo', defaultBranchRef: { name: 'main' } })
} else if (key === 'pr list --state open --json number,title,url,isDraft,headRefOid,headRefName,baseRefName') {
  write([
    {
      number: 12,
      title: 'Improve quality ledger',
      url: 'https://example.com/pr/12',
      isDraft: false,
      headRefOid: 'abc123def456',
      headRefName: 'feature/harness',
      baseRefName: 'main',
    },
  ])
} else if (key === 'run list --branch main --limit 10 --json databaseId,headSha,status,conclusion,workflowName,url,displayTitle') {
  write([])
} else if (key === 'pr view 12 --json number,title,url,isDraft,state,headRefOid,headRefName,baseRefName,changedFiles,additions,deletions,mergeable,reviewDecision,mergedAt,mergeCommit') {
  write({
    number: 12,
    title: 'Improve quality ledger',
    url: 'https://example.com/pr/12',
    isDraft: false,
    state: 'MERGED',
    headRefOid: 'abc123def456',
    headRefName: 'feature/harness',
    baseRefName: 'main',
    changedFiles: 2,
    additions: 100,
    deletions: 20,
    mergeable: 'MERGEABLE',
    reviewDecision: 'CHANGES_REQUESTED',
    mergedAt: '2026-04-18T09:45:00.000Z',
    mergeCommit: { oid: 'merge789abc' },
  })
} else if (key === 'pr checks 12 --json name,state,bucket') {
  write([{ name: 'ci', state: 'FAILURE', bucket: 'fail' }])
} else if (key === 'pr diff 12 --name-only') {
  write('src/index.ts\\ntest/index.test.ts\\n')
} else if (key === 'pr diff 12') {
  write('diff --git a/src/index.ts b/src/index.ts')
} else if (key === 'run list --branch main --limit 1 --json headSha,status,conclusion') {
  write([{ headSha: 'merge789abc', status: 'completed', conclusion: 'success' }])
} else if (key === 'pr merge 12 --auto --squash --delete-branch') {
  write('merge queued')
} else {
  process.stderr.write('unexpected gh args: ' + key)
  process.exit(1)
}
`,
  )
  await chmod(ghPath, 0o755)
}

describe('harness quality ledger', () => {
  const originalPath = process.env.PATH
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalGstackHome = process.env.GSTACK_HOME
  let repoRoot = ''
  let binDir = ''
  let gstackHome = ''
  let claudeConfigDir = ''

  beforeEach(async () => {
    repoRoot = await createTempRepo()
    binDir = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-gh-bin-'))
    gstackHome = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-gstack-'))
    claudeConfigDir = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-home-'))
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
    process.env.GSTACK_HOME = gstackHome
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
    await installFakeGh(binDir)
    await writeHarnessConfig(getDefaultHarnessConfig(), repoRoot)

    await mkdir(path.join(repoRoot, '.gstack', 'qa-reports'), { recursive: true })
    await mkdir(path.join(repoRoot, '.gstack', 'deploy-reports'), {
      recursive: true,
    })

    await Bun.write(
      path.join(repoRoot, '.gstack', 'qa-reports', 'baseline.json'),
      JSON.stringify({
        date: '2026-04-18',
        url: 'https://example.com',
        healthScore: 78,
        issues: [
          {
            id: 'ISSUE-001',
            title: 'Save button is disabled',
            severity: 'high',
            category: 'functional',
          },
          {
            id: 'ISSUE-002',
            title: 'Spacing is cramped',
            severity: 'low',
            category: 'visual',
          },
        ],
      }),
    )
    await Bun.write(
      path.join(repoRoot, '.gstack', 'qa-reports', 'qa-report-example-2026-04-18.md'),
      `# QA Report: Example

| Field | Value |
|-------|-------|
| **Date** | 2026-04-18 |
| **URL** | https://example.com |
| **Branch** | feature/harness |
| **PR** | 12 (https://example.com/pr/12) |
`,
    )
    await Bun.write(
      path.join(repoRoot, '.gstack', 'deploy-reports', '2026-04-18-pr12-deploy.md'),
      `LAND & DEPLOY REPORT
═════════════════════
PR:           #12 — Improve quality ledger
Branch:       feature/harness → main
Merged:       2026-04-18T09:45:00.000Z (squash)
Merge SHA:    merge789abc
Verification: DEGRADED
VERDICT: DEPLOYED (UNVERIFIED)
`,
    )

    const projectDir = path.join(gstackHome, 'projects', 'owner-repo')
    await mkdir(projectDir, { recursive: true })
    await Bun.write(
      path.join(projectDir, 'feature-harness-reviews.jsonl'),
      [
        JSON.stringify({
          skill: 'review',
          timestamp: '2026-04-18T09:20:00.000Z',
          status: 'issues_found',
          issues_found: 3,
          critical: 1,
          informational: 2,
          commit: 'abc123',
        }),
        JSON.stringify({
          skill: 'ship',
          timestamp: '2026-04-18T09:30:00.000Z',
          coverage_pct: 82,
          plan_items_total: 4,
          plan_items_done: 3,
          verification_result: 'pass',
          version: '0.1.0',
          branch: 'feature-harness',
        }),
      ].join('\n'),
    )
  })

  afterEach(() => {
    process.env.PATH = originalPath
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    process.env.GSTACK_HOME = originalGstackHome
  })

  test('aggregates GitHub and gstack quality signals per PR and per repo', async () => {
    const status = await getHarnessQualityStatus(repoRoot)
    const snapshot7d = status.quality.snapshots.find(snapshot => snapshot.windowDays === 7)
    const pr = await getHarnessPullRequestQuality(repoRoot, 12)

    expect(snapshot7d?.deployedPrCount).toBe(1)
    expect(snapshot7d?.postMergeIncidentCount).toBe(1)
    expect(snapshot7d?.changeFailureRate).toBe(1)
    expect(status.quality.openIncidentCount).toBe(1)
    expect(pr.quality?.metrics.preMergeFindingCount).toBeGreaterThanOrEqual(4)
    expect(pr.quality?.metrics.postMergeIncidentCount).toBe(1)
    expect(pr.quality?.logicalChangeSize?.weightedSize).toBeGreaterThan(0)
  })

  test('manual incident annotations appear in the hosted quality ledger', async () => {
    const annotated = await annotateHarnessIncident(repoRoot, {
      prNumber: 12,
      summary: 'Customer reported a production outage after merge.',
      severity: 'critical',
    })
    const pr = await getHarnessPullRequestQuality(repoRoot, 12)

    expect(annotated.incident.manual).toBe(true)
    expect(
      pr.quality?.incidents.some(incident => incident.manual && incident.summary.includes('Customer reported')),
    ).toBe(true)
  })
})
