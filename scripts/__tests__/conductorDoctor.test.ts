import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'bun:test'

import { inspectConductorRepo } from '../conductorDoctor.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function makeRepo(setup: (repoPath: string) => Promise<void>): Promise<string> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'conductor-doctor-'))
  tempDirs.push(repoPath)
  await execa('git', ['init', '-q'], { cwd: repoPath })
  await setup(repoPath)
  return repoPath
}

describe('inspectConductorRepo', () => {
  it('treats a GitHub origin as ready even when gb-local exists', async () => {
    const repoPath = await makeRepo(async cwd => {
      await execa('git', ['remote', 'add', 'origin', 'https://github.com/example/cc.git'], {
        cwd,
      })
      await execa('git', ['remote', 'add', 'gb-local', '.'], { cwd })
    })

    const report = await inspectConductorRepo(repoPath)

    expect(report.conductorReady).toBe(true)
    expect(report.problems).not.toContain('gitbutler_local_remote_only')
  })

  it('still blocks repos without a GitHub origin', async () => {
    const repoPath = await makeRepo(async cwd => {
      await execa('git', ['remote', 'add', 'gb-local', '.'], { cwd })
    })

    const report = await inspectConductorRepo(repoPath)

    expect(report.conductorReady).toBe(false)
    expect(report.problems).toContain('missing_origin_remote')
  })
})
