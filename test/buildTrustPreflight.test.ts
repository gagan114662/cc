// test-intent: proves dependency preflight fails on broken environments and passes only when repo prerequisites resolve cleanly.
// test-spec: specs/build-trust-harness.md#preflight-integrity
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  evaluateBuildTrustPreflight,
  renderBuildTrustPreflightText,
} from '../scripts/buildTrustPreflight.js'

describe('buildTrustPreflight', () => {
  test('fails on a missing lockfile', () => {
    const report = evaluateBuildTrustPreflight(
      '/repo',
      {
        packageManager: `bun@${Bun.version}`,
        dependencies: {},
      },
      {
        lockfileExists: false,
        resolver: specifier => specifier,
      },
    )

    expect(report.status).toBe('failed')
    expect(report.checks.some(check => check.name === 'lockfile' && check.status === 'failed')).toBe(true)
  })

  test('fails when a direct dependency cannot resolve', () => {
    const report = evaluateBuildTrustPreflight(
      '/repo',
      {
        packageManager: `bun@${Bun.version}`,
        dependencies: {
          zod: '^4.1.12',
        },
      },
      {
        lockfileExists: true,
        resolver: specifier => {
          if (specifier === 'zod') {
            throw new Error('missing zod')
          }
          return specifier
        },
      },
    )

    expect(report.status).toBe('failed')
    expect(report.checks.some(check => check.name === 'dependency:zod' && check.status === 'failed')).toBe(true)
  })

  test('fails when a critical subpath cannot resolve', () => {
    const report = evaluateBuildTrustPreflight(
      '/repo',
      {
        packageManager: `bun@${Bun.version}`,
        dependencies: {},
      },
      {
        lockfileExists: true,
        criticalSpecifiers: ['zod/v4'],
        resolver: () => {
          throw new Error('bad subpath')
        },
      },
    )

    expect(report.status).toBe('failed')
    expect(report.checks.some(check => check.name === 'critical:zod/v4' && check.status === 'failed')).toBe(true)
  })

  test('passes on a valid synthetic manifest', () => {
    const report = evaluateBuildTrustPreflight(
      '/repo',
      {
        packageManager: `bun@${Bun.version}`,
        dependencies: {
          zod: '^4.1.12',
        },
      },
      {
        lockfileExists: true,
        criticalSpecifiers: ['zod/v4'],
        resolver: specifier => `/tmp/${specifier}.js`,
      },
    )

    expect(report.status).toBe('passed')
  })

  test('fails when packageManager is missing', () => {
    const report = evaluateBuildTrustPreflight(
      '/repo',
      {
        dependencies: {},
      },
      {
        lockfileExists: true,
        resolver: specifier => specifier,
      },
    )

    expect(
      report.checks.some(
        check => check.name === 'package_manager' && check.status === 'failed',
      ),
    ).toBe(true)
  })

  test('accepts package presence when a package root is not directly importable', () => {
    const report = evaluateBuildTrustPreflight(
      '/repo',
      {
        packageManager: `bun@${Bun.version}`,
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.20.0',
        },
      },
      {
        lockfileExists: true,
        criticalSpecifiers: [],
        resolver: () => {
          throw new Error('not directly importable')
        },
        packagePresenceChecker: dependency =>
          dependency === '@modelcontextprotocol/sdk',
      },
    )

    expect(report.status).toBe('passed')
  })

  test('cli prints remediation guidance on failure', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'build-trust-preflight-'))
    await mkdir(repoRoot, { recursive: true })
    await writeFile(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'tmp-build-trust',
        private: true,
        packageManager: `bun@${Bun.version}`,
        dependencies: {},
      }),
      'utf8',
    )

    try {
      const result = spawnSync(
        'bun',
        [path.join(process.cwd(), 'scripts/buildTrustPreflight.ts')],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        },
      )

      expect(result.status).toBe(1)
      expect(result.stdout.includes('Remediation: bun install --frozen-lockfile')).toBe(
        true,
      )
    } finally {
      await rm(repoRoot, { force: true, recursive: true })
    }
  })

  test('renders remediation text for failed reports', () => {
    const text = renderBuildTrustPreflightText({
      repoRoot: '/repo',
      packageManager: 'bun@1.3.11',
      bunVersion: '1.3.11',
      status: 'failed',
      checks: [
        {
          name: 'lockfile',
          status: 'failed',
          detail: 'Missing bun.lock.',
        },
      ],
    })

    expect(text.includes('Build trust dependency preflight: FAILED')).toBe(true)
    expect(text.includes('Remediation: bun install --frozen-lockfile')).toBe(
      true,
    )
  })
})
