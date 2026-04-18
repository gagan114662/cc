import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as lockfile from 'src/utils/lockfile.js'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import { safeParseJSON } from 'src/utils/json.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { HarnessConfig, HarnessRuntimeState } from './types.js'
import { HarnessRuntimeStateSchema } from './types.js'

const CONTROL_PLANE_DIR = 'harness-control-plane'
const CONTROL_PLANE_STATE_FILE = 'state.json'
const CONTROL_PLANE_LOCK_FILE = 'state.lock'
const REDIS_LOCK_TTL_MS = 15_000
const REDIS_LOCK_RETRIES = 20
const REDIS_LOCK_RETRY_DELAY_MS = 50

const LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 1.25,
    minTimeout: 20,
    maxTimeout: 250,
  },
  realpath: false,
} as const

type HarnessControlPlaneBackendKind = 'filesystem' | 'postgres-redis'

type HarnessControlPlaneInfo = {
  kind: HarnessControlPlaneBackendKind
  tenantId: string
  filesystemRoot: string
  postgresConfigured: boolean
  redisConfigured: boolean
}

type HarnessControlPlaneBackend = {
  kind: HarnessControlPlaneBackendKind
  readState(): Promise<HarnessRuntimeState>
  writeState(state: HarnessRuntimeState): Promise<void>
  withLock<T>(mutator: () => Promise<T> | T): Promise<T>
}

let backendCache:
  | {
      key: string
      backend: HarnessControlPlaneBackend
    }
  | undefined
let backendOverride: HarnessControlPlaneBackend | null = null

function getControlPlaneRoot(): string {
  return path.join(getClaudeConfigHomeDir(), CONTROL_PLANE_DIR)
}

function getControlPlaneStatePath(): string {
  return path.join(getControlPlaneRoot(), CONTROL_PLANE_STATE_FILE)
}

function getControlPlaneLockPath(): string {
  return path.join(getControlPlaneRoot(), CONTROL_PLANE_LOCK_FILE)
}

function getControlPlaneTenantId(): string {
  return process.env.CLAUDE_CODE_HARNESS_TENANT_ID ?? 'local-tenant'
}

function getControlPlaneBackendInfo(): HarnessControlPlaneInfo {
  const postgresConfigured = Boolean(process.env.CLAUDE_CODE_HARNESS_POSTGRES_URL)
  const redisConfigured = Boolean(process.env.CLAUDE_CODE_HARNESS_REDIS_URL)
  const requestedBackend = process.env.CLAUDE_CODE_HARNESS_CONTROL_PLANE_BACKEND
  const kind: HarnessControlPlaneBackendKind =
    requestedBackend === 'postgres-redis' ||
    (postgresConfigured && redisConfigured)
      ? 'postgres-redis'
      : 'filesystem'

  return {
    kind,
    tenantId: getControlPlaneTenantId(),
    filesystemRoot: getControlPlaneRoot(),
    postgresConfigured,
    redisConfigured,
  }
}

function createDefaultState(now: Date = new Date()): HarnessRuntimeState {
  return HarnessRuntimeStateSchema().parse({
    version: '2',
    tenant: {
      id: getControlPlaneTenantId(),
      name: getControlPlaneTenantId(),
      createdAt: now.toISOString(),
    },
  })
}

async function ensureControlPlaneFiles(): Promise<void> {
  const root = getControlPlaneRoot()
  await mkdir(root, { recursive: true })
  await writeFile(getControlPlaneLockPath(), '', { flag: 'a' })
  await writeFile(getControlPlaneStatePath(), '', { flag: 'a' })
}

async function readFileStateUnlocked(): Promise<HarnessRuntimeState> {
  try {
    const raw = await readFile(getControlPlaneStatePath(), 'utf-8')
    const parsed = safeParseJSON(raw, false)
    if (parsed == null) {
      return createDefaultState()
    }
    return HarnessRuntimeStateSchema().parse(parsed)
  } catch {
    return createDefaultState()
  }
}

async function writeFileStateUnlocked(state: HarnessRuntimeState): Promise<void> {
  await writeFile(
    getControlPlaneStatePath(),
    `${jsonStringify(state, null, 2)}\n`,
    'utf-8',
  )
}

