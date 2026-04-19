// POST /v1/employee/assign — end-to-end. Pins the HTTP contract for
// Phase 2 item 5. We drive a live daemon (bound to an ephemeral port),
// push requests through, and assert both the HTTP shape and the
// durable audit-log stamp the scope produced deep in the handler.
//
// Covered cases, in order of the bug class they catch:
//   - Happy paths: no headers (env-resolved DEFAULT_TENANT admin) and
//     explicit header tenant with developer role — both must land 202
//     with an audit row whose tenant matches the caller's claim.
//   - RBAC: viewer-role header must be rejected with 403 before any
//     audit write happens (prevents logging a denial as if it were work).
//   - Method/body/content-type validation: GET, non-JSON, malformed JSON,
//     empty assignment, oversized body — each has a distinct error code.
//   - Concurrency: two parallel requests with different tenants must
//     stamp their own tenant on their own audit row. Same isolation
//     property test/tenantScope.test.ts proves at the scope layer,
//     now exercised by the real HTTP route.
//   - Lifecycle: during drain, the endpoint must refuse new work with
//     503 — otherwise a burst of requests can race past shutdown_begin
//     and write to an audit file the daemon is about to seal.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  startDaemon,
  stopDaemon,
} from 'src/entrypoints/daemon.js'
import { ASSIGNMENT_AUDIT_KIND } from 'src/services/http/employeeAssignRoute.js'

type DaemonHandle = Awaited<ReturnType<typeof startDaemon>>

let projectRoot: string
let auditDir: string
let port: number
let daemon: DaemonHandle | null = null

const originalEnv = {
  CC_TENANT_ID: process.env.CC_TENANT_ID,
  CC_TENANT_NAME: process.env.CC_TENANT_NAME,
  CC_TENANT_ROLE: process.env.CC_TENANT_ROLE,
  CC_DAEMON_AUDIT_DIR: process.env.CC_DAEMON_AUDIT_DIR,
}

function pickEphemeralPort(): number {
  return 40000 + Math.floor(Math.random() * 10000)
}

async function writeEmployeeConfig(root: string): Promise<void> {
  await mkdir(path.join(root, '.claude'), { recursive: true })
  await writeFile(
    path.join(root, '.claude', 'employee.json'),
    JSON.stringify(
      {
        role: 'engineering-lead',
        goals: [],
        defaultAutonomy: 'full-operator',
        delegationMode: 'team',
        verificationRequired: true,
        recurringDuties: [],
      },
      null,
      2,
    ),
  )
}

async function readAllAuditEntries(): Promise<Array<Record<string, unknown>>> {
  const files = await readdir(auditDir).catch(() => [] as string[])
  const entries: Array<Record<string, unknown>> = []
  for (const f of files.filter(f => f.endsWith('.jsonl'))) {
    const raw = await readFile(path.join(auditDir, f), 'utf8')
    for (const line of raw.split('\n').filter(Boolean)) {
      entries.push(JSON.parse(line))
    }
  }
  return entries
}

async function post(
  url: string,
  body: unknown,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  // Merge headers explicitly — spreading ...init after the headers
  // object would let an init without a content-type stomp ours.
  const { headers: initHeaders, ...rest } = init
  const res = await fetch(url, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(initHeaders as Record<string, string> | undefined),
    },
  } as RequestInit)
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

beforeEach(async () => {
  // Reset tenant env for each test so one test's override doesn't leak
  // into the env-fallback path of another.
  delete process.env.CC_TENANT_ID
  delete process.env.CC_TENANT_NAME
  delete process.env.CC_TENANT_ROLE

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  projectRoot = path.join(tmpdir(), `cc-assign-api-${suffix}`)
  auditDir = path.join(tmpdir(), `cc-assign-audit-${suffix}`)
  port = pickEphemeralPort()
  await mkdir(projectRoot, { recursive: true })
  await mkdir(auditDir, { recursive: true })
  await writeEmployeeConfig(projectRoot)
  process.env.CC_DAEMON_AUDIT_DIR = auditDir

  daemon = await startDaemon({
    projectRoot,
    port,
    graceMs: 500,
    cliBundlePath: path.join(projectRoot, 'does-not-exist-cli.js'),
    once: false,
    auditDir,
  })
})

