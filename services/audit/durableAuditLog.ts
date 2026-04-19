// Durable, append-only audit log.
//
// Why: before this, errors were retained only in a 100-entry process-local
// ring buffer (see utils/log.ts inMemoryErrorLog). The moment the CLI (or
// daemon) exited, the audit trail vanished. For SOC 2 / post-mortem /
// "what did the employee do yesterday" flows we need durable storage.
//
// Scope: a small, dependency-free JSONL writer at
//   <baseLogs>/audit/YYYY-MM-DD.jsonl
// One file per day, rotated by filename (no background timer needed).
// Phase 2 may promote to Postgres; the on-disk format stays compatible.
//
// Durability: appendFileSync is synchronous so a process crash immediately
// after a logError() still persists the entry. Entries are tiny (<1 KB),
// so the sync-write overhead is lower than the cost of losing the trail.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import path from 'node:path'
import { CACHE_PATHS } from '../../utils/cachePaths.js'
import {
  resolveTenantContext,
  type TenantContext,
} from '../tenant/tenantContext.js'

// Stamped on every audit entry so post-mortem tooling can slice by tenant
// without re-parsing arbitrary payload fields. Shape mirrors the span
// attribute triple on purpose — same vocabulary everywhere.
export type AuditTenantStamp = {
  id: string
  name: string
  role: TenantContext['role']
}

export type AuditEntry = {
  ts: string
  kind: string
  tenant?: AuditTenantStamp
  // Free-form payload. Entries must JSON.stringify cleanly; this is the
  // caller's responsibility (no Date, no BigInt, etc. without conversion).
  [key: string]: unknown
}

export type AuditWriteOptions = {
  // Override the audit directory (default: CACHE_PATHS.audit()). Tests
  // use this to point at a tmp dir without touching the host cache.
  dir?: string
  // Override the clock (default: new Date()). Tests use this to assert
  // day-boundary rotation without waiting 24 hours.
  now?: () => Date
  // Override tenant resolution (default: resolveTenantContext()). Daemon
  // duty dispatch will pass the per-duty tenant once routing is wired.
  tenant?: TenantContext
}

function resolveDir(opts: AuditWriteOptions | undefined): string {
  return opts?.dir ?? CACHE_PATHS.audit()
}

function resolveNow(opts: AuditWriteOptions | undefined): Date {
  return (opts?.now ?? (() => new Date()))()
}

function dayKey(now: Date): string {
  // UTC YYYY-MM-DD. UTC because daemons outlive timezone shifts and we
  // don't want the same wall-clock minute landing in two files.
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function auditFilePath(opts?: AuditWriteOptions): string {
  const now = resolveNow(opts)
  return path.join(resolveDir(opts), `${dayKey(now)}.jsonl`)
}

export function writeAuditEntry(
  entry: AuditEntry,
  opts?: AuditWriteOptions,
): string {
  const dir = resolveDir(opts)
  mkdirSync(dir, { recursive: true })
  const file = auditFilePath(opts)
  // Stamp tenant when the caller hasn't already — keeps legacy call sites
  // working (they just get DEFAULT_TENANT) while Phase 2 routing catches up.
  const tenantCtx = opts?.tenant ?? resolveTenantContext()
  const stamped: AuditEntry = entry.tenant
    ? entry
    : {
        ...entry,
        tenant: {
          id: tenantCtx.id,
          name: tenantCtx.name,
          role: tenantCtx.role,
        },
      }
  const line = JSON.stringify(stamped) + '\n'
  appendFileSync(file, line, 'utf8')
  return file
}

// Read the most recent N entries across audit files (newest file first,
// bounded tail). Returns in chronological order (oldest → newest) to
// match how /employee status would render them.
export function readAuditTail(
  limit: number = 50,
  opts?: AuditWriteOptions,
): AuditEntry[] {
  const dir = resolveDir(opts)
  if (!existsSync(dir)) return []

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort() // YYYY-MM-DD sorts ascending lexicographically
    .reverse() // newest first

  const collected: AuditEntry[] = []
  for (const name of files) {
    const full = path.join(dir, name)
    const contents = readFileSync(full, 'utf8')
    const lines = contents.split('\n').filter(Boolean)
    // Read the tail of this file first, so we can stop once we have enough
    // without parsing the whole history.
    for (let i = lines.length - 1; i >= 0 && collected.length < limit; i -= 1) {
      try {
        collected.push(JSON.parse(lines[i]!) as AuditEntry)
      } catch {
        // Skip malformed lines. A corrupted row shouldn't brick status.
      }
    }
    if (collected.length >= limit) break
  }

  // collected was newest-first; reverse for chronological display.
  return collected.reverse()
}
