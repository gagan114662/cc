// POST /v1/webhooks/github — HMAC-verified inbound producer for the
// assignment queue (Phase 3 item 1).
//
// Contract pinned here:
//   - Missing or bad signature → 401 before any enqueue happens
//     (a tampered payload must not hit the queue even once)
//   - Unknown event (X-GitHub-Event header not in the allowlist) →
//     202 with a "ignored" body, no enqueue
//   - Supported event (pull_request.opened, issues.opened, push to
//     default branch) → 202, enqueue with a readable assignment
//     string derived from the event payload
//   - Ping event (GitHub's setup probe) → 200 pong, no enqueue
//   - Response body shape: { id, status, event } on accept so the
//     sender can correlate a delivery to a queued assignment

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { readAuditTail } from 'src/services/audit/durableAuditLog.js'
import {
  GITHUB_WEBHOOK_ROUTE,
  GITHUB_WEBHOOK_IGNORED_AUDIT_KIND,
  GITHUB_WEBHOOK_QUEUED_AUDIT_KIND,
  handleGithubWebhookRequest,
} from 'src/services/webhooks/githubRoute.js'
import { loadAssignmentQueue } from 'src/services/assignmentQueue/storage.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'

let projectRoot: string
let auditDir: string
const SECRET = 'test-secret'

beforeEach(async () => {
  projectRoot = path.join(
    tmpdir(),
    `cc-webhook-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  auditDir = path.join(
    tmpdir(),
    `cc-webhook-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(projectRoot, { recursive: true })
  await mkdir(auditDir, { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(auditDir, { recursive: true, force: true })
})

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

// Bun's test env doesn't expose a cheap way to spin up an HTTP server
// per test. handleGithubWebhookRequest is written to work against
// IncomingMessage/ServerResponse directly, and we synthesize both
// against a pair of Socket objects. Matches the pattern used by the
// /employee/assign tests earlier in Phase 2.
function mockReqRes(opts: {
  body: string
  headers?: Record<string, string>
}): {
  req: IncomingMessage
  res: ServerResponse
  captured: { status: number | null; body: string }
} {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = 'POST'
  req.url = GITHUB_WEBHOOK_ROUTE
  req.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  // Push the body then EOF so `for await (const c of req)` drains it.
  process.nextTick(() => {
    req.push(opts.body)
    req.push(null)
  })

  const captured = { status: null as number | null, body: '' }
  const res = new ServerResponse(req)
  res.assignSocket(new Socket())
  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    captured.status = status
    return origWriteHead(status, ...(rest as []))
  }) as typeof res.writeHead
  const origEnd = res.end.bind(res)
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === 'string') captured.body = chunk
    else if (Buffer.isBuffer(chunk)) captured.body = chunk.toString('utf8')
    return origEnd()
  }) as typeof res.end

  return { req, res, captured }
}

async function drive(body: string, headers: Record<string, string>) {
  const { req, res, captured } = mockReqRes({ body, headers })
  await handleGithubWebhookRequest(req, res, {
    projectRoot,
    secret: SECRET,
    auditDir,
  })
  return captured
}

describe('POST /v1/webhooks/github', () => {
  test('rejects with 401 when signature is missing', async () => {
    const body = JSON.stringify({ zen: 'anything' })
    const captured = await drive(body, { 'x-github-event': 'ping' })
    expect(captured.status).toBe(401)

    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
  })

  test('rejects with 401 when signature is for a different body', async () => {
    const body = JSON.stringify({ action: 'opened' })
    const sigForOther = sign('not-this-body', SECRET)
    const captured = await drive(body, {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sigForOther,
    })
    expect(captured.status).toBe(401)
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
  })

  test('ping event: returns 200 pong, enqueues nothing', async () => {
    const body = JSON.stringify({ zen: 'Non-blocking is better than blocking.' })
    const captured = await drive(body, {
      'x-github-event': 'ping',
      'x-hub-signature-256': sign(body, SECRET),
    })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ pong: true })
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
  })

  test('unknown event: 202 with "ignored", no enqueue', async () => {
    const body = JSON.stringify({ action: 'some_action' })
    const captured = await drive(body, {
      'x-github-event': 'marketplace_purchase',
      'x-hub-signature-256': sign(body, SECRET),
    })
    expect(captured.status).toBe(202)
    const parsed = JSON.parse(captured.body)
    expect(parsed.status).toBe('ignored')
    expect(parsed.event).toBe('marketplace_purchase')
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
    const audit = readAuditTail(10, { dir: auditDir })
    expect(audit.at(-1)?.kind).toBe(GITHUB_WEBHOOK_IGNORED_AUDIT_KIND)
  })

  test('pull_request.opened: enqueues readable assignment', async () => {
    const body = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 42,
        title: 'Fix widget rendering',
        html_url: 'https://github.com/acme/repo/pull/42',
        user: { login: 'alice' },
      },
      repository: { full_name: 'acme/repo' },
    })
    const captured = await drive(body, {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body, SECRET),
    })
    expect(captured.status).toBe(202)
    const parsed = JSON.parse(captured.body)
    expect(parsed.status).toBe('queued')
    expect(typeof parsed.id).toBe('string')
    expect(parsed.event).toBe('pull_request.opened')

    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue.length).toBe(1)
    expect(queue[0].id).toBe(parsed.id)
    // Assignment should include enough signal for the engineering-lead
    // agent to act: repo, PR number, and title at minimum.
    expect(queue[0].assignment).toContain('acme/repo')
    expect(queue[0].assignment).toContain('#42')
    expect(queue[0].assignment).toContain('Fix widget rendering')
    const audit = readAuditTail(10, { dir: auditDir })
    expect(audit.at(-1)?.kind).toBe(GITHUB_WEBHOOK_QUEUED_AUDIT_KIND)
    expect(audit.at(-1)?.assignmentId).toBe(parsed.id)
  })

  test('pull_request.closed (merged=false): 202 ignored, no enqueue', async () => {
    // We only enqueue on actions that are actionable. Closed-without-merge
    // is noise — it would fire a duty for every PR cleanup.
    const body = JSON.stringify({
      action: 'closed',
      pull_request: { number: 1, merged: false, title: 't' },
      repository: { full_name: 'acme/repo' },
    })
    const captured = await drive(body, {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body, SECRET),
    })
    expect(captured.status).toBe(202)
    const parsed = JSON.parse(captured.body)
    expect(parsed.status).toBe('ignored')
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
  })

  test('issues.opened: enqueues with issue-flavored prompt', async () => {
    const body = JSON.stringify({
      action: 'opened',
      issue: {
        number: 7,
        title: 'Thumbnails stretched on Safari',
        html_url: 'https://github.com/acme/repo/issues/7',
        user: { login: 'bob' },
      },
      repository: { full_name: 'acme/repo' },
    })
    const captured = await drive(body, {
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body, SECRET),
    })
    expect(captured.status).toBe(202)
    const parsed = JSON.parse(captured.body)
    expect(parsed.event).toBe('issues.opened')

    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue.length).toBe(1)
    expect(queue[0].assignment).toContain('issue #7')
    expect(queue[0].assignment).toContain('Thumbnails stretched on Safari')
  })
})
