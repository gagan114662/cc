import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getOriginalCwd, getSessionProjectDir } from '../../bootstrap/state.js'
import type { WorkflowCommand } from '../../utils/workflowCommands.js'
import {
  getCapabilityFamily,
  type CapabilityFamily,
} from '../../utils/capabilityDiscovery.js'
import { getProjectDir } from '../../utils/sessionStorage.js'

type WorkflowRunAnalytics = {
  workflowName: string
  displayName: string
  family: CapabilityFamily
  runtime: 'code' | 'steps'
  totalRuns: number
  successfulRuns: number
  failedRuns: number
  validatorFailures: Record<string, number>
  lastRunAt: string
}

type WorkflowFamilyAnalytics = {
  totalRuns: number
  successfulRuns: number
  failedRuns: number
}

type WorkflowAnalyticsDocument = {
  version: 1
  updatedAt: string
  workflowRuns: Record<string, WorkflowRunAnalytics>
  workflowFamilies: Record<string, WorkflowFamilyAnalytics>
  capabilityUsage: Record<string, number>
  discoveryMisses: Record<string, number>
  validatorFailures: Record<string, number>
}

type WorkflowRunResult = {
  status: 'success' | 'failure'
}

function emptyWorkflowAnalyticsDocument(): WorkflowAnalyticsDocument {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    workflowRuns: {},
    workflowFamilies: {},
    capabilityUsage: {},
    discoveryMisses: {},
    validatorFailures: {},
  }
}

function toAnalyticsKey(value: string): string {
  return value.trim().toLowerCase()
}

async function loadWorkflowAnalyticsDocument(
  path: string,
): Promise<WorkflowAnalyticsDocument> {
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<WorkflowAnalyticsDocument>
    if (parsed && typeof parsed === 'object' && parsed.version === 1) {
      return {
        ...emptyWorkflowAnalyticsDocument(),
        ...parsed,
        workflowRuns: {
          ...emptyWorkflowAnalyticsDocument().workflowRuns,
          ...(parsed.workflowRuns ?? {}),
        },
        workflowFamilies: {
          ...emptyWorkflowAnalyticsDocument().workflowFamilies,
          ...(parsed.workflowFamilies ?? {}),
        },
        capabilityUsage: {
          ...emptyWorkflowAnalyticsDocument().capabilityUsage,
          ...(parsed.capabilityUsage ?? {}),
        },
        discoveryMisses: {
          ...emptyWorkflowAnalyticsDocument().discoveryMisses,
          ...(parsed.discoveryMisses ?? {}),
        },
        validatorFailures: {
          ...emptyWorkflowAnalyticsDocument().validatorFailures,
          ...(parsed.validatorFailures ?? {}),
        },
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Ignore malformed analytics and rebuild from a fresh document.
    }
  }

  return emptyWorkflowAnalyticsDocument()
}

function getWorkflowAnalyticsPath(overridePath?: string): string {
  if (overridePath) {
    return overridePath
  }

  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, 'workflow-analytics.json')
}

export class WorkflowAnalyticsTracker {
  readonly path: string
  private readonly capabilityUsage = new Map<string, number>()
  private readonly discoveryMisses = new Map<string, number>()
  private readonly validatorFailures = new Map<string, number>()

  constructor(
    readonly command: WorkflowCommand,
    overridePath?: string,
  ) {
    this.path = getWorkflowAnalyticsPath(overridePath)
  }

  recordCapabilityUsage(family: string, operation: string): void {
    const key = `${family}.${operation}`
    this.capabilityUsage.set(key, (this.capabilityUsage.get(key) ?? 0) + 1)
  }

  recordDiscoveryMiss(query: string, family?: string): void {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) {
      return
    }

    const key = family
      ? `${family}:${toAnalyticsKey(normalizedQuery)}`
      : toAnalyticsKey(normalizedQuery)
    this.discoveryMisses.set(key, (this.discoveryMisses.get(key) ?? 0) + 1)
  }

  recordValidatorIssues(issues: string[]): void {
    for (const issue of issues) {
      const normalized = issue.trim()
      if (!normalized) {
        continue
      }
      this.validatorFailures.set(
        normalized,
        (this.validatorFailures.get(normalized) ?? 0) + 1,
      )
    }
  }

  async flush(result: WorkflowRunResult): Promise<void> {
    const document = await loadWorkflowAnalyticsDocument(this.path)
    const workflowName = this.command.name
    const workflowFamily = getCapabilityFamily(this.command)
    const runtime = this.command.workflowRuntime === 'code' ? 'code' : 'steps'
    const now = new Date().toISOString()

    const existingRun =
      document.workflowRuns[workflowName] ??
      ({
        workflowName,
        displayName: this.command.userFacingName?.() ?? workflowName,
        family: workflowFamily,
        runtime,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        validatorFailures: {},
        lastRunAt: now,
      } satisfies WorkflowRunAnalytics)

    existingRun.totalRuns += 1
    if (result.status === 'success') {
      existingRun.successfulRuns += 1
    } else {
      existingRun.failedRuns += 1
    }
    existingRun.lastRunAt = now
    for (const [issue, count] of this.validatorFailures.entries()) {
      existingRun.validatorFailures[issue] =
        (existingRun.validatorFailures[issue] ?? 0) + count
      document.validatorFailures[issue] =
        (document.validatorFailures[issue] ?? 0) + count
    }
    document.workflowRuns[workflowName] = existingRun

    const familyBucket =
      document.workflowFamilies[workflowFamily] ?? {
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
      }
    familyBucket.totalRuns += 1
    if (result.status === 'success') {
      familyBucket.successfulRuns += 1
    } else {
      familyBucket.failedRuns += 1
    }
    document.workflowFamilies[workflowFamily] = familyBucket

    for (const [key, count] of this.capabilityUsage.entries()) {
      document.capabilityUsage[key] =
        (document.capabilityUsage[key] ?? 0) + count
    }

    for (const [key, count] of this.discoveryMisses.entries()) {
      document.discoveryMisses[key] =
        (document.discoveryMisses[key] ?? 0) + count
    }

    document.updatedAt = now
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(
      this.path,
      `${JSON.stringify(document, null, 2)}\n`,
      'utf-8',
    )
  }
}
