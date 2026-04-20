// POST /v1/employee/assign — HTTP entrypoint for programmatic assignment
// submission. Request path, not a CLI surface. Contract:
//
//   POST /v1/employee/assign
//   Headers: X-Tenant-Id (required), X-Tenant-Name (optional),
//            X-Tenant-Role (optional, defaults to 'developer')
//   Body:    { "assignment": "<1..4096 chars>" }
//
//   202 Accepted → { id, status: 'accepted', tenant, correlationId, submittedAt }
//   400         → { error: '<reason>' }      malformed body / empty assignment
//   403         → { error: '<reason>' }      tenant role < developer
//   405         → { error: 'method_not_allowed' }
//   413         → { error: 'body_too_large' }
//   415         → { error: 'unsupported_media_type' }
//
// This slice does NOT actually run the assignment. It durably accepts it
// (audit log, with the active tenant stamped via AsyncLocalStorage) and
// returns an id. The execution worker is Phase 2 item 3 (durable job
// queue) — wiring it in here without the queue would just recreate the
// "assignment dies with the process" problem the queue is meant to solve.
// The API shape is what unlocks items 2 and 3; we prove it works, log
// acceptance durably, and stop at the seam.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeAuditEntry } from '../audit/durableAuditLog.js'
import { getQueueBackend } from '../assignmentQueue/backend.js'
import type { QueueBackend } from '../assignmentQueue/backend.js'
import { withAssignmentSpan } from '../observability/dutySpans.js'
import { denyAssignIfUnauthorized } from '../tenant/assignmentAuthorization.js'
import {
  resolveTenantContext,
  resolveTenantFromHeaders,
  type TenantContext,
} from '../tenant/tenantContext.js'
import { runWithTenantScope } from '../tenant/tenantScope.js'

export const EMPLOYEE_ASSIGN_ROUTE = '/v1/employee/assign'
export const ASSIGNMENT_AUDIT_KIND = 'employee.assignment.api.accepted'

// 4 KB is generous for a single assignment string; anything bigger is
// almost certainly a caller bug or an attempt to abuse the audit log as
// a storage tier. If real workloads need more, we raise this — but let
// the failure be visible first.
export const ASSIGN_BODY_MAX_BYTES = 4096
export const ASSIGN_MIN_LENGTH = 1
export const ASSIGN_MAX_LENGTH = 4000

export type HandleEmployeeAssignOptions = {
  // Lets tests point writeAuditEntry at a tmp dir without monkey-patching
  // the global CACHE_PATHS. Passed straight through to writeAuditEntry.
  auditDir?: string
  // Override the default `() => randomUUID()` so tests can assert exact
  // correlation ids and exact JSON bodies without random drift.
  idFactory?: () => string
  // Clock override for the audit ts. Defaults to new Date().
  now?: () => Date
  // Where the per-tenant assignments-queue.jsonl lives. Default resolves
  // via storage.getAssignmentQueuePath → getProjectRoot(). The daemon
  // passes its own projectRoot so the HTTP handler enqueues into the
  // same file the daemon drainer watches.
  projectRoot?: string
  // Lets callers inject a concrete backend instance. The daemon uses
  // this in distributed-queue tests so one process can accept onto one
  // Redis-backed backend instance while a second daemon drains through
  // another, mirroring two machines on the same shared substrate.
  queueBackend?: QueueBackend
}

type ParsedBody =
  | { ok: true; assignment: string }
  | { ok: false; status: 400 | 413 | 415; error: string }

type RawBody = { kind: 'ok'; bytes: Buffer } | { kind: 'too_large' }

async function readBody(req: IncomingMessage): Promise<RawBody> {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > ASSIGN_BODY_MAX_BYTES) {
      overflow = true
      // Drain remaining to let Node close the stream cleanly, but stop
      // collecting — no point buffering data we're about to reject.
      continue
    }
    if (!overflow) chunks.push(buf)
  }
  if (overflow) return { kind: 'too_large' }
  return { kind: 'ok', bytes: Buffer.concat(chunks) }
}

