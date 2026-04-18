import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { safeParseJSON } from 'src/utils/json.js'
import type { PullRequestCheck, PullRequestSnapshot } from './github.js'
import {
  loadPullRequestChecks,
  loadPullRequestFiles,
  loadPullRequestSnapshot,
} from './github.js'
import type { ShellCommandRunner } from './shell.js'
import type {
  DefectFinding,
  DeploymentVerification,
  HarnessQualitySeverity,
  HarnessRuntimeState,
  JobOutcome,
  PostMergeIncident,
  PullRequestQualityRecord,
  RecoveryEvent,
  RevertLink,
  RepoQualitySnapshot,
} from './types.js'
import { createStableId } from './utils.js'

type QualitySnapshotWindow = 7 | 30

type GstackRetroSummary = {
  recordedAt?: string
  window?: string
  summary?: string
  testHealth?: unknown
}

export type PullRequestQualityView = {
  record: PullRequestQualityRecord
  logicalChangeSize: HarnessRuntimeState['quality']['logicalChangeSizes'][string] | null
  findings: DefectFinding[]
  deployments: DeploymentVerification[]
  incidents: PostMergeIncident[]
  recoveries: RecoveryEvent[]
  reverts: RevertLink[]
  metrics: {
    preMergeFindingCount: number
    postMergeIncidentCount: number
    revertCount: number
    changeFailure: boolean
    meanTimeToDetectMs: number
    meanTimeToRecoverMs: number
    preMergeDefectDensity: number
    escapedDefectDensity: number
  }
}

const SEVERITY_WEIGHTS: Record<HarnessQualitySeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

function toTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function sanitizeBranchName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  return value.replaceAll('/', '-').replace(/[^a-zA-Z0-9._-]/g, '')
}

function uniquePush(values: string[], value: string | undefined): void {
  if (!value || values.includes(value)) {
    return
  }
  values.push(value)
}

function createPullRequestQualityId(repoId: string, prNumber: number): string {
  return `${repoId}:pr:${prNumber}`
}

function createSnapshotId(repoId: string, windowDays: QualitySnapshotWindow): string {
  return `${repoId}:snapshot:${windowDays}`
}

function ensurePullRequestRecord(
  state: HarnessRuntimeState,
  repoId: string,
  prNumber: number,
  now: string,
): PullRequestQualityRecord {
  const id = createPullRequestQualityId(repoId, prNumber)
  const existing = state.quality.pullRequests[id]
  if (existing) {
    return existing
  }
  const record: PullRequestQualityRecord = {
    id,
    repoId,
    prNumber,
    title: '',
    state: 'unknown',
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    findingIds: [],
    deploymentIds: [],
    incidentIds: [],
    recoveryIds: [],
    revertIds: [],
    createdAt: now,
    updatedAt: now,
    metadata: {},
  }
  state.quality.pullRequests[id] = record
  return record
}

function severityWeight(severity: HarnessQualitySeverity, count: number = 1): number {
  return SEVERITY_WEIGHTS[severity] * count
}

function normalizeDeploymentStatus(
  value: string | undefined,
): DeploymentVerification['status'] {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'healthy':
    case 'passed':
      return 'healthy'
    case 'degraded':
      return 'degraded'
    case 'broken':
      return 'broken'
    case 'failed':
      return 'failed'
    case 'reverted':
      return 'reverted'
    default:
      return 'skipped'
  }
}

function inferIncidentSeverityFromStatus(
  value: DeploymentVerification['status'],
): HarnessQualitySeverity {
  switch (value) {
    case 'degraded':
      return 'high'
    case 'failed':
    case 'broken':
    case 'reverted':
      return 'critical'
    default:
      return 'medium'
  }
}

function classifyFileWeight(filePath: string): {
  weight: number
  included: boolean
  category: string
} {
  const normalized = filePath.toLowerCase()
  const baseName = path.basename(normalized)
  if (
    normalized.includes('/vendor/') ||
    normalized.includes('/dist/') ||
    normalized.includes('/build/') ||
    normalized.includes('/coverage/') ||
    normalized.includes('/node_modules/') ||
    normalized.endsWith('.lock') ||
    normalized.endsWith('package-lock.json') ||
    normalized.endsWith('bun.lock') ||
    normalized.endsWith('pnpm-lock.yaml') ||
    normalized.endsWith('.png') ||
    normalized.endsWith('.jpg') ||
    normalized.endsWith('.jpeg') ||
    normalized.endsWith('.gif') ||
    normalized.endsWith('.pdf') ||
    normalized.endsWith('.svg')
  ) {
    return { weight: 0, included: false, category: 'excluded' }
  }
  if (
    normalized.startsWith('docs/') ||
    normalized.includes('/docs/') ||
    normalized.endsWith('.md') ||
    normalized.endsWith('.mdx')
  ) {
    return { weight: 0.1, included: true, category: 'docs' }
  }
  if (
    normalized.includes('__tests__') ||
    normalized.includes('/test/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/e2e/') ||
    baseName.includes('.test.') ||
    baseName.includes('.spec.')
  ) {
    return { weight: 0.25, included: true, category: 'tests' }
  }
  if (
    normalized.endsWith('.json') ||
    normalized.endsWith('.yaml') ||
    normalized.endsWith('.yml') ||
    normalized.endsWith('.toml') ||
    normalized.endsWith('.ini') ||
    normalized.endsWith('.env') ||
    normalized.includes('/.github/')
  ) {
    return { weight: 0.5, included: true, category: 'config' }
  }
  return { weight: 1, included: true, category: 'runtime' }
}

