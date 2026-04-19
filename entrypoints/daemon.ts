#!/usr/bin/env bun
// Long-running daemon for cc-rebuilt.
//
// Purpose: when the CLI exits, employee duties die with it. This process
// owns the duty schedule independently so duties keep firing after the
// interactive REPL is gone. It:
//
//  1. Loads `.claude/employee.json` (projectRoot resolved from env/cwd)
//  2. Parses each enabled duty's cron, computes the next fire time, and
//     fires a subprocess (`bun ./dist/cli.js -p <prompt>`) when due
//  3. Wraps each duty tick in an OTel span (employee.duty.tick) so the
//     dashboards in services/observability/slos.ts see them
//  4. Exposes /health and /ready on CC_DAEMON_HTTP_PORT
//  5. Handles SIGTERM/SIGINT gracefully — in-flight subprocesses are given
//     until CC_DAEMON_GRACE_MS (default 10s) to exit before SIGKILL
//
// This is deliberately minimal: no lock file, no multi-host coordination,
// no persistence of last-fire state. Those belong in Phase 2. Running two
// daemons against the same employee.json will double-fire duties.

import { spawn, type Subprocess } from 'bun'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import {
  listConfiguredTenants,
  readEmployeeConfig,
} from '../utils/employeeConfig.js'
import { computeNextCronRun, parseCronExpression } from '../utils/cron.js'
import {
  traceEnvForActiveContext,
  withAssignmentSpan,
  withDutySpan,
} from '../services/observability/dutySpans.js'
import {
  resolveTenantContext,
  tenantEnv,
  type TenantContext,
} from '../services/tenant/tenantContext.js'
import { runWithTenantScope } from '../services/tenant/tenantScope.js'
import {
  EMPLOYEE_ASSIGN_ROUTE,
  handleEmployeeAssignRequest,
} from '../services/http/employeeAssignRoute.js'
import type { EmployeeDuty } from '../types/employee.js'

type DaemonArgs = {
  projectRoot: string
  port: number
  graceMs: number
  cliBundlePath: string
  once: boolean
  // Optional override for the audit-log dir. In production the handler
  // falls through to CACHE_PATHS.audit() (process-cwd-keyed). Tests set
  // this via CC_DAEMON_AUDIT_DIR so assertions don't touch the host cache.
  auditDir?: string
}

type ScheduledDuty = {
  duty: EmployeeDuty
  // Each duty carries the tenant it was loaded under so concurrent
  // fires across tenants never cross-contaminate scope. The daemon's
  // top-level `state.tenant` is the host/process tenant — it is NOT
  // the right source of truth for a duty owned by a different tenant.
  tenant: TenantContext
  nextRun: Date
  timer: ReturnType<typeof setTimeout> | null
  inFlight: Set<Subprocess<'ignore', 'pipe', 'pipe'>>
  lastStartedAt: Date | null
  lastFinishedAt: Date | null
  lastStatus: 'ok' | 'error' | null
  tickCount: number
}

type DaemonState = {
  args: DaemonArgs
  startedAt: Date
  // The daemon's host tenant — resolved once at boot from env. It
  // remains the fallback used for process-level logging and the
  // `/health` envelope, but per-duty execution uses ScheduledDuty.tenant
  // so one daemon can legitimately schedule work for multiple tenants.
  tenant: TenantContext
  configLoaded: boolean
  // Key is `${tenantId}:${dutyId}` — tenants may legitimately use the
  // same duty id, and a flat `dutyId` key would silently overwrite.
  duties: Map<string, ScheduledDuty>
  httpServer: Server | null
  shuttingDown: boolean
}

function dutyKey(tenantId: string, dutyId: string): string {
  return `${tenantId}:${dutyId}`
}

