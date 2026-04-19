// Durable assignment queue storage (Phase 2 item 3).
//
// Why JSONL on disk: the gap analysis deferred Redis / BullMQ until a
// second daemon exists. In-process durability against daemon restart
// and process crash is what this file provides — nothing more, nothing
// less. appendFileSync matches services/audit/durableAuditLog.ts so a
// crash between two writes leaves the last durable state intact.
//
// Layout (mirrors Phase 2 item 2's employee.json layout):
//   DEFAULT_TENANT → <root>/.claude/assignments-queue.jsonl
//   named tenant   → <root>/.claude/tenants/<id>/assignments-queue.jsonl
//
// File format — one JSON object per line. Two record kinds:
//   { kind:"enqueue", id, assignment, ts }
//   { kind:"state", id, state:"pending"|"running"|"done"|"failed",
//     lastError?, ts }
//
// The reader folds records per id and keeps the last state — so a
// 'running' crash is recoverable by appending a 'pending' record
// (see recoverCrashedAssignments) rather than rewriting the file.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  DEFAULT_TENANT_ID,
} from '../tenant/tenantContext.js'
import { currentTenantContext } from '../tenant/tenantScope.js'

const QUEUE_FILE_NAME = 'assignments-queue.jsonl'
const TENANTS_DIR_NAME = 'tenants'

export type AssignmentState = 'pending' | 'running' | 'done' | 'failed'

export type AssignmentRecord = {
  id: string
  assignment: string
  state: AssignmentState
  enqueuedAt: string
  updatedAt: string
  lastError?: string
}

// Resolution order matches utils/employeeConfig.ts: explicit arg >
// active scope > env-derived DEFAULT_TENANT. Keeping it identical
// means daemon tests and legacy CLI paths don't branch here.
function resolveTenantId(tenantId?: string): string {
  if (tenantId !== undefined) return tenantId
  return currentTenantContext().id
}

export function getAssignmentQueuePath(
  projectRoot?: string,
  tenantId?: string,
): string {
  const root = projectRoot ?? getProjectRoot()
  const resolved = resolveTenantId(tenantId)
  if (resolved === DEFAULT_TENANT_ID) {
    return join(root, '.claude', QUEUE_FILE_NAME)
  }
  return join(root, '.claude', TENANTS_DIR_NAME, resolved, QUEUE_FILE_NAME)
}

export type QueueWriteOpts = {
  projectRoot?: string
  tenantId?: string
  now?: () => Date
}

type EnqueueRecord = {
  kind: 'enqueue'
  id: string
  assignment: string
  ts: string
}

type StateRecord = {
  kind: 'state'
  id: string
  state: AssignmentState
  lastError?: string
  ts: string
}

type QueueRecord = EnqueueRecord | StateRecord

function appendRecord(record: QueueRecord, opts: QueueWriteOpts): void {
  const filePath = getAssignmentQueuePath(opts.projectRoot, opts.tenantId)
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8')
}

export async function enqueueAssignment(
  input: { id: string; assignment: string },
  opts: QueueWriteOpts = {},
): Promise<void> {
  const ts = (opts.now ?? (() => new Date()))().toISOString()
  appendRecord(
    { kind: 'enqueue', id: input.id, assignment: input.assignment, ts },
    opts,
  )
}

export async function appendAssignmentStateRecord(
  input: { id: string; state: AssignmentState; lastError?: string },
  opts: QueueWriteOpts = {},
): Promise<void> {
  const ts = (opts.now ?? (() => new Date()))().toISOString()
  const record: StateRecord = {
    kind: 'state',
    id: input.id,
    state: input.state,
    ts,
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
  }
  appendRecord(record, opts)
}

// Replay the JSONL and fold per id. Returns records in enqueue order
// so the drainer can pick up the oldest pending first (FIFO).
export async function loadAssignmentQueue(
  projectRoot?: string,
  tenantId?: string,
): Promise<AssignmentRecord[]> {
  const filePath = getAssignmentQueuePath(projectRoot, tenantId)
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const byId = new Map<string, AssignmentRecord>()
  const order: string[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let parsed: QueueRecord | null = null
    try {
      parsed = JSON.parse(line) as QueueRecord
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    if (parsed.kind === 'enqueue') {
      if (!byId.has(parsed.id)) {
        byId.set(parsed.id, {
          id: parsed.id,
          assignment: parsed.assignment,
          state: 'pending',
          enqueuedAt: parsed.ts,
          updatedAt: parsed.ts,
        })
        order.push(parsed.id)
      }
    } else if (parsed.kind === 'state') {
      const existing = byId.get(parsed.id)
      if (!existing) continue // state record before enqueue → drop
      existing.state = parsed.state
      existing.updatedAt = parsed.ts
      if (parsed.lastError !== undefined) {
        existing.lastError = parsed.lastError
      }
    }
  }

  return order.map(id => byId.get(id)!).filter(Boolean)
}

// Crash-recovery: a daemon that died mid-drain left at least one
// assignment in 'running'. Re-pend each so the next drainer picks it
// up. We do this by appending a fresh 'pending' state record rather
// than rewriting — append-only logs stay crash-safe.
export async function recoverCrashedAssignments(
  projectRoot?: string,
  tenantId?: string,
): Promise<string[]> {
  const records = await loadAssignmentQueue(projectRoot, tenantId)
  const recovered: string[] = []
  for (const r of records) {
    if (r.state === 'running') {
      await appendAssignmentStateRecord(
        { id: r.id, state: 'pending' },
        { projectRoot, tenantId },
      )
      recovered.push(r.id)
    }
  }
  return recovered
}