export function computeLogicalChangeSize(input: {
  repoId: string
  prNumber: number
  additions?: number
  deletions?: number
  changedFiles?: number
  files?: string[]
  computedAt?: string
}): HarnessRuntimeState['quality']['logicalChangeSizes'][string] {
  const additions = Math.max(0, input.additions ?? 0)
  const deletions = Math.max(0, input.deletions ?? 0)
  const files = input.files ?? []
  let includedFiles = 0
  let excludedFiles = 0
  let weightTotal = 0
  const categoryWeights: Record<string, number> = {}

  for (const file of files) {
    const classification = classifyFileWeight(file)
    categoryWeights[classification.category] =
      (categoryWeights[classification.category] ?? 0) + 1
    if (!classification.included) {
      excludedFiles += 1
      continue
    }
    includedFiles += 1
    weightTotal += classification.weight
  }

  const changedFiles =
    Math.max(input.changedFiles ?? 0, files.length, includedFiles + excludedFiles)
  const includedOrFallback = includedFiles || Math.max(1, changedFiles - excludedFiles)
  const averageWeight =
    includedFiles > 0
      ? weightTotal / includedFiles
      : changedFiles > 0
        ? 1
        : 0
  const rawChurn = additions + deletions
  const weightedSize =
    includedOrFallback > 0
      ? Number(((rawChurn > 0 ? rawChurn : includedOrFallback) * averageWeight).toFixed(2))
      : 0

  return {
    id: createStableId(input.repoId, input.prNumber, weightedSize, additions, deletions),
    repoId: input.repoId,
    prNumber: input.prNumber,
    additions,
    deletions,
    changedFiles,
    includedFiles,
    excludedFiles,
    weightedSize,
    categoryWeights,
    computedAt: input.computedAt ?? nowIso(),
  }
}

export function upsertPullRequestQualityRecord(
  state: HarnessRuntimeState,
  repoId: string,
  snapshot: PullRequestSnapshot,
  files: string[],
  now: Date,
): PullRequestQualityRecord {
  const record = ensurePullRequestRecord(state, repoId, snapshot.number, nowIso(now))
  const logicalChangeSize = computeLogicalChangeSize({
    repoId,
    prNumber: snapshot.number,
    additions: snapshot.additions,
    deletions: snapshot.deletions,
    changedFiles: snapshot.changedFiles,
    files,
    computedAt: nowIso(now),
  })
  state.quality.logicalChangeSizes[logicalChangeSize.id] = logicalChangeSize

  record.repoNameWithOwner =
    state.repos[repoId]?.repoNameWithOwner ?? record.repoNameWithOwner
  record.title = snapshot.title
  record.url = snapshot.url
  record.state =
    snapshot.state === 'MERGED'
      ? 'merged'
      : snapshot.state === 'CLOSED'
        ? 'closed'
        : snapshot.state === 'OPEN'
          ? 'open'
          : record.state
  record.headSha = snapshot.headSha || record.headSha
  record.headRefName = snapshot.headRefName ?? record.headRefName
  record.baseRefName = snapshot.baseRefName ?? record.baseRefName
  record.mergeSha = snapshot.mergeCommitSha ?? record.mergeSha
  record.mergedAt = snapshot.mergedAt ?? record.mergedAt
  record.changedFiles = snapshot.changedFiles ?? record.changedFiles
  record.additions = snapshot.additions ?? record.additions
  record.deletions = snapshot.deletions ?? record.deletions
  record.latestReviewDecision =
    snapshot.reviewDecision ?? record.latestReviewDecision
  record.logicalChangeSizeId = logicalChangeSize.id
  record.updatedAt = nowIso(now)
  return record
}

export function recordDefectFinding(
  state: HarnessRuntimeState,
  input: Omit<DefectFinding, 'id'> & { id?: string },
): DefectFinding {
  const id =
    input.id ??
    createStableId(
      input.repoId,
      input.prNumber,
      input.source,
      input.summary,
      input.detectedAt,
      input.severity,
      input.count,
    )
  const finding: DefectFinding = {
    ...input,
    id,
  }
  state.quality.findings[id] = finding
  const record = ensurePullRequestRecord(
    state,
    input.repoId,
    input.prNumber,
    input.detectedAt,
  )
  uniquePush(record.findingIds, id)
  record.updatedAt = input.detectedAt
  return finding
}

export function recordDeploymentVerification(
  state: HarnessRuntimeState,
  input: Omit<DeploymentVerification, 'id'> & { id?: string },
): DeploymentVerification {
  const id =
    input.id ??
    createStableId(
      input.repoId,
      input.prNumber,
      input.source,
      input.status,
      input.verifiedAt,
      input.mergeSha ?? '',
    )
  const deployment: DeploymentVerification = {
    ...input,
    id,
  }
  state.quality.deployments[id] = deployment
  const record = ensurePullRequestRecord(
    state,
    input.repoId,
    input.prNumber,
    input.verifiedAt,
  )
  if (input.mergeSha) {
    record.mergeSha = input.mergeSha
  }
  uniquePush(record.deploymentIds, id)
  record.updatedAt = input.verifiedAt
  return deployment
}