function parseArgs(argv: string[]): DaemonArgs {
  const projectRoot = process.env.CC_DAEMON_PROJECT_ROOT
    ? path.resolve(process.env.CC_DAEMON_PROJECT_ROOT)
    : process.cwd()

  let port = Number(process.env.CC_DAEMON_HTTP_PORT ?? 8181)
  let graceMs = Number(process.env.CC_DAEMON_GRACE_MS ?? 10_000)
  let once = false
  let cliBundlePath =
    process.env.CC_DAEMON_CLI_BUNDLE ??
    path.resolve(projectRoot, 'dist', 'cli.js')

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') {
      port = Number(argv[++i])
    } else if (arg === '--grace-ms') {
      graceMs = Number(argv[++i])
    } else if (arg === '--cli-bundle') {
      cliBundlePath = path.resolve(argv[++i] ?? cliBundlePath)
    } else if (arg === '--once') {
      once = true
    }
  }

  if (!Number.isFinite(port) || port <= 0) port = 8181
  if (!Number.isFinite(graceMs) || graceMs < 0) graceMs = 10_000

  const auditDir = process.env.CC_DAEMON_AUDIT_DIR
    ? path.resolve(process.env.CC_DAEMON_AUDIT_DIR)
    : undefined

  return { projectRoot, port, graceMs, cliBundlePath, once, auditDir }
}

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: object): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: 'daemon',
    msg,
    ...(extra ?? {}),
  }
  process.stderr.write(JSON.stringify(entry) + '\n')
}

type TenantDuties = {
  tenant: TenantContext
  duties: EmployeeDuty[]
}

// Enumerate every configured tenant and load its enabled duties.
// Backs the daemon boot path: one daemon can legitimately schedule work
// across tenants (DEFAULT_TENANT's legacy `.claude/employee.json` plus
// any `.claude/tenants/<id>/employee.json`).
async function loadConfig(root: string): Promise<TenantDuties[]> {
  const tenants = await listConfiguredTenants(root)
  if (tenants.length === 0) {
    log('warn', 'no_employee_config', { root })
    return []
  }

  const out: TenantDuties[] = []
  for (const tenant of tenants) {
    const config = await readEmployeeConfig(root, tenant.id)
    if (!config) {
      log('warn', 'tenant_config_unreadable', { tenantId: tenant.id })
      continue
    }
    out.push({
      tenant,
      duties: config.recurringDuties.filter(d => d.enabled),
    })
  }
  return out
}

function scheduleNext(state: DaemonState, scheduled: ScheduledDuty): void {
  if (state.shuttingDown) return
  const fields = parseCronExpression(scheduled.duty.cron)
  if (!fields) {
    log('error', 'invalid_cron', {
      dutyId: scheduled.duty.id,
      cron: scheduled.duty.cron,
    })
    return
  }
  const next = computeNextCronRun(fields, new Date())
  if (!next) {
    log('error', 'no_next_run', { dutyId: scheduled.duty.id })
    return
  }
  scheduled.nextRun = next
  const delay = Math.max(next.getTime() - Date.now(), 0)
  scheduled.timer = setTimeout(() => {
    void fireDuty(state, scheduled)
  }, delay)
}

