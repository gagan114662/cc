#!/usr/bin/env bun

import { access, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

export type BuildTrustPreflightStatus = 'passed' | 'failed'

export type BuildTrustPreflightCheck = {
  name: string
  status: BuildTrustPreflightStatus
  detail: string
}

export type BuildTrustPreflightReport = {
  repoRoot: string
  packageManager: string | null
  bunVersion: string
  status: BuildTrustPreflightStatus
  checks: BuildTrustPreflightCheck[]
}

export type BuildTrustPreflightManifest = {
  packageManager?: string
  dependencies?: Record<string, string>
}

export type BuildTrustPreflightOptions = {
  bunVersion?: string
  resolver?: (specifier: string) => string
  packagePresenceChecker?: (dependency: string) => boolean
  lockfileName?: string
  lockfileExists?: boolean
  criticalSpecifiers?: string[]
}

const DEFAULT_CRITICAL_SPECIFIERS = [
  'zod/v4',
  'picomatch',
  'lodash-es/sumBy.js',
  'typescript',
]

function addCheck(
  checks: BuildTrustPreflightCheck[],
  name: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({
    name,
    status: passed ? 'passed' : 'failed',
    detail,
  })
}

export function evaluateBuildTrustPreflight(
  repoRoot: string,
  manifest: BuildTrustPreflightManifest,
  options: BuildTrustPreflightOptions = {},
): BuildTrustPreflightReport {
  const checks: BuildTrustPreflightCheck[] = []
  const bunVersion = options.bunVersion ?? Bun.version
  const packageManager = manifest.packageManager ?? null
  const requiredBunVersion =
    packageManager?.startsWith('bun@') === true
      ? packageManager.slice('bun@'.length)
      : null

  if (!requiredBunVersion) {
    addCheck(
      checks,
      'package_manager',
      false,
      'package.json is missing a Bun packageManager entry.',
    )
  } else {
    addCheck(
      checks,
      'bun_version',
      bunVersion === requiredBunVersion,
      bunVersion === requiredBunVersion
        ? `Bun ${bunVersion} matches packageManager.`
        : `Expected Bun ${requiredBunVersion}, found ${bunVersion}.`,
    )
  }

  addCheck(
    checks,
    'lockfile',
    options.lockfileExists ?? false,
    options.lockfileExists ?? false
      ? `Found ${options.lockfileName ?? 'bun.lock'}.`
      : `Missing ${options.lockfileName ?? 'bun.lock'}. Run bun install --frozen-lockfile.`,
  )

  const dependencies = Object.keys(manifest.dependencies ?? {}).sort()
  const resolveSpecifier =
    options.resolver ??
    ((specifier: string) => {
      const require = createRequire(path.join(repoRoot, 'package.json'))
      return require.resolve(specifier)
    })
  const packagePresenceChecker =
    options.packagePresenceChecker ??
    ((dependency: string) =>
      existsSync(path.join(repoRoot, 'node_modules', dependency, 'package.json')))

  for (const dependency of dependencies) {
    try {
      const resolved = resolveSpecifier(dependency)
      addCheck(
        checks,
        `dependency:${dependency}`,
        true,
        `Resolved to ${resolved}.`,
      )
    } catch (error) {
      if (packagePresenceChecker(dependency)) {
        addCheck(
          checks,
          `dependency:${dependency}`,
          true,
          `Package directory exists for ${dependency} even though the package root is not directly importable.`,
        )
        continue
      }
      addCheck(
        checks,
        `dependency:${dependency}`,
        false,
        `Failed to resolve ${dependency}: ${String(error)}`,
      )
    }
  }

  for (const specifier of options.criticalSpecifiers ?? DEFAULT_CRITICAL_SPECIFIERS) {
    try {
      const resolved = resolveSpecifier(specifier)
      addCheck(
        checks,
        `critical:${specifier}`,
        true,
        `Resolved to ${resolved}.`,
      )
    } catch (error) {
      addCheck(
        checks,
        `critical:${specifier}`,
        false,
        `Failed to resolve ${specifier}: ${String(error)}`,
      )
    }
  }

  return {
    repoRoot,
    packageManager,
    bunVersion,
    status: checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
    checks,
  }
}

export async function runBuildTrustPreflight(
  repoRoot: string,
  options: BuildTrustPreflightOptions = {},
): Promise<BuildTrustPreflightReport> {
  const packageJsonPath = path.join(repoRoot, 'package.json')
  const manifest = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
  ) as BuildTrustPreflightManifest
  const lockfileName = options.lockfileName ?? 'bun.lock'
  const lockfilePath = path.join(repoRoot, lockfileName)
  const lockfileExists =
    options.lockfileExists ??
    (await access(lockfilePath).then(
      () => true,
      () => false,
    ))

  return evaluateBuildTrustPreflight(repoRoot, manifest, {
    ...options,
    lockfileName,
    lockfileExists,
  })
}

export function renderBuildTrustPreflightText(
  report: BuildTrustPreflightReport,
): string {
  const lines = [
    `Build trust dependency preflight: ${report.status.toUpperCase()}`,
    `Bun version: ${report.bunVersion}`,
    `Package manager: ${report.packageManager ?? '(missing)'}`,
    '',
  ]

  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.name}`)
    lines.push(`  ${check.detail}`)
  }

  if (report.status === 'failed') {
    lines.push('')
    lines.push('Remediation: bun install --frozen-lockfile')
  }

  return lines.join('\n')
}

if (import.meta.main) {
  const repoRoot = process.cwd()
  const report = await runBuildTrustPreflight(repoRoot)
  process.stdout.write(`${renderBuildTrustPreflightText(report)}\n`)
  process.exit(report.status === 'passed' ? 0 : 1)
}