export function recordPostMergeIncident(
  state: HarnessRuntimeState,
  input: Omit<PostMergeIncident, 'id'> & { id?: string },
): PostMergeIncident {
  const id =
    input.id ??
    createStableId(
      input.repoId,
      input.prNumber,
      input.source,
      input.detectedAt,
      input.summary,
    )
  const incident: PostMergeIncident = {
    ...input,
    id,
  }
  state.quality.incidents[id] = incident
  const record = ensurePullRequestRecord(
    state,
    input.repoId,
    input.prNumber,
    input.detectedAt,
  )
  uniquePush(record.incidentIds, id)
  record.updatedAt = input.detectedAt
  return incident
}

export function recordRecoveryEvent(
  state: HarnessRuntimeState,
  input: Omit<RecoveryEvent, 'id'> & { id?: string },
): RecoveryEvent {
  const id =
    input.id ??
    createStableId(
      input.repoId,
      input.prNumber,
      input.incidentId,
      input.source,
      input.recoveredAt,
    )
  const recovery: RecoveryEvent = {
    ...input,
    id,
  }
  state.quality.recoveries[id] = recovery
  const incident = state.quality.incidents[input.incidentId]
  if (incident) {
    incident.status = 'resolved'
  }
  const record = ensurePullRequestRecord(
    state,
    input.repoId,
    input.prNumber,
    input.recoveredAt,
  )
  uniquePush(record.recoveryIds, id)
  record.updatedAt = input.recoveredAt
  return recovery
}

export function recordRevertLink(
  state: HarnessRuntimeState,
  input: Omit<RevertLink, 'id'> & { id?: string },
): RevertLink {
  const id =
    input.id ??
    createStableId(
      input.repoId,
      input.prNumber,
      input.mergeSha ?? '',
      input.revertCommitSha ?? '',
      input.detectedAt,
    )
  const revert: RevertLink = {
    ...input,
    id,
  }
  state.quality.reverts[id] = revert
  const record = ensurePullRequestRecord(
    state,
    input.repoId,
    input.prNumber,
    input.detectedAt,
  )
  uniquePush(record.revertIds, id)
  record.updatedAt = input.detectedAt
  return revert
}

function pullRequestFromShortCommit(
  state: HarnessRuntimeState,
  repoId: string,
  shortCommit: string | undefined,
): PullRequestQualityRecord | undefined {
  if (!shortCommit) {
    return undefined
  }
  return Object.values(state.quality.pullRequests).find(record => {
    if (record.repoId !== repoId) {
      return false
    }
    return (
      record.headSha?.startsWith(shortCommit) ||
      record.mergeSha?.startsWith(shortCommit)
    )
  })
}

function findPullRequestByBranch(
  state: HarnessRuntimeState,
  repoId: string,
  branch: string | undefined,
): PullRequestQualityRecord | undefined {
  const normalized = sanitizeBranchName(branch)
  if (!normalized) {
    return undefined
  }
  return Object.values(state.quality.pullRequests).find(record => {
    if (record.repoId !== repoId) {
      return false
    }
    return sanitizeBranchName(record.headRefName) === normalized
  })
}

function parseJsonLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => safeParseJSON(line, false))
    .filter(
      (value): value is Record<string, unknown> =>
        value != null && typeof value === 'object' && !Array.isArray(value),
    )
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

async function listFilesSortedByMtime(
  directory: string,
  pattern: RegExp,
): Promise<string[]> {
  try {
    const entries = await readdir(directory)
    const matched = entries.filter(entry => pattern.test(entry))
    const withStats = await Promise.all(
      matched.map(async entry => {
        const filePath = path.join(directory, entry)
        const fileStat = await stat(filePath)
        return {
          filePath,
          mtimeMs: fileStat.mtimeMs,
        }
      }),
    )
    return withStats
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .map(entry => entry.filePath)
  } catch {
    return []
  }
}

async function resolveLatestGstackRetro(
  repoRoot: string,
): Promise<GstackRetroSummary | null> {
  const retroDir = path.join(repoRoot, '.context', 'retros')
  const retroFiles = await listFilesSortedByMtime(retroDir, /\.json$/)
  const latest = retroFiles[0]
  if (!latest) {
    return null
  }
  const parsed = safeParseJSON(await readFile(latest, 'utf-8'), false)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  return {
    recordedAt:
      typeof record.generated_at === 'string'
        ? record.generated_at
        : typeof record.recorded_at === 'string'
          ? record.recorded_at
          : undefined,
    window: typeof record.window === 'string' ? record.window : undefined,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    testHealth: record.test_health,
  }
}

function attachRetroSummary(
  snapshot: RepoQualitySnapshot,
  retro: GstackRetroSummary | null,
): RepoQualitySnapshot {
  if (!retro) {
    return snapshot
  }
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      gstackRetro: retro,
    },
  }
}

