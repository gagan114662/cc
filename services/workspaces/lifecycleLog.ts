import path from 'node:path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { appendEncryptedJsonlRecord, buildEncryptionArtifact, readEncryptedJsonl } from '../security/encryptedJsonl.js'

const WORKSPACE_LIFECYCLE_FILE_NAME = 'workspace-lifecycle.jsonl'

export type WorkspaceLifecycleEvent = {
  ts: string
  kind:
    | 'worktree.setup.started'
    | 'worktree.setup.completed'
    | 'worktree.setup.failed'
    | 'worktree.cleanup.started'
    | 'worktree.cleanup.completed'
    | 'worktree.cleanup.failed'
    | 'worktree.kept'
    | 'agent.worktree.created'
    | 'agent.worktree.removed'
  worktreePath: string
  repoRoot?: string
  worktreeBranch?: string
  sessionId?: string
  error?: string
}

export type WorkspaceLifecycleOptions = {
  projectRoot?: string
  encryptionKey?: string
}

function lifecyclePath(projectRoot?: string): string {
  const root = projectRoot ?? getProjectRoot()
  return path.join(root, '.claude', WORKSPACE_LIFECYCLE_FILE_NAME)
}

export function writeWorkspaceLifecycleEvent(
  event: WorkspaceLifecycleEvent,
  opts: WorkspaceLifecycleOptions = {},
): void {
  appendEncryptedJsonlRecord(
    lifecyclePath(opts.projectRoot),
    event,
    opts.encryptionKey ? { key: opts.encryptionKey } : undefined,
  )
}

export function readWorkspaceLifecycleTail(
  limit: number = 20,
  opts: WorkspaceLifecycleOptions = {},
): WorkspaceLifecycleEvent[] {
  const events = readEncryptedJsonl<WorkspaceLifecycleEvent>(
    lifecyclePath(opts.projectRoot),
    opts.encryptionKey ? { key: opts.encryptionKey } : undefined,
  )
  return events
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, Math.max(1, limit))
}

export function summarizeWorkspaceLifecycle(
  projectRoot?: string,
  opts: WorkspaceLifecycleOptions & { recentLimit?: number } = {},
): {
  total: number
  recent: WorkspaceLifecycleEvent[]
  byKind: Array<{ kind: WorkspaceLifecycleEvent['kind']; count: number }>
} {
  const events = readEncryptedJsonl<WorkspaceLifecycleEvent>(
    lifecyclePath(projectRoot),
    opts.encryptionKey ? { key: opts.encryptionKey } : undefined,
  )
  const counts = new Map<WorkspaceLifecycleEvent['kind'], number>()
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1)
  }
  return {
    total: events.length,
    recent: events
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, Math.max(1, opts.recentLimit ?? 10)),
    byKind: Array.from(counts.entries())
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
  }
}

export function buildWorkspaceSecurityArtifact(now?: () => Date): {
  generatedAt: string
  encryptionAtRest: {
    enabled: boolean
    env: string
    algorithm: string
    coveredStores: string[]
  }
} {
  return buildEncryptionArtifact({
    now,
    coveredStores: ['workspace-lifecycle'],
  })
}
