// Pins the opt-in git-hygiene checks added to conductorDoctor:
// dirty-tree, stale-branch, pre-merge-gate. Each check is pure-ish
// relative to a GitRunner, so tests inject canned git stdout / exit
// behavior without touching a real repo.

import { describe, expect, test } from 'bun:test'
import {
  checkDirtyTree,
  checkPreMergeGate,
  checkStaleBranch,
  inspectConductorRepo,
  type GitRunner,
} from 'src/scripts/conductorDoctor.js'

function makeRunner(
  responses: Record<string, string | Error>,
): GitRunner {
  return async (args: string[]) => {
    const key = args.join(' ')
    const hit = responses[key]
    if (hit instanceof Error) throw hit
    if (hit === undefined) {
      throw new Error(`unexpected git call in test: ${key}`)
    }
    return hit
  }
}

describe('checkDirtyTree', () => {
  test('returns clean when status --porcelain is empty', async () => {
    const runner = makeRunner({ 'status --porcelain': '' })
    const result = await checkDirtyTree('/repo', runner)
    expect(result).toEqual({ clean: true, files: [] })
  })

  test('flags dirty and returns the file list', async () => {
    const runner = makeRunner({
      'status --porcelain': ' M src/a.ts\n?? tmp.log',
    })
    const result = await checkDirtyTree('/repo', runner)
    expect(result.clean).toBe(false)
    expect(result.files).toEqual(['M src/a.ts', '?? tmp.log'])
  })
})

describe('checkStaleBranch', () => {
  test('flags stale when tip age exceeds threshold', async () => {
    // Tip committed 2026-03-01, now 2026-04-19 → 49 days.
    const runner = makeRunner({
      'log -1 --format=%ct HEAD': String(Math.floor(new Date('2026-03-01').getTime() / 1000)),
    })
    const result = await checkStaleBranch('/repo', 30, runner, new Date('2026-04-19T00:00:00Z'))
    expect(result.stale).toBe(true)
    expect(result.ageDays).toBeGreaterThanOrEqual(49)
    expect(result.threshold).toBe(30)
  })

  test('does not flag when tip age is below threshold', async () => {
    const runner = makeRunner({
      'log -1 --format=%ct HEAD': String(Math.floor(new Date('2026-04-15').getTime() / 1000)),
    })
    const result = await checkStaleBranch('/repo', 30, runner, new Date('2026-04-19T00:00:00Z'))
    expect(result.stale).toBe(false)
    expect(result.ageDays).toBe(4)
  })

  test('treats unparseable timestamp as not stale (tool must not false-positive)', async () => {
    const runner = makeRunner({ 'log -1 --format=%ct HEAD': '' })
    const result = await checkStaleBranch('/repo', 30, runner)
    expect(result.stale).toBe(false)
  })
})

describe('checkPreMergeGate', () => {
  test('merged when is-ancestor succeeds', async () => {
    const runner = makeRunner({
      'merge-base --is-ancestor origin/main HEAD': '',
    })
    const result = await checkPreMergeGate('/repo', 'main', runner)
    expect(result.mergedFromBase).toBe(true)
  })

  test('not merged when is-ancestor exits non-zero', async () => {
    const runner = makeRunner({
      'merge-base --is-ancestor origin/main HEAD': new Error('exit 1'),
    })
    const result = await checkPreMergeGate('/repo', 'main', runner)
    expect(result.mergedFromBase).toBe(false)
  })

  test('honors a custom base branch', async () => {
    const runner = makeRunner({
      'merge-base --is-ancestor origin/release HEAD': '',
    })
    const result = await checkPreMergeGate('/repo', 'release', runner)
    expect(result.mergedFromBase).toBe(true)
    expect(result.baseBranch).toBe('release')
  })
})

describe('inspectConductorRepo hygiene integration', () => {
  test('no --check flags leaves hygiene undefined (backwards compat)', async () => {
    const report = await inspectConductorRepo(process.cwd())
    expect(report.hygiene).toBeUndefined()
  })
})