function computeMean(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function buildPullRequestQualityView(
  state: HarnessRuntimeState,
  repoId: string,
  prNumber: number,
): PullRequestQualityView | null {
  const record = state.quality.pullRequests[createPullRequestQualityId(repoId, prNumber)]
  if (!record) {
    return null
  }
  const logicalChangeSize = record.logicalChangeSizeId
    ? state.quality.logicalChangeSizes[record.logicalChangeSizeId] ?? null
    : null
  const findings = record.findingIds
    .map(id => state.quality.findings[id])
    .filter((value): value is DefectFinding => value != null)
  const deployments = record.deploymentIds
    .map(id => state.quality.deployments[id])
    .filter((value): value is DeploymentVerification => value != null)
  const incidents = record.incidentIds
    .map(id => state.quality.incidents[id])
    .filter((value): value is PostMergeIncident => value != null)
  const recoveries = record.recoveryIds
    .map(id => state.quality.recoveries[id])
    .filter((value): value is RecoveryEvent => value != null)
  const reverts = record.revertIds
    .map(id => state.quality.reverts[id])
    .filter((value): value is RevertLink => value != null)

  const mttdValues = incidents
    .map(incident => {
      const baseline = toTimestamp(
        deployments.find(deployment => deployment.id === incident.relatedDeploymentId)
          ?.verifiedAt ?? record.mergedAt,
      )
      const detectedAt = toTimestamp(incident.detectedAt)
      return baseline != null && detectedAt != null ? detectedAt - baseline : null
    })
    .filter((value): value is number => value != null && value >= 0)

  const mttrValues = incidents
    .map(incident => {
      const recovery = recoveries.find(candidate => candidate.incidentId === incident.id)
      const detectedAt = toTimestamp(incident.detectedAt)
      const recoveredAt = toTimestamp(recovery?.recoveredAt)
      return detectedAt != null && recoveredAt != null ? recoveredAt - detectedAt : null
    })
    .filter((value): value is number => value != null && value >= 0)

  const logicalSize = logicalChangeSize?.weightedSize ?? 0
  const preMergeSeverityWeight = findings
    .filter(finding => finding.preMerge)
    .reduce((sum, finding) => sum + severityWeight(finding.severity, finding.count), 0)
  const escapedSeverityWeight = incidents.reduce(
    (sum, incident) => sum + severityWeight(incident.severity),
    0,
  )

  return {
    record,
    logicalChangeSize,
    findings,
    deployments,
    incidents,
    recoveries,
    reverts,
    metrics: {
      preMergeFindingCount: findings
        .filter(finding => finding.preMerge)
        .reduce((sum, finding) => sum + finding.count, 0),
      postMergeIncidentCount: incidents.length,
      revertCount: reverts.length,
      changeFailure: incidents.length > 0 || reverts.length > 0,
      meanTimeToDetectMs: computeMean(mttdValues),
      meanTimeToRecoverMs: computeMean(mttrValues),
      preMergeDefectDensity:
        logicalSize > 0 ? Number((preMergeSeverityWeight / logicalSize).toFixed(4)) : 0,
      escapedDefectDensity:
        logicalSize > 0 ? Number((escapedSeverityWeight / logicalSize).toFixed(4)) : 0,
    },
  }
}

function computeRepoSnapshotForWindow(
  state: HarnessRuntimeState,
  repoId: string,
  windowDays: QualitySnapshotWindow,
  generatedAt: string,
  retroSummary: GstackRetroSummary | null,
): RepoQualitySnapshot {
  const cutoff = new Date(generatedAt).getTime() - windowDays * 24 * 60 * 60 * 1000
  const records = Object.values(state.quality.pullRequests).filter(record => {
    if (record.repoId !== repoId) {
      return false
    }
    const mergedAt = toTimestamp(record.mergedAt)
    return mergedAt != null && mergedAt >= cutoff
  })
  const views = records
    .map(record => buildPullRequestQualityView(state, repoId, record.prNumber))
    .filter((value): value is PullRequestQualityView => value != null)

  const deployedPrCount = views.length
  const preMergeFindingCount = views.reduce(
    (sum, view) => sum + view.metrics.preMergeFindingCount,
    0,
  )
  const postMergeIncidentCount = views.reduce(
    (sum, view) => sum + view.metrics.postMergeIncidentCount,
    0,
  )
  const revertCount = views.reduce((sum, view) => sum + view.metrics.revertCount, 0)
  const manualIncidentCount = views.reduce(
    (sum, view) =>
      sum +
      view.incidents.filter(incident => incident.manual).length,
    0,
  )
  const changeFailureCount = views.filter(view => view.metrics.changeFailure).length
  const logicalSizeTotal = views.reduce(
    (sum, view) => sum + (view.logicalChangeSize?.weightedSize ?? 0),
    0,
  )
  const preMergeSeverityWeight = views.reduce(
    (sum, view) =>
      sum +
      view.findings
        .filter(finding => finding.preMerge)
        .reduce(
          (findingSum, finding) =>
            findingSum + severityWeight(finding.severity, finding.count),
          0,
        ),
    0,
  )
  const escapedSeverityWeight = views.reduce(
    (sum, view) =>
      sum +
      view.incidents.reduce(
        (incidentSum, incident) => incidentSum + severityWeight(incident.severity),
        0,
      ),
    0,
  )
  const mttdValues = views
    .map(view => view.metrics.meanTimeToDetectMs)
    .filter(value => value > 0)
  const mttrValues = views
    .map(view => view.metrics.meanTimeToRecoverMs)
    .filter(value => value > 0)

  return attachRetroSummary(
    {
      id: createSnapshotId(repoId, windowDays),
      repoId,
      generatedAt,
      windowDays,
      deployedPrCount,
      preMergeFindingCount,
      postMergeIncidentCount,
      revertCount,
      manualIncidentCount,
      escapedBugRate:
        deployedPrCount > 0
          ? Number((postMergeIncidentCount / deployedPrCount).toFixed(4))
          : 0,
      changeFailureRate:
        deployedPrCount > 0
          ? Number((changeFailureCount / deployedPrCount).toFixed(4))
          : 0,
      meanTimeToDetectMs: computeMean(mttdValues),
      meanTimeToRecoverMs: computeMean(mttrValues),
      preMergeDefectDensity:
        logicalSizeTotal > 0
          ? Number((preMergeSeverityWeight / logicalSizeTotal).toFixed(4))
          : 0,
      escapedDefectDensity:
        logicalSizeTotal > 0
          ? Number((escapedSeverityWeight / logicalSizeTotal).toFixed(4))
          : 0,
      metadata: {},
    },
    retroSummary,
  )
}

export function refreshRepoQualitySnapshots(
  state: HarnessRuntimeState,
  repoId: string,
  generatedAt: string,
  retroSummary: GstackRetroSummary | null = null,
): void {
  for (const windowDays of [7, 30] as const) {
    const snapshot = computeRepoSnapshotForWindow(
      state,
      repoId,
      windowDays,
      generatedAt,
      retroSummary,
    )
    state.quality.snapshots[snapshot.id] = snapshot
  }
}

export async function syncPullRequestQualityFromGitHub(input: {
  repoRoot: string
  repoId: string
  prNumber: number
  state: HarnessRuntimeState
  runner: ShellCommandRunner
  now?: Date
}): Promise<PullRequestQualityRecord | null> {
  const now = input.now ?? new Date()
  const snapshot = await loadPullRequestSnapshot(
    input.repoRoot,
    input.prNumber,
    input.runner,
  )
  if (!snapshot) {
    return null
  }
  const files = await loadPullRequestFiles(
    input.repoRoot,
    input.prNumber,
    input.runner,
  )
  const record = upsertPullRequestQualityRecord(
    input.state,
    input.repoId,
    snapshot,
    files,
    now,
  )
  const checks = await loadPullRequestChecks(
    input.repoRoot,
    input.prNumber,
    input.runner,
  )
  for (const check of checks) {
    maybeRecordCheckFinding(input.state, input.repoId, record, snapshot, check, now)
  }
  if ((snapshot.reviewDecision ?? '').toUpperCase() === 'CHANGES_REQUESTED') {
    recordDefectFinding(input.state, {
      repoId: input.repoId,
      prNumber: input.prNumber,
      headSha: snapshot.headSha,
      source: 'github-review',
      severity: 'high',
      category: 'review',
      summary: `GitHub review decision is CHANGES_REQUESTED for PR #${input.prNumber}.`,
      detectedAt: nowIso(now),
      preMerge: true,
      escaped: false,
      count: 1,
      metadata: {
        reviewDecision: snapshot.reviewDecision,
      },
      id: createStableId(
        input.repoId,
        input.prNumber,
        'github-review-decision',
        snapshot.headSha,
      ),
    })
  }
  return record
}

function maybeRecordCheckFinding(
  state: HarnessRuntimeState,
  repoId: string,
  record: PullRequestQualityRecord,
  snapshot: PullRequestSnapshot,
  check: PullRequestCheck,
  now: Date,
): void {
  const stateValue = (check.state ?? '').toUpperCase()
  const bucket = (check.bucket ?? '').toLowerCase()
  if (
    stateValue === 'SUCCESS' ||
    bucket === 'pass' ||
    bucket === 'skipping' ||
    bucket === 'pending'
  ) {
    return
  }
  recordDefectFinding(state, {
    repoId,
    prNumber: record.prNumber,
    headSha: snapshot.headSha,
    source: 'github-ci',
    severity: 'high',
    category: 'ci',
    summary: `PR #${record.prNumber} has a failing check: ${check.name}.`,
    detectedAt: nowIso(now),
    preMerge: true,
    escaped: false,
    count: 1,
    metadata: {
      checkName: check.name,
      checkState: check.state,
      bucket: check.bucket,
    },
    id: createStableId(
      repoId,
      record.prNumber,
      'github-ci',
      snapshot.headSha,
      check.name,
      check.state ?? '',
    ),
  })
}

export function recordGitHubRequestedChangesFinding(
  state: HarnessRuntimeState,
  repoId: string,
  input: {
    prNumber: number
    headSha?: string
    detectedAt?: string
    summary?: string
  },
): void {
  recordDefectFinding(state, {
    repoId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    source: 'github-review',
    severity: 'high',
    category: 'review',
    summary:
      input.summary ??
      `GitHub reviewer requested changes on PR #${input.prNumber}.`,
    detectedAt: input.detectedAt ?? nowIso(),
    preMerge: true,
    escaped: false,
    count: 1,
    metadata: {},
    id: createStableId(
      repoId,
      input.prNumber,
      'github-review-webhook',
      input.headSha ?? '',
    ),
  })
}

export function recordOutcomeQualitySignals(
  state: HarnessRuntimeState,
  repoId: string,
  job: HarnessRuntimeState['jobs'][string],
  outcome: JobOutcome,
): void {
  const prNumber = Number(job.promptVariables.prNumber ?? '')
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return
  }
  const detectedAt = outcome.completedAt
  for (const decision of outcome.reviewerDecisions) {
    if (decision.status === 'pass') {
      continue
    }
    const severity: HarnessQualitySeverity =
      decision.severity === 'error'
        ? 'high'
        : decision.severity === 'warn'
          ? 'medium'
          : 'low'
    recordDefectFinding(state, {
      repoId,
      prNumber,
      headSha:
        typeof job.promptVariables.headSha === 'string'
          ? job.promptVariables.headSha
          : undefined,
      source: 'cc-reviewer',
      severity,
      category: decision.reviewerId,
      summary: decision.summary,
      detectedAt,
      preMerge: true,
      escaped: false,
      count: 1,
      metadata: {
        reviewerId: decision.reviewerId,
        reasonCode: decision.reasonCode,
      },
      id: createStableId(
        repoId,
        prNumber,
        'cc-reviewer',
        decision.reviewerId,
        outcome.jobInstanceId,
      ),
    })
  }
}

