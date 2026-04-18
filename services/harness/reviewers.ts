import { existsSync } from 'node:fs'
import path from 'node:path'
import type { JobSpec, QueuedHarnessJob, ReviewDecision, VerificationResult } from './types.js'
import type { ShellCommandRunner } from './shell.js'
import {
  loadPullRequestChecks,
  loadPullRequestDiff,
  loadPullRequestFiles,
  loadPullRequestSnapshot,
} from './github.js'
import { truncateText } from './utils.js'

type ReviewerExecutionResult = {
  decisions: ReviewDecision[]
  verificationResults: VerificationResult[]
}

function getPrNumber(job: QueuedHarnessJob): number | null {
  const raw = job.promptVariables.prNumber
  if (!raw) {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

async function readBootstrapCommands(repoRoot: string): Promise<string[]> {
  const commands: string[] = ['command -v bun >/dev/null 2>&1']
  const packageJsonPath = path.join(repoRoot, 'package.json')
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = await Bun.file(packageJsonPath).json()
      const scripts =
        packageJson && typeof packageJson === 'object'
          ? (packageJson as { scripts?: Record<string, unknown> }).scripts
          : undefined
      if (scripts && typeof scripts['repo:bootstrap'] === 'string') {
        commands.push('bun run repo:bootstrap')
      }
    } catch {
      // Ignore malformed package.json and continue with the minimal bootstrap gate.
    }
  }
  const workspaceSetupPath = path.join(repoRoot, 'bin', 'setup_workspace')
  if (existsSync(workspaceSetupPath)) {
    commands.push('./bin/setup_workspace')
  }
  return commands
}

async function runBootstrapPreflight(
  repoRoot: string,
  runner: ShellCommandRunner,
): Promise<VerificationResult[]> {
  const shell = process.env.SHELL ?? '/bin/sh'
  const results: VerificationResult[] = []
  for (const command of await readBootstrapCommands(repoRoot)) {
    const result = await runner(shell, ['-lc', command], { cwd: repoRoot })
    results.push({
      command,
      code: result.code,
      stdout: truncateText(result.stdout, 4000),
      stderr: truncateText(result.stderr, 4000),
      phase: 'bootstrap',
      infrastructureFailure: result.code !== 0,
    })
    if (result.code !== 0) {
      break
    }
  }
  return results
}

async function runVerificationCommands(
  repoRoot: string,
  jobSpec: JobSpec,
  runner: ShellCommandRunner,
): Promise<VerificationResult[]> {
  const shell = process.env.SHELL ?? '/bin/sh'
  const results = await runBootstrapPreflight(repoRoot, runner)
  if (results.some(result => result.code !== 0)) {
    return results
  }
  for (const command of jobSpec.verification.commands) {
    const result = await runner(shell, ['-lc', command], { cwd: repoRoot })
    results.push({
      command,
      code: result.code,
      stdout: truncateText(result.stdout, 4000),
      stderr: truncateText(result.stderr, 4000),
      phase: 'verification',
      infrastructureFailure: false,
    })
  }
  return results
}

