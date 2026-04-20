import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  readWorkspaceLifecycleTail,
  summarizeWorkspaceLifecycle,
  writeWorkspaceLifecycleEvent,
} from 'src/services/workspaces/lifecycleLog.js'

let projectRoot: string

beforeEach(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  projectRoot = path.join(tmpdir(), `cc-workspace-lifecycle-${suffix}`)
  await mkdir(projectRoot, { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('workspace lifecycle log', () => {
  test('writes and summarizes lifecycle events', () => {
    writeWorkspaceLifecycleEvent(
      {
        ts: '2026-04-20T13:00:00.000Z',
        kind: 'worktree.setup.started',
        worktreePath: '/tmp/worktree-a',
        repoRoot: projectRoot,
      },
      { projectRoot },
    )
    writeWorkspaceLifecycleEvent(
      {
        ts: '2026-04-20T13:00:02.000Z',
        kind: 'worktree.setup.completed',
        worktreePath: '/tmp/worktree-a',
        repoRoot: projectRoot,
      },
      { projectRoot },
    )

    const tail = readWorkspaceLifecycleTail(10, { projectRoot })
    expect(tail).toHaveLength(2)
    expect(tail[0]!.kind).toBe('worktree.setup.completed')

    const summary = summarizeWorkspaceLifecycle(projectRoot, { recentLimit: 10 })
    expect(summary.total).toBe(2)
    expect(summary.byKind).toEqual([
      { kind: 'worktree.setup.completed', count: 1 },
      { kind: 'worktree.setup.started', count: 1 },
    ])
  })
})