export function recordDefaultBranchFailureIncident(
  state: HarnessRuntimeState,
  repoId: string,
  input: {
    prNumber: number
    headSha?: string
    detectedAt?: string
    summary?: string
  },
): void {
  recordPostMergeIncident(state, {
    repoId,
    prNumber: input.prNumber,
    mergeSha: input.headSha,
    source: 'default_branch_failure',
    severity: 'critical',
    status: 'open',
    detectedAt: input.detectedAt ?? nowIso(),
    summary:
      input.summary ??
      `Default branch regression detected for PR #${input.prNumber}.`,
    relatedDeploymentId: undefined,
    manual: false,
    metadata: {},
    id: createStableId(
      repoId,
      input.prNumber,
      'default-branch-failure',
      input.headSha ?? '',
    ),
  })
}

function parseMarkdownTableValue(
  report: string,
  label: string,
): string | undefined {
  const regex = new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i')
  return report.match(regex)?.[1]?.trim()
}

function parseQualityPrNumberFromQaReport(report: string): number | undefined {
  const prValue = parseMarkdownTableValue(report, 'PR')
  const directMatch = prValue?.match(/(\d+)/)
  return directMatch ? Number(directMatch[1]) : undefined
}

function parseQualityBranchFromQaReport(report: string): string | undefined {
  return parseMarkdownTableValue(report, 'Branch')
}

