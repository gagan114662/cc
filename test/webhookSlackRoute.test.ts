// POST /v1/webhooks/slack — HMAC-verified inbound producer for the
// assignment queue (Phase 3 item 1, Slack slice).
//
// Contract pinned here:
//   - Missing/bad signature → 401 before any enqueue
//   - Stale timestamp (>5 min skew either direction) → 401 (replay guard)
//   - url_verification handshake → 200 with the `challenge` echoed back,
//     no enqueue. This is how Slack proves the endpoint is live.
//   - event_callback with app_mention → 202 queued, assignment carries
//     the channel, user, and text
//   - event_callback with unsupported nested type → 202 ignored
//   - Unknown top-level type → 202 ignored
//
// We test the route without a real HTTP server by driving
// IncomingMessage/ServerResponse against a pair of sockets — matches
// the pattern used by webhookGithubRoute.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  SLACK_WEBHOOK_ROUTE,
  handleSlackWebhookRequest,
} from 'src/services/webhooks/slackRoute.js'
import { loadAssignmentQueue } from 'src/services/assignmentQueue/storage.js'
import { DEFAULT_TENANT } from 'src/services/tenant/tenantContext.js'

let projectRoot: string
const SECRET = 'slack-test-secret'
// Pinned "now" — all test requests sign with timestamps relative to this,
// and the route is given a matching clock so skew is deterministic.
const FIXED_NOW_MS = 1700000000_000
const FIXED_TS = String(Math.floor(FIXED_NOW_MS / 1000))

beforeEach(async () => {
  projectRoot = path.join(
    tmpdir(),
    `cc-slack-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(projectRoot, { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

function slackSign(ts: string, body: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')
  return `v0=${mac}`
}

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
  req.url = SLACK_WEBHOOK_ROUTE
  req.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
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
    return origEnd() as ServerResponse
  }) as typeof res.end

  return { req, res, captured }
}

async function drive(body: string, headers: Record<string, string>) {
  const { req, res, captured } = mockReqRes({ body, headers })
  await handleSlackWebhookRequest(req, res, {
    projectRoot,
    secret: SECRET,
    now: () => new Date(FIXED_NOW_MS),
  })
  return captured
}

describe('POST /v1/webhooks/slack', () => {
  test('rejects with 401 when signature is missing', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' })
    const captured = await drive(body, { 'x-slack-request-timestamp': FIXED_TS })
    expect(captured.status).toBe(401)
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
  })

  test('rejects with 401 when signature is for a different body', async () => {
    const body = JSON.stringify({ type: 'event_callback' })
    const sigForOther = slackSign(FIXED_TS, 'not-this-body', SECRET)
    const captured = await drive(body, {
      'x-slack-request-timestamp': FIXED_TS,
      'x-slack-signature': sigForOther,
    })
    expect(captured.status).toBe(401)
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
  })

  test('rejects with 401 when timestamp is older than 5 minutes', async () => {
    // Exactly 5m1s behind the pinned clock — replay guard must bite.
    const staleTs = String(Math.floor(FIXED_NOW_MS / 1000) - (5 * 60 + 1))
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' })
    const captured = await drive(body, {
      'x-slack-request-timestamp': staleTs,
      'x-slack-signature': slackSign(staleTs, body, SECRET),
    })
    expect(captured.status).toBe(401)
  })

  test('url_verification handshake: 200 with challenge echo, no enqueue', async () => {
    const body = JSON.stringify({
      type: 'url_verification',
      challenge: 'handshake-nonce-xyz',
    })
    const captured = await drive(body, {
      'x-slack-request-timestamp': FIXED_TS,
      'x-slack-signature': slackSign(FIXED_TS, body, SECRET),
    })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ challenge: 'handshake-nonce-xyz' })
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
  })

  test('app_mention: 202 queued, assignment captures channel/user/text', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event: {
        type: 'app_mention',
        user: 'U42',
        text: '<@U999> please investigate the flaky build job',
        channel: 'C_BUILDS',
        ts: '1700000000.123456',
      },
    })
    const captured = await drive(body, {
      'x-slack-request-timestamp': FIXED_TS,
      'x-slack-signature': slackSign(FIXED_TS, body, SECRET),
    })
    expect(captured.status).toBe(202)
    const parsed = JSON.parse(captured.body)
    expect(parsed.status).toBe('queued')
    expect(typeof parsed.id).toBe('string')
    expect(parsed.event).toBe('app_mention')

    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue.length).toBe(1)
    expect(queue[0]!.id).toBe(parsed.id)
    expect(queue[0]!.assignment).toContain('C_BUILDS')
    expect(queue[0]!.assignment).toContain('U42')
    expect(queue[0]!.assignment).toContain('investigate the flaky build job')
  })

  test('event_callback with unsupported nested type: 202 ignored, no enqueue', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'reaction_added', user: 'U42', reaction: 'eyes' },
    })
    const captured = await drive(body, {
      'x-slack-request-timestamp': FIXED_TS,
      'x-slack-signature': slackSign(FIXED_TS, body, SECRET),
    })
    expect(captured.status).toBe(202)
    const parsed = JSON.parse(captured.body)
    expect(parsed.status).toBe('ignored')
    expect(parsed.event).toBe('reaction_added')
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
  })

  test('unknown top-level type: 202 ignored, no enqueue', async () => {
    const body = JSON.stringify({ type: 'block_actions', actions: [] })
    const captured = await drive(body, {
      'x-slack-request-timestamp': FIXED_TS,
      'x-slack-signature': slackSign(FIXED_TS, body, SECRET),
    })
    expect(captured.status).toBe(202)
    const parsed = JSON.parse(captured.body)
    expect(parsed.status).toBe('ignored')
    expect(parsed.event).toBe('block_actions')
    const queue = await loadAssignmentQueue(projectRoot, DEFAULT_TENANT.id)
    expect(queue).toEqual([])
  })
})