async function fireDuty(
  state: DaemonState,
  scheduled: ScheduledDuty,
): Promise<void> {
  if (state.shuttingDown) return
  scheduled.lastStartedAt = new Date()
  scheduled.tickCount += 1
  // Use the duty's own tenant, not state.tenant — on a multi-tenant
  // daemon these differ, and cross-contaminating would make spans,
  // audit entries, and bypassPermissionsMode gates all attribute to
  // the wrong tenant. The scope and span stamping must agree.
  const dutyTenant = scheduled.tenant
  const correlationId = `${scheduled.duty.id}:${scheduled.tickCount}`
  try {
    await runWithTenantScope(
      { tenant: dutyTenant, correlationId },
      async () =>
        withDutySpan(
          {
            dutyId: scheduled.duty.id,
            title: scheduled.duty.title,
            cron: scheduled.duty.cron,
            attempt: scheduled.tickCount,
            tenant: dutyTenant,
          },
          async span => runDutySubprocess(state, scheduled, span),
        ),
    )
    scheduled.lastStatus = 'ok'
  } catch (err) {
    scheduled.lastStatus = 'error'
    log('error', 'duty_failed', {
      dutyId: scheduled.duty.id,
      tenantId: dutyTenant.id,
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    scheduled.lastFinishedAt = new Date()
    if (!state.args.once) scheduleNext(state, scheduled)
  }
}

// Exported so tests can assert the env merge without spawning a real
// subprocess (which would require a built dist/cli.js and is painful in
// CI). Keep in sync with the spawn() call below.
export function buildDutySubprocessEnv(
  state: Pick<DaemonState, 'tenant'>,
  duty: Pick<EmployeeDuty, 'id' | 'title' | 'tokenBudget' | 'costCap'>,
  parentSpan?: import('@opentelemetry/api').Span,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const hasTokenBudget =
    typeof duty.tokenBudget === 'number' &&
    Number.isFinite(duty.tokenBudget) &&
    duty.tokenBudget > 0
  const hasCostCap =
    typeof duty.costCap === 'number' &&
    Number.isFinite(duty.costCap) &&
    duty.costCap > 0
  return {
    ...baseEnv,
    CLAUDE_CODE_REMOTE: 'true',
    CC_DUTY_ID: duty.id,
    CC_DUTY_TITLE: duty.title,
    // Hard-stop enforcement hints — the query loop reads these and
    // throws DutyBudgetExceededError once exceeded.
    ...(hasTokenBudget
      ? { CC_DUTY_TOKEN_BUDGET: String(duty.tokenBudget) }
      : {}),
    ...(hasCostCap
      ? { CC_DUTY_COST_CAP_USD: String(duty.costCap) }
      : {}),
    // Tenant merge comes after trace env so CC_TENANT_* wins over any
    // stale values the daemon process itself might have been started
    // with — the daemon's resolved tenant is the source of truth.
    ...traceEnvForActiveContext(parentSpan),
    ...tenantEnv(state.tenant),
  }
}

async function runDutySubprocess(
  state: DaemonState,
  scheduled: ScheduledDuty,
  parentSpan?: import('@opentelemetry/api').Span,
): Promise<void> {
  if (!existsSync(state.args.cliBundlePath)) {
    throw new Error(`cli_bundle_missing: ${state.args.cliBundlePath}`)
  }

  const cmd = ['bun', state.args.cliBundlePath, '-p', scheduled.duty.prompt]
  if (
    typeof scheduled.duty.costCap === 'number' &&
    Number.isFinite(scheduled.duty.costCap) &&
    scheduled.duty.costCap > 0
  ) {
    cmd.push('--max-budget-usd', String(scheduled.duty.costCap))
  }

  const child = spawn({
    cmd,
    cwd: state.args.projectRoot,
    env: buildDutySubprocessEnv(
      { tenant: scheduled.tenant },
      scheduled.duty,
      parentSpan,
    ),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  scheduled.inFlight.add(child)
  try {
    const exitCode = await child.exited
    if (exitCode !== 0) {
      throw new Error(`duty_subprocess_exit_${exitCode}`)
    }
  } finally {
    scheduled.inFlight.delete(child)
  }
}

function buildHealthBody(state: DaemonState): string {
  const duties = Array.from(state.duties.values()).map(s => ({
    id: s.duty.id,
    tenantId: s.tenant.id,
    title: s.duty.title,
    cron: s.duty.cron,
    nextRun: s.nextRun.toISOString(),
    inFlight: s.inFlight.size,
    tickCount: s.tickCount,
    lastStatus: s.lastStatus,
    lastFinishedAt: s.lastFinishedAt?.toISOString() ?? null,
    tokenBudget: s.duty.tokenBudget ?? null,
    costCap: s.duty.costCap ?? null,
  }))
  return JSON.stringify(
    {
      status: state.shuttingDown ? 'draining' : 'ok',
      startedAt: state.startedAt.toISOString(),
      configLoaded: state.configLoaded,
      projectRoot: state.args.projectRoot,
      tenant: {
        id: state.tenant.id,
        name: state.tenant.name,
        role: state.tenant.role,
      },
      duties,
    },
    null,
    2,
  )
}

function startHttp(state: DaemonState): Server {
  const server = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400).end()
      return
    }
    if (req.url === '/health') {
      res.writeHead(state.shuttingDown ? 503 : 200, {
        'content-type': 'application/json',
      })
      res.end(buildHealthBody(state))
      return
    }
    if (req.url === '/ready') {
      const ready = state.configLoaded && !state.shuttingDown
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ready }))
      return
    }
    if (req.url === EMPLOYEE_ASSIGN_ROUTE) {
      // While draining, refuse new work so callers retry against a
      // different replica (future Phase 3 concern) instead of racing
      // into an audit write the daemon may not finish.
      if (state.shuttingDown) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'draining' }))
        return
      }
      void handleEmployeeAssignRequest(
        req,
        res,
        state.args.auditDir ? { auditDir: state.args.auditDir } : {},
      ).catch(err => {
        log('error', 'assign_route_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal_error' }))
        }
      })
      return
    }
    res.writeHead(404).end()
  })
  return server
}