afterEach(async () => {
  if (daemon) {
    await stopDaemon(daemon, 'test-cleanup')
    daemon = null
  }
  await rm(projectRoot, { recursive: true, force: true })
  await rm(auditDir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('POST /v1/employee/assign', () => {
  test('default tenant (no headers, no env) → 202 with admin stamp', async () => {
    const { status, body } = await post(`http://127.0.0.1:${port}/v1/employee/assign`, {
      assignment: 'investigate flaky CI',
    })
    expect(status).toBe(202)
    expect(body.status).toBe('accepted')
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.correlationId).toBe(body.id)
    expect(body.tenant).toEqual({ id: 'default', name: 'Default Tenant', role: 'admin' })

    const entries = await readAllAuditEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe(ASSIGNMENT_AUDIT_KIND)
    expect(entries[0]!.assignmentId).toBe(body.id)
    expect(entries[0]!.assignment).toBe('investigate flaky CI')
    expect(entries[0]!.source).toBe('http.v1')
    expect(entries[0]!.tenant).toEqual({
      id: 'default',
      name: 'Default Tenant',
      role: 'admin',
    })
  })

  test('developer-role header → 202 and audit stamps the header tenant', async () => {
    const { status, body } = await post(
      `http://127.0.0.1:${port}/v1/employee/assign`,
      { assignment: 'ship the thing' },
      {
        headers: {
          'x-tenant-id': 'acme',
          'x-tenant-name': 'Acme Corp',
          'x-tenant-role': 'developer',
        },
      },
    )
    expect(status).toBe(202)
    expect(body.tenant).toEqual({ id: 'acme', name: 'Acme Corp', role: 'developer' })

    const entries = await readAllAuditEntries()
    expect(entries[0]!.tenant).toEqual({
      id: 'acme',
      name: 'Acme Corp',
      role: 'developer',
    })
  })

  test('viewer-role header → 403 and no audit entry is written', async () => {
    const { status, body } = await post(
      `http://127.0.0.1:${port}/v1/employee/assign`,
      { assignment: 'peek only' },
      {
        headers: { 'x-tenant-id': 'readonly', 'x-tenant-role': 'viewer' },
      },
    )
    expect(status).toBe(403)
    expect(body.error).toContain('viewer')
    expect(body.error).toContain('developer or admin')
    expect(body.tenant).toEqual({ id: 'readonly', role: 'viewer' })

    const entries = await readAllAuditEntries()
    expect(entries).toHaveLength(0)
  })

  test('GET returns 405', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/employee/assign`)
    expect(res.status).toBe(405)
    const body = await res.json()
    expect(body.error).toBe('method_not_allowed')
  })

  test('non-JSON content-type → 415', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/employee/assign`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'assignment=x',
    })
    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.error).toContain('application/json')
  })

  test('empty body → 400 empty_body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/employee/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('empty_body')
  })

  test('invalid JSON → 400 invalid_json', async () => {
    const { status, body } = await post(
      `http://127.0.0.1:${port}/v1/employee/assign`,
      '{ not json',
    )
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_json')
  })

  test('missing assignment field → 400', async () => {
    const { status, body } = await post(
      `http://127.0.0.1:${port}/v1/employee/assign`,
      { something: 'else' },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('assignment_field_required')
  })

  test('whitespace-only assignment → 400 assignment_empty', async () => {
    const { status, body } = await post(
      `http://127.0.0.1:${port}/v1/employee/assign`,
      { assignment: '   \n\t ' },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('assignment_empty')
  })

  test('body over 4 KB → 413', async () => {
    const huge = 'x'.repeat(5000)
    const { status, body } = await post(
      `http://127.0.0.1:${port}/v1/employee/assign`,
      { assignment: huge },
    )
    expect(status).toBe(413)
    expect(String(body.error)).toContain('body_too_large')
  })

  test('two concurrent requests with different tenants land with correct audit stamps', async () => {
    const [a, b] = await Promise.all([
      post(
        `http://127.0.0.1:${port}/v1/employee/assign`,
        { assignment: 'work for acme' },
        {
          headers: { 'x-tenant-id': 'acme', 'x-tenant-role': 'developer' },
        },
      ),
      post(
        `http://127.0.0.1:${port}/v1/employee/assign`,
        { assignment: 'work for globex' },
        {
          headers: { 'x-tenant-id': 'globex', 'x-tenant-role': 'developer' },
        },
      ),
    ])
    expect(a.status).toBe(202)
    expect(b.status).toBe(202)

    const entries = await readAllAuditEntries()
    expect(entries).toHaveLength(2)
    const byId = Object.fromEntries(
      entries.map(e => [
        e.assignmentId as string,
        (e.tenant as { id: string }).id,
      ]),
    )
    expect(byId[a.body.id]).toBe('acme')
    expect(byId[b.body.id]).toBe('globex')
  })

  test('during drain, new requests are refused with 503', async () => {
    // The real stopDaemon races server.close() against test fetch — with
    // zero in-flight duties it closes the port too fast to observe the
    // drain window from the client side. So we flip the flag directly on
    // DaemonState (the handler reads it on every request) to pin the
    // "daemon is draining" precondition, make the assertion, then let
    // afterEach's stopDaemon run as normal.
    daemon!.shuttingDown = true
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/employee/assign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignment: 'should be refused' }),
      })
      expect(res.status).toBe(503)
      expect((await res.json()).error).toBe('draining')
    } finally {
      daemon!.shuttingDown = false
    }
  })
})
