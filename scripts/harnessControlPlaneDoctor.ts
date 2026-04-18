import { enableConfigs } from 'src/utils/config.js'
import { logHarnessWideEvent } from 'src/services/harness/telemetry.js'
import {
  flushTelemetry,
  initializeTelemetry,
} from 'src/utils/telemetry/instrumentation.js'

type HarnessDoctorResult = {
  backend: string
  tenantId: string
  postgres: {
    ok: boolean
    latencyMs?: number
    detail?: string
  }
  redis: {
    ok: boolean
    latencyMs?: number
    detail?: string
  }
  lock: {
    ok: boolean
    detail?: string
  }
}

function nowMs(): number {
  return performance.now()
}

async function checkPostgres(url: string): Promise<{
  ok: boolean
  latencyMs?: number
  detail?: string
}> {
  const started = nowMs()
  try {
    const sql = new Bun.SQL(url)
    const rows = await sql`SELECT 1 AS ok`
    await sql.close()
    return {
      ok: rows[0]?.ok === 1,
      latencyMs: Math.round((nowMs() - started) * 100) / 100,
      detail: 'SELECT 1 succeeded',
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round((nowMs() - started) * 100) / 100,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checkRedis(url: string, tenantId: string): Promise<{
  ok: boolean
  latencyMs?: number
  detail?: string
}> {
  const started = nowMs()
  const redis = new Bun.RedisClient(url)
  try {
    await redis.connect()
    const key = `cc:harness-doctor:${tenantId}:${Date.now()}`
    await redis.set(key, 'ok')
    const value = await redis.get(key)
    await redis.del(key)
    redis.close()
    return {
      ok: value === 'ok',
      latencyMs: Math.round((nowMs() - started) * 100) / 100,
      detail: 'SET/GET/DEL succeeded',
    }
  } catch (error) {
    try {
      redis.close()
    } catch {
      // Ignore close errors on failed connection attempts.
    }
    return {
      ok: false,
      latencyMs: Math.round((nowMs() - started) * 100) / 100,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checkLock(url: string, tenantId: string): Promise<{
  ok: boolean
  detail?: string
}> {
  const redis = new Bun.RedisClient(url)
  const key = `cc:harness-control-plane:${tenantId}:doctor-lock`
  const token = `doctor-${Date.now()}`
  try {
    await redis.connect()
    const acquired = await redis.send('SET', [key, token, 'NX', 'PX', '5000'])
    if (acquired !== 'OK') {
      redis.close()
      return {
        ok: false,
        detail: 'failed to acquire Redis NX lease',
      }
    }
    const current = await redis.get(key)
    if (current === token) {
      await redis.del(key)
    }
    redis.close()
    return {
      ok: current === token,
      detail: current === token ? 'Redis lease path works' : 'Redis lease token mismatch',
    }
  } catch (error) {
    try {
      redis.close()
    } catch {
      // Ignore close errors on failed connection attempts.
    }
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function main(): Promise<void> {
  enableConfigs()
  await initializeTelemetry()

  const json = process.argv.includes('--json')
  const backend =
    process.env.CLAUDE_CODE_HARNESS_CONTROL_PLANE_BACKEND ?? 'filesystem'
  const tenantId = process.env.CLAUDE_CODE_HARNESS_TENANT_ID ?? 'local-tenant'
  const postgresUrl = process.env.CLAUDE_CODE_HARNESS_POSTGRES_URL
  const redisUrl = process.env.CLAUDE_CODE_HARNESS_REDIS_URL

  if (backend !== 'postgres-redis') {
    const message =
      'Harness doctor expects CLAUDE_CODE_HARNESS_CONTROL_PLANE_BACKEND=postgres-redis.'
    if (json) {
      console.log(
        JSON.stringify(
          {
            backend,
            tenantId,
            postgres: { ok: false, detail: message },
            redis: { ok: false, detail: message },
            lock: { ok: false, detail: message },
          } satisfies HarnessDoctorResult,
          null,
          2,
        ),
      )
    } else {
      console.error(message)
    }
    process.exit(1)
  }

  if (!postgresUrl || !redisUrl) {
    const message =
      'Both CLAUDE_CODE_HARNESS_POSTGRES_URL and CLAUDE_CODE_HARNESS_REDIS_URL are required.'
    if (json) {
      console.log(
        JSON.stringify(
          {
            backend,
            tenantId,
            postgres: { ok: false, detail: message },
            redis: { ok: false, detail: message },
            lock: { ok: false, detail: message },
          } satisfies HarnessDoctorResult,
          null,
          2,
        ),
      )
    } else {
      console.error(message)
    }
    process.exit(1)
  }

  const postgres = await checkPostgres(postgresUrl)
  const redis = await checkRedis(redisUrl, tenantId)
  const lock = await checkLock(redisUrl, tenantId)

  const result: HarnessDoctorResult = {
    backend,
    tenantId,
    postgres,
    redis,
    lock,
  }

  await logHarnessWideEvent('cc_harness_control_plane_doctor', {
    metadata: {
      'harness.backend': backend,
      'harness.tenant_id': tenantId,
      'harness.postgres_ok': postgres.ok,
      'harness.postgres_latency_ms': postgres.latencyMs,
      'harness.redis_ok': redis.ok,
      'harness.redis_latency_ms': redis.latencyMs,
      'harness.lock_ok': lock.ok,
      'harness.doctor_result': postgres.ok && redis.ok && lock.ok ? 'ok' : 'failed',
    },
  })
  await flushTelemetry()

  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(
      [
        `backend: ${result.backend}`,
        `tenant: ${result.tenantId}`,
        `postgres: ${postgres.ok ? 'ok' : 'failed'}${postgres.detail ? ` (${postgres.detail})` : ''}`,
        `redis: ${redis.ok ? 'ok' : 'failed'}${redis.detail ? ` (${redis.detail})` : ''}`,
        `lock: ${lock.ok ? 'ok' : 'failed'}${lock.detail ? ` (${lock.detail})` : ''}`,
      ].join('\n'),
    )
  }

  if (!postgres.ok || !redis.ok || !lock.ok) {
    process.exit(1)
  }
}

await main()
