// HMAC-SHA256 signature verification for inbound webhooks (Phase 3 item 1).
//
// GitHub's X-Hub-Signature-256 header is `sha256=<hex>` of HMAC-SHA256
// over the raw request body using the shared secret. Slack's
// X-Slack-Signature is `v0=<hex>` of `v0:<ts>:<body>`. This helper
// handles the GitHub shape directly and is composable for Slack — the
// Slack route computes the timestamped body and feeds it in as `body`.
//
// Why a dedicated module: timing-safe compare plus length/shape guards
// need to be in one place so every producer (GitHub now, Slack next,
// Linear later) uses the same vetted primitive.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type VerifyHmacInput = {
  body: string
  secret: string
  signature: string | undefined
}

const SHA256_HEX_LEN = 64 // HMAC-SHA256 produces 32 bytes = 64 hex chars

function stripPrefix(sig: string): string {
  // GitHub prefixes with "sha256=", some tools double-quote, and a few
  // stray whitespace-padded examples exist in the wild — normalize
  // aggressively because signatures that "almost match" are bugs, not
  // attacks, and we want to stay strict on the underlying bytes.
  let s = sig.trim()
  if (s.startsWith('sha256=')) s = s.slice('sha256='.length)
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  return s
}

function isHex64(candidate: string): boolean {
  return candidate.length === SHA256_HEX_LEN && /^[0-9a-fA-F]+$/.test(candidate)
}

export function verifyHmacSignature(input: VerifyHmacInput): boolean {
  if (!input.signature) return false
  const candidate = stripPrefix(input.signature)
  if (!isHex64(candidate)) return false

  const expected = createHmac('sha256', input.secret)
    .update(input.body)
    .digest('hex')

  // timingSafeEqual requires equal-length buffers. We've already
  // length-checked candidate above, but defensive length equality
  // keeps a mismatched expected (future hash swap) from throwing.
  const a = Buffer.from(candidate, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
