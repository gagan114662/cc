import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { setProjectRoot } from 'src/bootstrap/state.js'
import {
  loadUsageLedger,
  postStripeBillingHook,
  recordUsageFromContext,
} from 'src/services/billing/usageLedger.js'
import type { TenantContext } from 'src/services/tenant/tenantContext.js'

let projectRoot: string
const originalProjectRoot = process.cwd()

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

beforeEach(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  projectRoot = path.join(tmpdir(), `cc-billing-${suffix}`)
  await mkdir(projectRoot, { recursive: true })
  setProjectRoot(projectRoot)
})

afterEach(async () => {
  setProjectRoot(originalProjectRoot)
  await rm(projectRoot, { recursive: true, force: true })
})

describe('billing usage ledger', () => {
  test('records tenant-scoped duty usage with stable subject attribution', () => {
    const tenant: TenantContext = { id: 'acme', name: 'Acme', role: 'developer' }
    const usage = {
      input_tokens: 123,
      output_tokens: 45,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
      server_tool_use: { web_search_requests: 2 },
    } as BetaUsage

    const record = recordUsageFromContext({
      usage,
      model: 'claude-opus',
      costUSD: 1.25,
      tenant,
      dutyId: 'duty-123',
    })

    expect(record.subjectKind).toBe('duty')
    expect(record.subjectId).toBe('duty-123')

    const stored = loadUsageLedger(projectRoot, 'acme')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.tenantId).toBe('acme')
    expect(stored[0]!.costUSD).toBe(1.25)
    expect(stored[0]!.webSearchRequests).toBe(2)
  })

  test('posts billing usage to the configured Stripe-compatible webhook', async () => {
    const seen: unknown[] = []
    const server = createServer(async (req, res) => {
      const body = await readJsonBody(req)
      seen.push({
        auth: req.headers.authorization ?? null,
        body,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0

    try {
      const result = await postStripeBillingHook(
        {
          ts: '2026-04-20T12:00:00.000Z',
          tenantId: 'acme',
          subjectKind: 'assignment',
          subjectId: 'asg-1',
          sessionId: 'session-1',
          model: 'claude-sonnet',
          costUSD: 0.42,
          inputTokens: 11,
          outputTokens: 9,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
        },
        {
          url: `http://127.0.0.1:${port}/stripe`,
          apiKey: 'sk_test_123',
        },
      )

      expect(result.delivered).toBe(true)
      expect(result.status).toBe(200)
      expect(seen).toHaveLength(1)
      expect((seen[0] as any).auth).toBe('Bearer sk_test_123')
      expect((seen[0] as any).body.type).toBe('cc.usage_record.created')
      expect((seen[0] as any).body.data.object.payload.tenant_id).toBe('acme')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