// Listen on the configured port and resolve once the OS has actually
// bound the socket. Port 0 asks the kernel for a free port — we then
// rewrite state.args.port to the real number so callers (tests, /health)
// see the port they can actually reach. Without this, the previous
// fire-and-forget listen() combined with random pickEphemeralPort()
// produced Linux-CI port collisions — see test/employeeAssignApi.test.ts.
async function listenHttp(server: Server, state: DaemonState): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (address && typeof address === 'object') {
        state.args.port = address.port
      }
      log('info', 'http_listening', { port: state.args.port })
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(state.args.port, '0.0.0.0')
  })
}

export async function stopDaemon(
  state: DaemonState,
  signal: string = 'stopDaemon',
): Promise<void> {
  if (state.shuttingDown) return
  state.shuttingDown = true
  log('info', 'shutdown_begin', { signal, graceMs: state.args.graceMs })

  for (const scheduled of state.duties.values()) {
    if (scheduled.timer) clearTimeout(scheduled.timer)
  }

  const deadline = Date.now() + state.args.graceMs
  const inFlight = () =>
    Array.from(state.duties.values()).flatMap(s => Array.from(s.inFlight))

  while (inFlight().length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  for (const child of inFlight()) {
    try {
      child.kill()
    } catch {
      // subprocess already exited
    }
  }

  if (state.httpServer) {
    await new Promise<void>(resolve => state.httpServer!.close(() => resolve()))
  }

  log('info', 'shutdown_complete', {})
}

async function shutdownAndExit(state: DaemonState, signal: string): Promise<void> {
  await stopDaemon(state, signal)
  process.exit(0)
}

export async function startDaemon(args: DaemonArgs): Promise<DaemonState> {
  const state: DaemonState = {
    args,
    startedAt: new Date(),
    tenant: resolveTenantContext(),
    configLoaded: false,
    duties: new Map(),
    httpServer: null,
    shuttingDown: false,
  }

  state.httpServer = startHttp(state)
  await listenHttp(state.httpServer, state)

  const tenantDuties = await loadConfig(args.projectRoot)
  let dutyCount = 0
  for (const { tenant, duties } of tenantDuties) {
    for (const duty of duties) {
      const scheduled: ScheduledDuty = {
        duty,
        tenant,
        nextRun: new Date(0),
        timer: null,
        inFlight: new Set(),
        lastStartedAt: null,
        lastFinishedAt: null,
        lastStatus: null,
        tickCount: 0,
      }
      state.duties.set(dutyKey(tenant.id, duty.id), scheduled)
      scheduleNext(state, scheduled)
      dutyCount += 1
    }
  }
  state.configLoaded = true

  log('info', 'daemon_ready', {
    projectRoot: args.projectRoot,
    tenantCount: tenantDuties.length,
    dutyCount,
    port: args.port,
  })

  return state
}

// Named assignment-run span is exported so programmatic callers (future HTTP
// /assign endpoint) can wrap their work in the same shape as duties.
export { withAssignmentSpan, withDutySpan }

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const state = await startDaemon(args)
  process.on('SIGTERM', () => void shutdownAndExit(state, 'SIGTERM'))
  process.on('SIGINT', () => void shutdownAndExit(state, 'SIGINT'))

  if (args.once) {
    // Fire every duty exactly once then exit. Useful for smoke tests.
    for (const scheduled of state.duties.values()) {
      if (scheduled.timer) clearTimeout(scheduled.timer)
      await fireDuty(state, scheduled)
    }
    await shutdownAndExit(state, 'once')
  }
}