function createFileBackend(): HarnessControlPlaneBackend {
  return {
    kind: 'filesystem',
    async readState() {
      await ensureControlPlaneFiles()
      return readFileStateUnlocked()
    },
    async writeState(state) {
      await ensureControlPlaneFiles()
      await writeFileStateUnlocked(state)
    },
    async withLock<T>(mutator: () => Promise<T> | T): Promise<T> {
      await ensureControlPlaneFiles()
      const lockTarget = getControlPlaneLockPath()
      const release = await lockfile.lock(lockTarget, {
        ...LOCK_OPTIONS,
        lockfilePath: `${lockTarget}.lock`,
      })

      try {
        return await mutator()
      } finally {
        await release()
      }
    },
  }
}

function createPostgresRedisBackend(): HarnessControlPlaneBackend {
  const postgresUrl = process.env.CLAUDE_CODE_HARNESS_POSTGRES_URL
  const redisUrl = process.env.CLAUDE_CODE_HARNESS_REDIS_URL
  if (!postgresUrl || !redisUrl) {
    throw new Error(
      'CLAUDE_CODE_HARNESS_POSTGRES_URL and CLAUDE_CODE_HARNESS_REDIS_URL are required for the postgres-redis control plane backend.',
    )
  }

  const tenantId = getControlPlaneTenantId()
  const sql = new Bun.SQL(postgresUrl)
  const redis = new Bun.RedisClient(redisUrl)
  let redisConnectPromise: Promise<void> | null = null
  let schemaReadyPromise: Promise<void> | null = null

  const ensureRedisConnected = async (): Promise<void> => {
    if (redis.connected) {
      return
    }
    redisConnectPromise ??= redis.connect().finally(() => {
      redisConnectPromise = null
    })
    await redisConnectPromise
  }

  const ensureSchema = async (): Promise<void> => {
    schemaReadyPromise ??= (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS harness_control_plane_state (
          tenant_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `
    })().finally(() => {
      schemaReadyPromise = null
    })
    await schemaReadyPromise
  }

  const readState = async (): Promise<HarnessRuntimeState> => {
    await ensureSchema()
    const rows = await sql`
      SELECT state_json
      FROM harness_control_plane_state
      WHERE tenant_id = ${tenantId}
      LIMIT 1
    `
    const row = rows[0] as { state_json?: string } | undefined
    const parsed = row?.state_json ? safeParseJSON(row.state_json, false) : null
    if (parsed == null) {
      return createDefaultState()
    }
    return HarnessRuntimeStateSchema().parse(parsed)
  }

  const writeState = async (state: HarnessRuntimeState): Promise<void> => {
    await ensureSchema()
    const stateJson = jsonStringify(state)
    await sql`
      INSERT INTO harness_control_plane_state (tenant_id, state_json, updated_at)
      VALUES (${tenantId}, ${stateJson}, NOW())
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        state_json = EXCLUDED.state_json,
        updated_at = NOW()
    `
  }

  const acquireRedisLock = async (): Promise<() => Promise<void>> => {
    await ensureRedisConnected()
    const key = `cc:harness-control-plane:${tenantId}:lock`
    const token = randomUUID()

    for (let attempt = 0; attempt < REDIS_LOCK_RETRIES; attempt += 1) {
      const result = await redis.send('SET', [
        key,
        token,
        'NX',
        'PX',
        String(REDIS_LOCK_TTL_MS),
      ])
      if (result === 'OK') {
        return async () => {
          const current = await redis.get(key)
          if (current === token) {
            await redis.del(key)
          }
        }
      }
      await new Promise(resolve =>
        setTimeout(resolve, REDIS_LOCK_RETRY_DELAY_MS * (attempt + 1)),
      )
    }

    throw new Error(
      `Failed to acquire Redis control-plane lock for tenant ${tenantId}`,
    )
  }

  return {
    kind: 'postgres-redis',
    readState,
    writeState,
    async withLock<T>(mutator: () => Promise<T> | T): Promise<T> {
      const release = await acquireRedisLock()
      try {
        return await mutator()
      } finally {
        await release()
      }
    },
  }
}

function getBackendCacheKey(): string {
  const info = getControlPlaneBackendInfo()
  return [
    info.kind,
    info.tenantId,
    info.filesystemRoot,
    process.env.CLAUDE_CODE_HARNESS_POSTGRES_URL ?? '',
    process.env.CLAUDE_CODE_HARNESS_REDIS_URL ?? '',
  ].join('\0')
}

function resolveBackend(): HarnessControlPlaneBackend {
  if (backendOverride) {
    return backendOverride
  }

  const key = getBackendCacheKey()
  if (backendCache?.key === key) {
    return backendCache.backend
  }

  const info = getControlPlaneBackendInfo()
  const backend =
    info.kind === 'postgres-redis'
      ? createPostgresRedisBackend()
      : createFileBackend()
  backendCache = {
    key,
    backend,
  }
  return backend
}

export async function readHostedHarnessState(): Promise<HarnessRuntimeState> {
  return resolveBackend().readState()
}

export async function withHostedHarnessState<T>(
  mutator: (state: HarnessRuntimeState) => Promise<T> | T,
): Promise<T> {
  const backend = resolveBackend()
  return backend.withLock(async () => {
    const state = await backend.readState()
    const result = await mutator(state)
    await backend.writeState(state)
    return result
  })
}

export function buildHarnessRepoId(repoRoot: string): string {
  const digest = createHash('sha256')
    .update(path.resolve(repoRoot))
    .digest('hex')
    .slice(0, 16)
  return `repo_${digest}`
}

export function computeDesiredStateHash(config: HarnessConfig): string {
  return createHash('sha256')
    .update(jsonStringify(config))
    .digest('hex')
    .slice(0, 16)
}

export function ensureHostedRepoRegistration(
  state: HarnessRuntimeState,
  input: {
    repoRoot: string
    config: HarnessConfig
    repoNameWithOwner?: string
    defaultBranch?: string
    now: Date
  },
): string {
  const repoId = buildHarnessRepoId(input.repoRoot)
  const maxParallelism = Math.max(
    input.config.sources.remoteTriggers.maxWorkers,
    ...input.config.jobs.map(job => job.maxParallelism),
    1,
  )
  const remoteExecution = input.config.sources.remoteTriggers.dispatchMode
  const desiredStateHash = computeDesiredStateHash(input.config)

  state.repos[repoId] = {
    repoId,
    repoRoot: path.resolve(input.repoRoot),
    repoNameWithOwner: input.repoNameWithOwner,
    defaultBranch: input.defaultBranch,
    desiredStateHash,
    syncedAt: input.now.toISOString(),
    maxParallelism,
    remoteExecution,
    fleetTargetSlots: input.config.sources.remoteTriggers.maxWorkers,
  }

  state.repoHealth[repoId] ??= {
    repoId,
    status: state.paused ? 'paused' : 'healthy',
    pauseReason: state.pauseReason,
  }

  const repoBudget =
    state.budgets[repoId] ??
    ({
      repoId,
      spentUsd: 0,
      maxUsd: 0,
      warnUsd: 0,
      blocked: false,
    } satisfies HarnessRuntimeState['budgets'][string])
  const maxUsd = input.config.jobs.reduce(
    (sum, job) => sum + job.budget.maxUsd,
    0,
  )
  const warnUsd = input.config.jobs.reduce(
    (sum, job) => sum + job.budget.warnUsd,
    0,
  )
  state.budgets[repoId] = {
    ...repoBudget,
    maxUsd: Math.max(repoBudget.maxUsd, maxUsd || 25),
    warnUsd: Math.max(repoBudget.warnUsd, warnUsd || 20),
    updatedAt: input.now.toISOString(),
  }

  return repoId
}

export function filterHarnessStateForRepo(
  state: HarnessRuntimeState,
  repoId: string,
): HarnessRuntimeState {
  const repoHealth = state.repoHealth[repoId]
  const keepNamespaced = (key: string): boolean =>
    key.startsWith(`${repoId}:`) || key === repoId
  const jobs = Object.fromEntries(
    Object.entries(state.jobs).filter(([, job]) => job.repoId === repoId),
  )
  const queue = state.queue.filter(instanceId => jobs[instanceId] != null)
  const leases = Object.fromEntries(
    Object.entries(state.leases).filter(([, lease]) => lease.repoId === repoId),
  )
  const attempts = Object.fromEntries(
    Object.entries(state.attempts).filter(([, attempt]) => attempt.repoId === repoId),
  )
  const workerHeartbeats = Object.fromEntries(
    Object.entries(state.workerHeartbeats).filter(
      ([, heartbeat]) => heartbeat.repoId == null || heartbeat.repoId === repoId,
    ),
  )
  const runners = Object.fromEntries(
    Object.entries(state.runners).filter(
      ([, runner]) => runner.repoId == null || runner.repoId === repoId,
    ),
  )
  const agentSessions = Object.fromEntries(
    Object.entries(state.agentSessions).filter(([, observation]) => {
      const job = jobs[observation.jobInstanceId]
      return job != null
    }),
  )
  const qualityPullRequests = Object.fromEntries(
    Object.entries(state.quality.pullRequests).filter(
      ([, record]) => record.repoId === repoId,
    ),
  )
  const qualityFindings = Object.fromEntries(
    Object.entries(state.quality.findings).filter(
      ([, finding]) => finding.repoId === repoId,
    ),
  )
  const qualityDeployments = Object.fromEntries(
    Object.entries(state.quality.deployments).filter(
      ([, deployment]) => deployment.repoId === repoId,
    ),
  )
  const qualityIncidents = Object.fromEntries(
    Object.entries(state.quality.incidents).filter(
      ([, incident]) => incident.repoId === repoId,
    ),
  )
  const qualityRecoveries = Object.fromEntries(
    Object.entries(state.quality.recoveries).filter(
      ([, recovery]) => recovery.repoId === repoId,
    ),
  )
  const qualityReverts = Object.fromEntries(
    Object.entries(state.quality.reverts).filter(
      ([, revert]) => revert.repoId === repoId,
    ),
  )
  const qualityLogicalChangeSizes = Object.fromEntries(
    Object.entries(state.quality.logicalChangeSizes).filter(
      ([, logicalChangeSize]) => logicalChangeSize.repoId === repoId,
    ),
  )
  const qualitySnapshots = Object.fromEntries(
    Object.entries(state.quality.snapshots).filter(
      ([, snapshot]) => snapshot.repoId === repoId,
    ),
  )

  return HarnessRuntimeStateSchema().parse({
    ...state,
    paused:
      repoHealth?.status === 'paused' || repoHealth?.status === 'red'
        ? true
        : false,
    pauseReason: repoHealth?.pauseReason,
    repos: state.repos[repoId] ? { [repoId]: state.repos[repoId] } : {},
    repoHealth: repoHealth ? { [repoId]: repoHealth } : {},
    budgets: state.budgets[repoId] ? { [repoId]: state.budgets[repoId] } : {},
    jobs,
    queue,
    leases,
    attempts,
    runners,
    workerHeartbeats,
    agentSessions,
    quality: {
      pullRequests: qualityPullRequests,
      findings: qualityFindings,
      deployments: qualityDeployments,
      incidents: qualityIncidents,
      recoveries: qualityRecoveries,
      reverts: qualityReverts,
      logicalChangeSizes: qualityLogicalChangeSizes,
      snapshots: qualitySnapshots,
    },
    eventLedger: state.eventLedger.filter(entry => entry.repoId === repoId),
    sourceCursors: {
      githubPrHeads: Object.fromEntries(
        Object.entries(state.sourceCursors.githubPrHeads).filter(([key]) =>
          keepNamespaced(key),
        ),
      ),
      cronFires: Object.fromEntries(
        Object.entries(state.sourceCursors.cronFires).filter(([key]) =>
          keepNamespaced(key),
        ),
      ),
      remoteEvents: Object.fromEntries(
        Object.entries(state.sourceCursors.remoteEvents).filter(([key]) =>
          keepNamespaced(key),
        ),
      ),
      defaultBranches: Object.fromEntries(
        Object.entries(state.sourceCursors.defaultBranches).filter(([key]) =>
          keepNamespaced(key),
        ),
      ),
      defaultBranchHeads: Object.fromEntries(
        Object.entries(state.sourceCursors.defaultBranchHeads).filter(([key]) =>
          keepNamespaced(key),
        ),
      ),
      failingRunKeys: Object.fromEntries(
        Object.entries(state.sourceCursors.failingRunKeys).filter(([key]) =>
          keepNamespaced(key),
        ),
      ),
    },
    history: state.history.filter(outcome => {
      const job = jobs[outcome.jobInstanceId]
      return job != null
    }),
  })
}

export function getHostedHarnessPaths(): {
  root: string
  statePath: string
  lockPath: string
} {
  return {
    root: getControlPlaneRoot(),
    statePath: getControlPlaneStatePath(),
    lockPath: getControlPlaneLockPath(),
  }
}

export function getHostedHarnessControlPlaneInfo(): HarnessControlPlaneInfo {
  const info = getControlPlaneBackendInfo()
  return {
    ...info,
    kind: resolveBackend().kind,
  }
}

export function __setHostedHarnessBackendOverrideForTests(
  backend: HarnessControlPlaneBackend | null,
): void {
  backendOverride = backend
  backendCache = undefined
}