function parseDeployReport(report: string): {
  prNumber?: number
  mergedAt?: string
  mergeSha?: string
  verificationStatus: DeploymentVerification['status']
  verdict?: string
  summary: string
} {
  const prMatch = report.match(/PR:\s*#(\d+)/i)
  const mergedLine = report.match(/Merged:\s*([^\n(]+)/i)
  const mergeSha = report.match(/Merge SHA:\s*([a-f0-9]+)/i)?.[1]
  const verification = report.match(/Verification:\s*([A-Z]+)/i)?.[1]
  const verdict = report.match(/VERDICT:\s*([^\n]+)/i)?.[1]?.trim()
  return {
    prNumber: prMatch ? Number(prMatch[1]) : undefined,
    mergedAt: mergedLine?.[1]?.trim(),
    mergeSha,
    verificationStatus: normalizeDeploymentStatus(verification),
    verdict,
    summary: verdict ? `gstack land-and-deploy verdict: ${verdict}` : 'gstack land-and-deploy report',
  }
}

function pickPrForGstackArtifact(
  state: HarnessRuntimeState,
  repoId: string,
  input: {
    prNumber?: number
    branch?: string
    commit?: string
  },
): PullRequestQualityRecord | undefined {
  if (input.prNumber != null) {
    return state.quality.pullRequests[createPullRequestQualityId(repoId, input.prNumber)]
  }
  return (
    findPullRequestByBranch(state, repoId, input.branch) ??
    pullRequestFromShortCommit(state, repoId, input.commit)
  )
}

function resolveGstackProjectDir(
  repoRoot: string,
  repoNameWithOwner?: string,
): string {
  const slug = (repoNameWithOwner ?? path.basename(repoRoot)).replaceAll('/', '-')
  const gstackHome = process.env.GSTACK_HOME ?? path.join(os.homedir(), '.gstack')
  return path.join(gstackHome, 'projects', slug)
}

export async function ingestGstackQualityArtifacts(
  repoRoot: string,
  repoId: string,
  state: HarnessRuntimeState,
  now: Date = new Date(),
): Promise<void> {
  const projectDir = resolveGstackProjectDir(
    repoRoot,
    state.repos[repoId]?.repoNameWithOwner,
  )
  const reviewLogs = await listFilesSortedByMtime(projectDir, /-reviews\.jsonl$/)
  for (const logPath of reviewLogs) {
    const raw = await safeReadFile(logPath)
    if (!raw) {
      continue
    }
    const branch = path.basename(logPath).replace(/-reviews\.jsonl$/, '')
    for (const event of parseJsonLines(raw)) {
      const skill = typeof event.skill === 'string' ? event.skill : ''
      const timestamp =
        typeof event.timestamp === 'string' ? event.timestamp : nowIso(now)
      const pr = pickPrForGstackArtifact(state, repoId, {
        branch,
        commit: typeof event.commit === 'string' ? event.commit : undefined,
      })
      if (!pr) {
        continue
      }
      if (
        (skill === 'review' || skill === 'adversarial-review') &&
        Number(event.critical ?? 0) > 0
      ) {
        recordDefectFinding(state, {
          repoId,
          prNumber: pr.prNumber,
          headSha: pr.headSha,
          source: 'gstack-review',
          severity: 'critical',
          category: skill,
          summary: `gstack ${skill} found unresolved critical issues on PR #${pr.prNumber}.`,
          detectedAt: timestamp,
          preMerge: true,
          escaped: false,
          count: Number(event.critical ?? 0) || 1,
          metadata: event,
          id: createStableId(repoId, pr.prNumber, skill, 'critical', timestamp),
        })
      }
      if (
        (skill === 'review' || skill === 'adversarial-review') &&
        Number(event.informational ?? 0) > 0
      ) {
        recordDefectFinding(state, {
          repoId,
          prNumber: pr.prNumber,
          headSha: pr.headSha,
          source: 'gstack-review',
          severity: 'low',
          category: skill,
          summary: `gstack ${skill} left informational findings on PR #${pr.prNumber}.`,
          detectedAt: timestamp,
          preMerge: true,
          escaped: false,
          count: Number(event.informational ?? 0) || 1,
          metadata: event,
          id: createStableId(repoId, pr.prNumber, skill, 'informational', timestamp),
        })
      }
      if (skill === 'ship') {
        pr.metadata = {
          ...pr.metadata,
          gstackShipMetrics: event,
        }
        pr.updatedAt = timestamp
      }
    }
  }

  const qaReportsDir = path.join(repoRoot, '.gstack', 'qa-reports')
  const latestQaReport = (await listFilesSortedByMtime(qaReportsDir, /^qa-report-.*\.md$/))[0]
  const qaBaselineRaw = await safeReadFile(path.join(qaReportsDir, 'baseline.json'))
  if (latestQaReport && qaBaselineRaw) {
    const report = (await safeReadFile(latestQaReport)) ?? ''
    const qaBaseline = safeParseJSON(qaBaselineRaw, false)
    if (qaBaseline && typeof qaBaseline === 'object' && !Array.isArray(qaBaseline)) {
      const baselineRecord = qaBaseline as Record<string, unknown>
      const pr = pickPrForGstackArtifact(state, repoId, {
        prNumber: parseQualityPrNumberFromQaReport(report),
        branch: parseQualityBranchFromQaReport(report),
      })
      if (pr && Array.isArray(baselineRecord.issues)) {
        for (const issue of baselineRecord.issues) {
          if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
            continue
          }
          const typedIssue = issue as Record<string, unknown>
          const severity = (() => {
            switch (String(typedIssue.severity ?? '').toLowerCase()) {
              case 'critical':
                return 'critical'
              case 'high':
                return 'high'
              case 'medium':
                return 'medium'
              default:
                return 'low'
            }
          })() satisfies HarnessQualitySeverity
          recordDefectFinding(state, {
            repoId,
            prNumber: pr.prNumber,
            headSha: pr.headSha,
            source: 'gstack-qa',
            severity,
            category: String(typedIssue.category ?? 'qa'),
            summary: `gstack /qa issue ${String(typedIssue.id ?? 'unknown')}: ${String(typedIssue.title ?? 'unnamed issue')}`,
            detectedAt:
              typeof baselineRecord.date === 'string'
                ? new Date(`${baselineRecord.date}T00:00:00.000Z`).toISOString()
                : nowIso(now),
            preMerge: true,
            escaped: false,
            count: 1,
            metadata: typedIssue,
            id: createStableId(
              repoId,
              pr.prNumber,
              'gstack-qa',
              String(typedIssue.id ?? ''),
              String(typedIssue.title ?? ''),
            ),
          })
        }
      }
    }
  }

  const deployReportsDir = path.join(repoRoot, '.gstack', 'deploy-reports')
  const deployReports = await listFilesSortedByMtime(
    deployReportsDir,
    /-pr\d+-deploy\.md$/,
  )
  for (const deployPath of deployReports) {
    const report = await safeReadFile(deployPath)
    if (!report) {
      continue
    }
    const parsed = parseDeployReport(report)
    if (!parsed.prNumber) {
      continue
    }
    const deployment = recordDeploymentVerification(state, {
      repoId,
      prNumber: parsed.prNumber,
      mergeSha: parsed.mergeSha,
      source: 'gstack-land-and-deploy',
      status: parsed.verificationStatus,
      verifiedAt: parsed.mergedAt && toTimestamp(parsed.mergedAt) != null
        ? new Date(parsed.mergedAt).toISOString()
        : nowIso(now),
      summary: parsed.summary,
      metadata: {
        reportPath: deployPath,
        verdict: parsed.verdict,
      },
      id: createStableId(repoId, parsed.prNumber, deployPath, parsed.verificationStatus),
    })
    if (
      deployment.status === 'degraded' ||
      deployment.status === 'broken' ||
      deployment.status === 'failed' ||
      deployment.status === 'reverted'
    ) {
      const incident = recordPostMergeIncident(state, {
        repoId,
        prNumber: parsed.prNumber,
        mergeSha: parsed.mergeSha,
        source:
          deployment.status === 'reverted' ? 'revert' : 'deploy_verification',
        severity: inferIncidentSeverityFromStatus(deployment.status),
        status: deployment.status === 'reverted' ? 'resolved' : 'open',
        detectedAt: deployment.verifiedAt,
        summary: parsed.summary,
        relatedDeploymentId: deployment.id,
        manual: false,
        metadata: {
          verdict: parsed.verdict,
        },
        id: createStableId(repoId, parsed.prNumber, 'deploy-incident', deployPath),
      })
      if (deployment.status === 'reverted') {
        recordRevertLink(state, {
          repoId,
          prNumber: parsed.prNumber,
          mergeSha: parsed.mergeSha,
          detectedAt: deployment.verifiedAt,
          summary: parsed.summary,
          metadata: {
            reportPath: deployPath,
          },
          id: createStableId(repoId, parsed.prNumber, 'revert', deployPath),
        })
        recordRecoveryEvent(state, {
          repoId,
          prNumber: parsed.prNumber,
          incidentId: incident.id,
          mergeSha: parsed.mergeSha,
          source: 'revert',
          recoveredAt: deployment.verifiedAt,
          summary: 'gstack land-and-deploy reverted the merge',
          metadata: {
            reportPath: deployPath,
          },
          id: createStableId(repoId, parsed.prNumber, 'recovery', deployPath),
        })
      }
    }
  }

  const canaryReportsDir = path.join(repoRoot, '.gstack', 'canary-reports')
  const canaryReports = await listFilesSortedByMtime(
    canaryReportsDir,
    /-canary\.json$/,
  )
  for (const canaryPath of canaryReports) {
    const raw = await safeReadFile(canaryPath)
    const parsed = raw ? safeParseJSON(raw, false) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue
    }
    const data = parsed as Record<string, unknown>
    const status = normalizeDeploymentStatus(
      typeof data.status === 'string' ? data.status : undefined,
    )
    if (status === 'healthy' || status === 'skipped') {
      continue
    }
    const prNumberValue =
      typeof data.pr === 'number'
        ? data.pr
        : typeof data.prNumber === 'number'
          ? data.prNumber
          : undefined
    let pr =
      prNumberValue != null
        ? state.quality.pullRequests[createPullRequestQualityId(repoId, prNumberValue)]
        : undefined
    if (!pr) {
      const timestamp =
        typeof data.timestamp === 'string' && toTimestamp(data.timestamp) != null
          ? new Date(data.timestamp).getTime()
          : Date.now()
      const candidates = Object.values(state.quality.deployments)
        .filter(
          deployment =>
            deployment.repoId === repoId &&
            Math.abs(new Date(deployment.verifiedAt).getTime() - timestamp) <=
              2 * 60 * 60 * 1000,
        )
        .sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt))
      if (candidates.length === 1) {
        pr = state.quality.pullRequests[
          createPullRequestQualityId(repoId, candidates[0]!.prNumber)
        ]
      }
    }
    if (!pr) {
      continue
    }
    const deployment = recordDeploymentVerification(state, {
      repoId,
      prNumber: pr.prNumber,
      mergeSha: pr.mergeSha,
      source: 'gstack-canary',
      status,
      verifiedAt:
        typeof data.timestamp === 'string' && toTimestamp(data.timestamp) != null
          ? new Date(data.timestamp).toISOString()
          : nowIso(now),
      summary: `gstack /canary reported ${status} after deploy.`,
      metadata: data,
      id: createStableId(repoId, pr.prNumber, 'gstack-canary', canaryPath),
    })
    recordPostMergeIncident(state, {
      repoId,
      prNumber: pr.prNumber,
      mergeSha: pr.mergeSha,
      source: 'canary',
      severity: inferIncidentSeverityFromStatus(status),
      status: 'open',
      detectedAt: deployment.verifiedAt,
      summary: `gstack /canary reported ${status} after deploy.`,
      relatedDeploymentId: deployment.id,
      manual: false,
      metadata: data,
      id: createStableId(repoId, pr.prNumber, 'canary-incident', canaryPath),
    })
  }

  refreshRepoQualitySnapshots(
    state,
    repoId,
    nowIso(now),
    await resolveLatestGstackRetro(repoRoot),
  )
}