export async function runReviewerSuites(
  repoRoot: string,
  jobSpec: JobSpec,
  job: QueuedHarnessJob,
  runner: ShellCommandRunner,
  options: { paused: boolean },
): Promise<ReviewerExecutionResult> {
  const decisions: ReviewDecision[] = []
  const verificationResults = await runVerificationCommands(repoRoot, jobSpec, runner)
  const prNumber = getPrNumber(job)
  const pr =
    prNumber == null ? null : await loadPullRequestSnapshot(repoRoot, prNumber, runner)
  const prChecks =
    prNumber == null ? [] : await loadPullRequestChecks(repoRoot, prNumber, runner)
  const prFiles =
    prNumber == null ? [] : await loadPullRequestFiles(repoRoot, prNumber, runner)
  const prDiff =
    prNumber == null ? '' : await loadPullRequestDiff(repoRoot, prNumber, runner)

  for (const reviewerId of jobSpec.reviewerSuites) {
    switch (reviewerId) {
      case 'scope': {
        if (pr?.isDraft) {
          decisions.push({
            reviewerId,
            status: 'block',
            blocking: true,
            severity: 'error',
            reasonCode: 'draft_pr',
            summary: 'pull request is still draft',
            details: [],
          })
          break
        }

        const changedFiles = pr?.changedFiles ?? 0
        const lineDelta = (pr?.additions ?? 0) + (pr?.deletions ?? 0)
        if (changedFiles > 40 || lineDelta > 1200) {
          decisions.push({
            reviewerId,
            status: 'block',
            blocking: true,
            severity: 'error',
            reasonCode: 'oversized_diff',
            summary: 'diff is too large for unattended merge',
            details: [
              `changed files: ${changedFiles}`,
              `line delta: ${lineDelta}`,
            ],
          })
        } else if (changedFiles > 20 || lineDelta > 600) {
          decisions.push({
            reviewerId,
            status: 'warn',
            blocking: false,
            severity: 'warn',
            reasonCode: 'large_diff',
            summary: 'diff is getting large',
            details: [`changed files: ${changedFiles}`, `line delta: ${lineDelta}`],
          })
        } else {
          decisions.push({
            reviewerId,
            status: 'pass',
            blocking: false,
            severity: 'info',
            reasonCode: 'scope_ok',
            summary: 'scope looks mergeable',
            details: [],
          })
        }
        break
      }

      case 'reliability': {
        const failedChecks = prChecks.filter(check => {
          const bucket = (check.bucket ?? '').toLowerCase()
          const state = (check.state ?? '').toLowerCase()
          return ['fail', 'failure'].includes(bucket) || ['fail', 'failure', 'error'].includes(state)
        })
        const bootstrapFailures = verificationResults.filter(
          result => result.phase === 'bootstrap' && result.code !== 0,
        )
        const failedVerifications = verificationResults.filter(
          result => result.phase === 'verification' && result.code !== 0,
        )

        if (bootstrapFailures.length > 0) {
          decisions.push({
            reviewerId,
            status: 'block',
            blocking: true,
            severity: 'error',
            reasonCode: 'infrastructure_failure',
            summary: 'runner bootstrap failed before verification could start',
            details: bootstrapFailures.map(
              result => `bootstrap failed: ${result.command}`,
            ),
          })
        } else if (failedChecks.length > 0 || failedVerifications.length > 0) {
          decisions.push({
            reviewerId,
            status: 'block',
            blocking: true,
            severity: 'error',
            reasonCode: 'reliability_failure',
            summary: 'reliability checks are failing',
            details: [
              ...failedChecks.map(check => `PR check failed: ${check.name}`),
              ...failedVerifications.map(
                result => `verification failed: ${result.command}`,
              ),
            ],
          })
        } else if (verificationResults.length === 0 && prChecks.length === 0) {
          decisions.push({
            reviewerId,
            status: 'warn',
            blocking: false,
            severity: 'warn',
            reasonCode: 'missing_verification_signal',
            summary: 'no verification signal was available',
            details: [],
          })
        } else {
          decisions.push({
            reviewerId,
            status: 'pass',
            blocking: false,
            severity: 'info',
            reasonCode: 'reliability_ok',
            summary: 'reliability checks passed',
            details: [],
          })
        }
        break
      }

      case 'security': {
        const secretPattern =
          /(BEGIN (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY|AWS_SECRET_ACCESS_KEY|ghp_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]+)/i
        const dangerousConfigPattern =
          /(dangerously-skip-permissions|allow_remote_control|settings\.json|hooks\.json)/i
        if (secretPattern.test(prDiff)) {
          decisions.push({
            reviewerId,
            status: 'block',
            blocking: true,
            severity: 'error',
            reasonCode: 'secret_like_material',
            summary: 'diff appears to contain sensitive secrets material',
            details: [],
          })
        } else if (dangerousConfigPattern.test(prDiff)) {
          decisions.push({
            reviewerId,
            status: 'warn',
            blocking: false,
            severity: 'warn',
            reasonCode: 'sensitive_surface_touched',
            summary: 'diff touches sensitive config or permission surfaces',
            details: [],
          })
        } else {
          decisions.push({
            reviewerId,
            status: 'pass',
            blocking: false,
            severity: 'info',
            reasonCode: 'security_ok',
            summary: 'no obvious security regressions found',
            details: [],
          })
        }
        break
      }

      case 'test-quality': {
        const codeFiles = prFiles.filter(file =>
          /\.(tsx?|jsx?|py|go|rs)$/.test(file),
        )
        const testFiles = prFiles.filter(file =>
          /(^|\/)(test|tests|__tests__)\/|(\.test\.|\.spec\.)/.test(file),
        )
        if (jobSpec.codeChangePolicy === 'may-edit' && verificationResults.length === 0) {
          decisions.push({
            reviewerId,
            status: 'block',
            blocking: true,
            severity: 'error',
            reasonCode: 'missing_verification_commands',
            summary: 'code-producing work is missing verification commands',
            details: [],
          })
        } else if (codeFiles.length > 0 && testFiles.length === 0) {
          decisions.push({
            reviewerId,
            status: 'warn',
            blocking: false,
            severity: 'warn',
            reasonCode: 'code_without_tests',
            summary: 'code changed without obvious test coverage updates',
            details: [`changed code files: ${codeFiles.length}`],
          })
        } else {
          decisions.push({
            reviewerId,
            status: 'pass',
            blocking: false,
            severity: 'info',
            reasonCode: 'test_quality_ok',
            summary: 'test-quality gate passed',
            details: [],
          })
        }
        break
      }

      case 'release-readiness': {
        if (options.paused && jobSpec.autoMerge) {
          decisions.push({
            reviewerId,
            status: 'block',
            blocking: true,
            severity: 'error',
            reasonCode: 'mainline_paused',
            summary: 'auto-merge is paused while main is unhealthy',
            details: [],
          })
          break
        }

        const mergeable = (pr?.mergeable ?? '').toUpperCase()
        if (mergeable.includes('CONFLICT')) {
          decisions.push({
            reviewerId,
            status: 'block',
            blocking: true,
            severity: 'error',
            reasonCode: 'merge_conflict',
            summary: 'pull request is not mergeable cleanly',
            details: [],
          })
        } else {
          decisions.push({
            reviewerId,
            status: 'pass',
            blocking: false,
            severity: 'info',
            reasonCode: 'release_ready',
            summary: 'release-readiness gate passed',
            details: [],
          })
        }
        break
      }

      default:
        decisions.push({
          reviewerId,
          status: 'warn',
          blocking: false,
          severity: 'warn',
          reasonCode: 'unknown_reviewer_suite',
          summary: `unknown reviewer suite: ${reviewerId}`,
          details: [],
        })
        break
    }
  }

  return {
    decisions,
    verificationResults,
  }
}
