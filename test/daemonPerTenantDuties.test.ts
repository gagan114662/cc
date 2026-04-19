// Daemon boot across multiple tenants (Phase 2 item 2).
//
// Pins that when a project root has both DEFAULT_TENANT's legacy
// `.claude/employee.json` AND named tenants under `.claude/tenants/<id>/`,
// the daemon enumerates every tenant and schedules each duty under
// the correct tenant id — not collapsed to DEFAULT_TENANT.
//
// This test does NOT fire any duties — it only inspects the /health
// output, which reports tenantId per duty. That's enough to prove the
// scheduler keyed the duty by tenant and that the ScheduledDuty.tenant
// plumbing is wired end to end.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startDaemon, stopDaemon } from 'src/entrypoints/daemon.js'

let projectRoot: string

async function writeConfig(filePath: string, dutyId: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    JSON.stringify(
      {
        role: 'engineering-lead',
        goals: [],
        defaultAutonomy: 'full-operator',
        delegationMode: 'team',
        verificationRequired: true,
        recurringDuties: [
          {
            id: dutyId,
            title: dutyId,
            prompt: 'noop',
            // Monday 9am — rarely due, won't fire inside the test window.
            cron: '0 9 * * 1',
            enabled: true,
            autoCommit: false,
          },
        ],
      },
      null,
      2,
    ),
  )
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

beforeEach(async () => {
  projectRoot = path.join(
    tmpdir(),
    `cc-daemon-ns-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(projectRoot, { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('daemon per-tenant duty enumeration', () => {
  test('schedules DEFAULT_TENANT + named tenants from one project root', async () => {
    await writeConfig(
      path.join(projectRoot, '.claude', 'employee.json'),
      'default-duty',
    )
    await writeConfig(
      path.join(projectRoot, '.claude', 'tenants', 'acme', 'employee.json'),
      'acme-duty',
    )
    await writeConfig(
      path.join(projectRoot, '.claude', 'tenants', 'globex', 'employee.json'),
      'globex-duty',
    )

    const state = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'dist', 'cli.js'),
      once: false,
    })

    try {
      const res = await fetchJson(`http://127.0.0.1:${state.args.port}/health`)
      expect(res.status).toBe(200)
      const body = res.body as {
        duties: Array<{ id: string; tenantId: string }>
      }
      const pairs = body.duties
        .map(d => `${d.tenantId}:${d.id}`)
        .sort()
      expect(pairs).toEqual(
        ['acme:acme-duty', 'default:default-duty', 'globex:globex-duty'].sort(),
      )
    } finally {
      await stopDaemon(state, 'test-cleanup')
    }
  })

  test('same duty id across two tenants coexists (no key collision)', async () => {
    await writeConfig(
      path.join(projectRoot, '.claude', 'tenants', 'acme', 'employee.json'),
      'shared-id',
    )
    await writeConfig(
      path.join(projectRoot, '.claude', 'tenants', 'globex', 'employee.json'),
      'shared-id',
    )

    const state = await startDaemon({
      projectRoot,
      port: 0,
      graceMs: 500,
      cliBundlePath: path.join(projectRoot, 'dist', 'cli.js'),
      once: false,
    })

    try {
      const res = await fetchJson(`http://127.0.0.1:${state.args.port}/health`)
      const body = res.body as {
        duties: Array<{ id: string; tenantId: string }>
      }
      // Both must be present — if the scheduler keyed on dutyId alone,
      // one would silently overwrite the other.
      expect(body.duties.length).toBe(2)
      const tenants = body.duties.map(d => d.tenantId).sort()
      expect(tenants).toEqual(['acme', 'globex'])
    } finally {
      await stopDaemon(state, 'test-cleanup')
    }
  })
})
