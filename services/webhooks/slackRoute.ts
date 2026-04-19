// POST /v1/webhooks/slack — HMAC-verified inbound producer for the
// assignment queue (Phase 3 item 1, Slack slice).
//
// Slack signs every request with X-Slack-Signature over the canonical
// base string `v0:<X-Slack-Request-Timestamp>:<raw-body>`. Replay is
// prevented by rejecting requests whose timestamp skews more than 5
// minutes from our clock (Slack's own recommended window — any wider
// and a leaked signature becomes indefinitely replayable).
//
// Events we translate to assignments:
//   - url_verification         — handshake; echo the challenge field
//   - event_callback/app_mention — translate to a triage assignment
// Everything else → 202 ignored, no enqueue. Slack slash commands are
// a separate content-type (x-www-form-urlencoded) and are out of
// scope for this slice; we'll add them in a follow-up.
//
// Enqueues to DEFAULT_TENANT for now. Per-team (Slack team_id) to
// tenant mapping is a follow-up; the shared secret scopes which Slack
// workspace this endpoint accepts.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { enqueueAssignment } from '../assignmentQueue/storage.js'
import { DEFAULT_TENANT } from '../tenant/tenantContext.js'
import { verifyHmacSignature } from './signatureVerification.js'

export const SLACK_WEBHOOK_ROUTE = '/v1/webhooks/slack'
export const SLACK_WEBHOOK_BODY_MAX_BYTES = 1024 * 1024
export const SLACK_TIMESTAMP_SKEW_SEC = 5 * 60

export type HandleSlackWebhookOptions = {
  projectRoot?: string
  secret: string
  idFactory?: () => string
  now?: () => Date
}

type RawBody = { kind: 'ok'; text: string } | { kind: 'too_large' }

async function readBody(req: IncomingMessage): Promise<RawBody> {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > SLACK_WEBHOOK_BODY_MAX_BYTES) {
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

type Translation =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'queue'; event: string; assignment: string }
  | { kind: 'ignore'; event: string }

function translatePayload(payload: unknown): Translation {
  const body = (payload ?? {}) as Record<string, unknown>
  const topType = typeof body.type === 'string' ? body.type : 'unknown'

  if (topType === 'url_verification') {
    const challenge = typeof body.challenge === 'string' ? body.challenge : ''
    return { kind: 'challenge', challenge }
  }

  if (topType === 'event_callback') {
    const event = (body.event ?? {}) as Record<string, unknown>
    const eventType = typeof event.type === 'string' ? event.type : 'unknown'

    if (eventType === 'app_mention') {
      const user = typeof event.user === 'string' ? event.user : 'unknown'
      const channel = typeof event.channel === 'string' ? event.channel : 'unknown'
      const text = typeof event.text === 'string' ? event.text : ''
      const assignment = [
        `Triage Slack mention in channel ${channel} from user ${user}:`,
        text,
      ].join('\n')
      return { kind: 'queue', event: 'app_mention', assignment }
    }

    return { kind: 'ignore', event: eventType }
  }

  return { kind: 'ignore', event: topType }
}

export async function handleSlackWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HandleSlackWebhookOptions,
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

  const ts = headerString(req.headers, 'x-slack-request-timestamp')
  const signature = headerString(req.headers, 'x-slack-signature')

  // Replay guard: check timestamp *before* HMAC work so a stream of
  // stale replays can't pin CPU. Missing/non-numeric timestamp is
  // treated the same as a stale one — we cannot prove freshness.
  const tsNum = ts !== undefined ? Number(ts) : NaN
  if (!Number.isFinite(tsNum)) {
    writeJson(res, 401, { error: 'invalid_signature' })
    return
  }
  const nowSec = Math.floor((opts.now ?? (() => new Date()))().getTime() / 1000)
  if (Math.abs(nowSec - tsNum) > SLACK_TIMESTAMP_SKEW_SEC) {
    writeJson(res, 401, { error: 'invalid_signature' })
    return
  }

  // Slack's signed base: `v0:<ts>:<raw-body>`. The verifier strips the
  // `v0=` scheme from the header and timing-safe-compares the remainder.
  const signedBase = `v0:${ts}:${raw.text}`
  const ok = verifyHmacSignature({
    body: signedBase,
    secret: opts.secret,
    signature,
  })
  if (!ok) {
    writeJson(res, 401, { error: 'invalid_signature' })
    return
  }

  let payload: unknown = {}
  try {
    payload = raw.text.length ? JSON.parse(raw.text) : {}
  } catch {
    writeJson(res, 400, { error: 'invalid_json' })
    return
  }

  const translation = translatePayload(payload)

  if (translation.kind === 'challenge') {
    // Slack expects the challenge echoed verbatim so it can confirm
    // this endpoint owns the URL it was configured with.
    writeJson(res, 200, { challenge: translation.challenge })
    return
  }

  if (translation.kind === 'ignore') {
    writeJson(res, 202, { status: 'ignored', event: translation.event })
    return
  }

  const id = (opts.idFactory ?? randomUUID)()
  await enqueueAssignment(
    { id, assignment: translation.assignment },
    { projectRoot: opts.projectRoot, tenantId: DEFAULT_TENANT.id },
  )

  writeJson(res, 202, { id, status: 'queued', event: translation.event })
}
