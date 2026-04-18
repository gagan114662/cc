import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  getDefaultHarnessConfig,
  readEffectiveHarnessConfig,
  writeHarnessConfig,
} from 'src/services/harness/config.js'

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-harness-config-'))
  await mkdir(path.join(repoRoot, '.claude'), { recursive: true })
  return repoRoot
}

describe('harness config', () => {
  test('compiles recurring employee duties into harness jobs', async () => {
    const repoRoot = await createTempRepo()
    await writeFile(
      path.join(repoRoot, '.claude', 'employee.json'),
      JSON.stringify(
        {
          role: 'engineering-lead',
          goals: ['Keep CI healthy'],
          defaultAutonomy: 'full-operator',
          delegationMode: 'team',
          verificationRequired: true,
          recurringDuties: [
            {
              id: 'morning-ci',
              title: 'Morning CI sweep',
              prompt: 'Review CI failures and summarize blockers.',
              cron: '0 9 * * 1-5',
              enabled: true,
              autoCommit: false,
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    )

    const config = await readEffectiveHarnessConfig(repoRoot)
    expect(config.jobs.some(job => job.id === 'pr-review-on-push')).toBe(true)
    expect(
      config.jobs.some(job => job.id === 'employee-duty-morning-ci'),
    ).toBe(true)
  })

  test('backfills new default jobs into older harness configs', async () => {
    const repoRoot = await createTempRepo()
    const oldConfig = getDefaultHarnessConfig()
    oldConfig.jobs = oldConfig.jobs.filter(job => job.id !== 'review-comment-follow-up')
    await writeHarnessConfig(oldConfig, repoRoot)

    const config = await readEffectiveHarnessConfig(repoRoot)
    expect(
      config.jobs.some(job => job.id === 'review-comment-follow-up'),
    ).toBe(true)
  })
})
