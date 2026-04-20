import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  dispatchConfiguredOperationalAlerts,
  dispatchOperationalAlert,
  loadAlertDeliveries,
} from 'src/services/alerting/dispatcher.js'
import type { TenantContext } from 'src/services/tenant/tenantContext.js'

let projectRoot: string

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

beforeEach(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  projectRoot = path.join(tmpdir(), `cc-alerting-${suffix}`)
  await mkdir(projectRoot, { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('operational alert dispatcher', () => {
  test('delivers PagerDuty-formatted alerts and records the result', async () => {
    const seen: unknown[] = []
    const server = createServer(async (req, res) => {
      const body = await readJsonBody(req)
      seen.push(body)
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'accepted' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0

    try {
      const tenant: TenantContext = {
        id: 'acme',
        name: 'Acme',
        role: 'developer',
      }
      const delivery = await dispatchOperationalAlert(
        {
          provider: 'pagerduty',
          severity: 'critical',
          summary: 'Duty failed',
          source: 'daemon.duty',
          dedupeKey: 'daemon.duty:acme:duty-1',
        },
        {
          tenant,
          projectRoot,
          url: `http://127.0.0.1:${port}/pagerduty`,
          routingKey: 'routing-key',
        },
      )

      expect(delivery.status).toBe('delivered')
      expect(seen).toHaveLength(1)
      expect((seen[0] as any).routing_key).toBe('routing-key')
      expect((seen[0] as any).payload.summary).toBe('Duty failed')

      const stored = loadAlertDeliveries(projectRoot, 'acme')
      expect(stored).toHaveLength(1)
      expect(stored[0]!.provider).toBe('pagerduty')
      expect(stored[0]!.status).toBe('delivered')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('returns disabled deliveries when providers are not configured', async () => {
    const deliveries = await dispatchConfiguredOperationalAlerts(
      {
        severity: 'error',
        summary: 'Drain failed',
        source: 'daemon.assignment-drain',
        dedupeKey: 'drain-failed',
      },
      {
        tenant: { id: 'default', name: 'Default Tenant', role: 'admin' },
        projectRoot,
      },
    )

    expect(deliveries).toHaveLength(2)
    expect(deliveries.every(delivery => delivery.status === 'disabled')).toBe(
      true,
    )
    expect(loadAlertDeliveries(projectRoot, 'default')).toHaveLength(2)
  })
})
