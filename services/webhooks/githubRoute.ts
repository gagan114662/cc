// POST /v1/webhooks/github — HMAC-verified inbound producer for the
// assignment queue (Phase 3 item 1).
//
// Why this exists: the durable queue from Phase 2 item 3 is the right
// landing zone for external producers. GitHub signs every delivery
// with HMAC-SHA256 over the raw body (X-Hub-Signature-256), which we
// verify before touching the queue. A tampered payload must not hit
// the queue even once — the audit trail would lie otherwise.
//
// Event handling:
//   - ping                                  → 200 {pong:true}, no enqueue
//   - pull_request.{opened,synchronize,ready_for_review}
//                                           → 202 queued, assignment
//                                             includes repo, #<num>, title
//   - pull_request.<other>                  → 202 ignored
//   - issues.opened                         → 202 queued, assignment
//                                             includes issue #<num>, title
//   - push to default branch                → 202 queued
//   - unknown X-GitHub-Event                → 202 ignored
//
// Tenant: enqueues to DEFAULT_TENANT for now. Per-installation →
// tenant mapping is a follow-up; the signature secret itself already
// scopes which installations this endpoint accepts.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { getQueueBackend } from '../assignmentQueue/backend.js'
import { DEFAULT_TENANT } from '../tenant/tenantContext.js'
import { verifyHmacSignature } from './signatureVerification.js'

export const GITHUB_WEBHOOK_ROUTE = '/v1/webhooks/github'
export const GITHUB_WEBHOOK_BODY_MAX_BYTES = 1024 * 1024 // 1 MB — GitHub payloads fit comfortably

export type HandleGithubWebhookOptions = {
  projectRoot?: string
  secret: string
  idFactory?: () => string
}

type RawBody = { kind: 'ok'; text: string } | { kind: 'too_large' }

async function readBody(req: IncomingMessage): Promise<RawBody> {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > GITHUB_WEBHOOK_BODY_MAX_BYTES) {
      overflow = true
      continue
    }
    if (!overflow) chunks.push(buf)
  }
  if (overflow) return { kind: 'too_large' }
  return { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') }
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function headerString(
  headers: IncomingMessage['headers'],
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()]
  if (v === undefined) return undefined
  return Array.isArray(v) ? v[0] : v
}

// Actions we treat as actionable for a pull_request event. Everything
// else (closed-without-merge, labeled, assigned, …) is noise for a
// duty trigger — ignoring here keeps the queue signal-dense.
const ACTIONABLE_PR_ACTIONS = new Set([
  'opened',
  'synchronize',
  'ready_for_review',
  'reopened',
])

type Translation =
  | { kind: 'queue'; event: string; assignment: string }
  | { kind: 'ignore'; event: string }
  | { kind: 'pong' }

function translateEvent(event: string, payload: unknown): Translation {
  if (event === 'ping') return { kind: 'pong' }

  const body = (payload ?? {}) as Record<string, unknown>
  const action = typeof body.action === 'string' ? body.action : undefined
  const repo = (body.repository ?? {}) as Record<string, unknown>
  const repoFullName =
    typeof repo.full_name === 'string' ? repo.full_name : 'unknown/repo'

  if (event === 'pull_request') {
    if (!action || !ACTIONABLE_PR_ACTIONS.has(action)) {
      return { kind: 'ignore', event: `pull_request.${action ?? 'unknown'}` }
    }
    const pr = (body.pull_request ?? {}) as Record<string, unknown>
    const num = typeof pr.number === 'number' ? pr.number : 0
    const title = typeof pr.title === 'string' ? pr.title : '(no title)'
    const url = typeof pr.html_url === 'string' ? pr.html_url : ''
    const user = (pr.user ?? {}) as Record<string, unknown>
    const login = typeof user.login === 'string' ? user.login : 'unknown'
    const assignment = [
      `Review pull request #${num} in ${repoFullName}: ${title}`,
      `Author: @${login}`,
      url,
    ]
      .filter(Boolean)
      .join('\n')
    return { kind: 'queue', event: `pull_request.${action}`, assignment }
  }

  if (event === 'issues') {
    if (action !== 'opened') {
      return { kind: 'ignore', event: `issues.${action ?? 'unknown'}` }
    }
    const issue = (body.issue ?? {}) as Record<string, unknown>
    const num = typeof issue.number === 'number' ? issue.number : 0
    const title = typeof issue.title === 'string' ? issue.title : '(no title)'
    const url = typeof issue.html_url === 'string' ? issue.html_url : ''
    const user = (issue.user ?? {}) as Record<string, unknown>
    const login = typeof user.login === 'string' ? user.login : 'unknown'
    const assignment = [
      `Triage issue #${num} in ${repoFullName}: ${title}`,
      `Reporter: @${login}`,
      url,
    ]
      .filter(Boolean)
      .join('\n')
    return { kind: 'queue', event: 'issues.opened', assignment }
  }

  if (event === 'push') {
    const ref = typeof body.ref === 'string' ? body.ref : ''
    const defaultBranch =
      typeof repo.default_branch === 'string' ? repo.default_branch : 'main'
    if (ref !== `refs/heads/${defaultBranch}`) {
      return { kind: 'ignore', event: 'push' }
    }
    const assignment = `Inspect push to ${repoFullName}@${defaultBranch}`
    return { kind: 'queue', event: 'push', assignment }
  }

  return { kind: 'ignore', event }
}

export async function handleGithubWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HandleGithubWebhookOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  const raw = await readBody(req)
  if (raw.kind === 'too_large') {
    writeJson(res, 413, { error: 'body_too_large' })
    return
  }

  const signature = headerString(req.headers, 'x-hub-signature-256')
  const ok = verifyHmacSignature({
    body: raw.text,
    secret: opts.secret,
    signature,
  })
  if (!ok) {
    writeJson(res, 401, { error: 'invalid_signature' })
    return
  }

  const event = headerString(req.headers, 'x-github-event') ?? 'unknown'

  let payload: unknown = {}
  try {
    payload = raw.text.length ? JSON.parse(raw.text) : {}
  } catch {
    writeJson(res, 400, { error: 'invalid_json' })
    return
  }

  const translation = translateEvent(event, payload)

  if (translation.kind === 'pong') {
    writeJson(res, 200, { pong: true })
    return
  }

  if (translation.kind === 'ignore') {
    writeJson(res, 202, { status: 'ignored', event: translation.event })
    return
  }

  const id = (opts.idFactory ?? randomUUID)()
  const backend = await getQueueBackend()
  await backend.enqueue(
    { id, assignment: translation.assignment },
    { projectRoot: opts.projectRoot, tenantId: DEFAULT_TENANT.id },
  )

  writeJson(res, 202, { id, status: 'queued', event: translation.event })
}