export function annotateManualIncident(
  state: HarnessRuntimeState,
  input: {
    repoId: string
    prNumber: number
    summary: string
    severity: HarnessQualitySeverity
    detectedAt?: string
    mergeSha?: string
  },
): PostMergeIncident {
  return recordPostMergeIncident(state, {
    repoId: input.repoId,
    prNumber: input.prNumber,
    mergeSha: input.mergeSha,
    source: 'manual',
    severity: input.severity,
    status: 'open',
    detectedAt: input.detectedAt ?? nowIso(),
    summary: input.summary,
    relatedDeploymentId: undefined,
    manual: true,
    metadata: {},
    id: createStableId(
      input.repoId,
      input.prNumber,
      'manual-incident',
      input.summary,
      input.detectedAt ?? '',
    ),
  })
}

export function getRepoQualityStatus(
  state: HarnessRuntimeState,
  repoId: string,
): {
  repoId: string
  snapshots: RepoQualitySnapshot[]
  openIncidentCount: number
  openCriticalIncidentCount: number
  recentPrs: PullRequestQualityView[]
} {
  const snapshots = Object.values(state.quality.snapshots)
    .filter(snapshot => snapshot.repoId === repoId)
    .sort((left, right) => left.windowDays - right.windowDays)
  const recentPrs = Object.values(state.quality.pullRequests)
    .filter(record => record.repoId === repoId)
    .sort((left, right) => (right.mergedAt ?? '').localeCompare(left.mergedAt ?? ''))
    .slice(0, 10)
    .map(record => buildPullRequestQualityView(state, repoId, record.prNumber))
    .filter((value): value is PullRequestQualityView => value != null)
  const incidents = recentPrs.flatMap(pr => pr.incidents)
  return {
    repoId,
    snapshots,
    openIncidentCount: incidents.filter(incident => incident.status === 'open').length,
    openCriticalIncidentCount: incidents.filter(
      incident => incident.status === 'open' && incident.severity === 'critical',
    ).length,
    recentPrs,
  }
}

export function getPullRequestQualityStatus(
  state: HarnessRuntimeState,
  repoId: string,
  prNumber: number,
): PullRequestQualityView | null {
  return buildPullRequestQualityView(state, repoId, prNumber)
}
