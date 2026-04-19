// HMAC-SHA256 signature verification for inbound webhooks.
//
// GitHub/Slack both sign their webhook payloads with HMAC-SHA256 of
// the raw request body (plus a timestamp for Slack). Verification has
// to be:
//   - constant-time (timing-safe) to prevent byte-by-byte recovery
//   - tolerant of the "sha256=" prefix GitHub uses
//   - strict about the hex/length of the incoming signature so we
//     don't silently accept a malformed one
//
// Contract pinned here applies to both producers; the GitHub route
// wires this helper in, Slack follows in a later slice.

import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { verifyHmacSignature } from 'src/services/webhooks/signatureVerification.js'

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyHmacSignature', () => {
  test('accepts a signature produced by the same secret', () => {
    const body = JSON.stringify({ event: 'ping' })
    const sig = sign(body, 'shh')
    expect(verifyHmacSignature({ body, secret: 'shh', signature: sig })).toBe(true)
  })

  test('rejects a signature produced by a different secret', () => {
    const body = JSON.stringify({ event: 'ping' })
    const sig = sign(body, 'wrong-secret')
    expect(verifyHmacSignature({ body, secret: 'shh', signature: sig })).toBe(false)
  })

  test('rejects when the body is mutated even by one byte', () => {
    const body = JSON.stringify({ event: 'ping' })
    const sig = sign(body, 'shh')
    const tampered = body.replace('ping', 'pong')
    expect(verifyHmacSignature({ body: tampered, secret: 'shh', signature: sig })).toBe(false)
  })

  test('accepts signatures with and without the "sha256=" prefix', () => {
    const body = 'hello'
    const withPrefix = sign(body, 'shh')
    const withoutPrefix = withPrefix.replace(/^sha256=/, '')
    expect(verifyHmacSignature({ body, secret: 'shh', signature: withPrefix })).toBe(true)
    expect(verifyHmacSignature({ body, secret: 'shh', signature: withoutPrefix })).toBe(true)
  })

  test('rejects a malformed signature (wrong length) without throwing', () => {
    // timingSafeEqual throws if buffers differ in length — the helper
    // has to guard against that so a short/garbage signature becomes a
    // clean false, not an unhandled crash on the HTTP path.
    expect(
      verifyHmacSignature({ body: 'x', secret: 'shh', signature: 'sha256=deadbeef' }),
    ).toBe(false)
    expect(
      verifyHmacSignature({ body: 'x', secret: 'shh', signature: '' }),
    ).toBe(false)
    expect(
      verifyHmacSignature({
        body: 'x',
        secret: 'shh',
        signature: 'sha256=not-hex-really',
      }),
    ).toBe(false)
  })

  test('rejects when the signature is missing', () => {
    expect(
      verifyHmacSignature({ body: 'x', secret: 'shh', signature: undefined }),
    ).toBe(false)
  })

  // Slack signs `v0:<ts>:<body>` and ships the header as `v0=<hex>`.
  // The verifier has to handle that scheme prefix in addition to
  // GitHub's `sha256=`. We exercise both so the Slack route can
  // reuse this primitive without a bespoke path.
  test('accepts Slack-style v0= prefix when the signed body matches', () => {
    const ts = '1700000000'
    const raw = '{"type":"url_verification"}'
    const signedBase = `v0:${ts}:${raw}`
    const mac = createHmac('sha256', 'slack-secret').update(signedBase).digest('hex')
    expect(
      verifyHmacSignature({
        body: signedBase,
        secret: 'slack-secret',
        signature: `v0=${mac}`,
      }),
    ).toBe(true)
  })

  test('rejects a Slack-style signature when the timestamp in the base is swapped', () => {
    const raw = '{"type":"url_verification"}'
    const realBase = `v0:1700000000:${raw}`
    const mac = createHmac('sha256', 'slack-secret').update(realBase).digest('hex')
    // Attacker resubmits a different timestamp with the old mac — the
    // base string changes, so the HMAC mismatches.
    const replayedBase = `v0:1700000999:${raw}`
    expect(
      verifyHmacSignature({
        body: replayedBase,
        secret: 'slack-secret',
        signature: `v0=${mac}`,
      }),
    ).toBe(false)
  })
})