function parseBody(raw: RawBody, contentType: string | undefined): ParsedBody {
  if (raw.kind === 'too_large') {
    return {
      ok: false,
      status: 413,
      error: `body_too_large: max ${ASSIGN_BODY_MAX_BYTES} bytes`,
    }
  }
  if (raw.bytes.length === 0) {
    return { ok: false, status: 400, error: 'empty_body' }
  }
  if (!contentType || !contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      status: 415,
      error: 'unsupported_media_type: application/json required',
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.bytes.toString('utf8'))
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, status: 400, error: 'invalid_body_shape' }
  }
  const assignment = (parsed as { assignment?: unknown }).assignment
  if (typeof assignment !== 'string') {
    return { ok: false, status: 400, error: 'assignment_field_required' }
  }
  const trimmed = assignment.trim()
  if (trimmed.length < ASSIGN_MIN_LENGTH) {
    return { ok: false, status: 400, error: 'assignment_empty' }
  }
  if (trimmed.length > ASSIGN_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `assignment_too_long: max ${ASSIGN_MAX_LENGTH} chars`,
    }
  }
  return { ok: true, assignment: trimmed }
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Pure handler — owns validation, RBAC, audit, response. Does NOT own
// the server; callers wire it onto their IncomingMessage dispatch. Kept
// async so future in-process enqueue (item 3) can await without reshape.
export async function handleEmployeeAssignRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HandleEmployeeAssignOptions = {},
): Promise<void> {
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  const raw = await readBody(req)
  const body = parseBody(raw, req.headers['content-type'] as string | undefined)
  if (!body.ok) {
    writeJson(res, body.status, { error: body.error })
    return
  }

  // Tenant comes from headers when the client authenticates that way;
  // otherwise fall through to env resolution (keeps local curl-against-
  // the-daemon working during single-operator bootstrapping). Important:
  // we do NOT silently grant admin — resolveTenantFromHeaders defaults
  // missing roles to 'developer'.
  const headerTenant = resolveTenantFromHeaders(req.headers)
  const tenant: TenantContext = headerTenant ?? resolveTenantContext()

  const denial = denyAssignIfUnauthorized(tenant)
  if (denial) {
    writeJson(res, 403, {
      error: denial,
      tenant: { id: tenant.id, role: tenant.role },
    })
    return
  }

  const id = (opts.idFactory ?? randomUUID)()
  const submittedAt = (opts.now ?? (() => new Date()))().toISOString()

  // Scope wrap: the audit write reads tenant from the active scope, so
  // concurrent assign requests with different tenant headers land with
  // the correct stamp on each entry — same isolation property
  // test/tenantScope.test.ts proves at the scope level, now exercised
  // by an actual HTTP route.
  // Audit first, then enqueue — audit is the "we received this"
  // contract (SOC 2), queue is the operational "it needs to run".
  // If enqueue throws the client gets 500 and the audit entry is
  // already durable, which is what we want — we never want to lose
  // the receipt record even if the queue write fails.
  await runWithTenantScope(
    { tenant, correlationId: id },
    () =>
      withAssignmentSpan(
        { assignmentId: id, tenant },
        async () => {
          writeAuditEntry(
            {
              ts: submittedAt,
              kind: ASSIGNMENT_AUDIT_KIND,
              assignmentId: id,
              assignment: body.assignment,
              source: 'http.v1',
            },
            opts.auditDir ? { dir: opts.auditDir } : undefined,
          )
          const backend = opts.queueBackend ?? (await getQueueBackend())
          await backend.enqueue(
            { id, assignment: body.assignment },
            { projectRoot: opts.projectRoot, tenantId: tenant.id },
          )
        },
      ),
  )

  writeJson(res, 202, {
    id,
    status: 'accepted',
    correlationId: id,
    submittedAt,
    tenant: { id: tenant.id, name: tenant.name, role: tenant.role },
  })
}
