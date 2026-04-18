import path from 'node:path'
import { enableConfigs } from 'src/utils/config.js'
import { authenticateHarnessObservability } from 'src/services/harness/observability.js'
import { getHarnessStatus } from 'src/services/harness/runtime.js'

type HarnessObservabilityDoctorResult = {
  repoRoot: string
  controlPlane: string
  internalQueryLive: boolean
  honeycombExportConfigured: boolean
  honeycombExportLive: boolean
  honeycombQueryLive: boolean
  exportLastSuccessAt?: string
  exportFresh: boolean
  observabilityEnvLoadedWorkers: string[]
  telemetryStaleWorkers: string[]
  auth: {
    ok: boolean
    authType?: string
    team?: string
    environment?: string
    error?: string
  }
}

function usage(): never {
  console.error(
    'Usage: bun ./scripts/harnessObservabilityDoctor.ts [--json]',
  )
  process.exit(1)
}

async function main(): Promise<void> {
  enableConfigs()
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--json')) {
    usage()
  }
  const json = args.includes('--json')
  const repoRoot = path.resolve(import.meta.dir, '..')
  const status = await getHarnessStatus(repoRoot)
  const auth = await authenticateHarnessObservability()
  const result: HarnessObservabilityDoctorResult = {
    repoRoot,
    controlPlane: status.controlPlane.kind,
    internalQueryLive: status.observability.internalQueryLive,
    honeycombExportConfigured:
      status.observability.exportEndpoint != null ||
      status.observability.dataset != null,
    honeycombExportLive: status.observability.honeycombExportLive,
    honeycombQueryLive: status.observability.honeycombQueryLive,
    exportLastSuccessAt: status.observability.exportLastSuccessAt,
    exportFresh: status.observability.exportFresh,
    observabilityEnvLoadedWorkers:
      status.observability.observabilityEnvLoadedWorkers,
    telemetryStaleWorkers: status.observability.telemetryStaleWorkers,
    auth,
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(
    [
      `repo: ${result.repoRoot}`,
      `control plane: ${result.controlPlane}`,
      `internal query: ${result.internalQueryLive ? 'live' : 'down'}`,
      `honeycomb export configured: ${result.honeycombExportConfigured ? 'yes' : 'no'}`,
      `honeycomb export live: ${result.honeycombExportLive ? 'yes' : 'no'}`,
      `honeycomb query live: ${result.honeycombQueryLive ? 'yes' : 'no'}`,
      `last export success: ${result.exportLastSuccessAt ?? 'never'}`,
      `export fresh: ${result.exportFresh ? 'yes' : 'no'}`,
      `observability env workers: ${result.observabilityEnvLoadedWorkers.join(', ') || 'none'}`,
      `telemetry stale workers: ${result.telemetryStaleWorkers.join(', ') || 'none'}`,
      `honeycomb auth: ${result.auth.ok ? 'ok' : result.auth.error ?? 'failed'}`,
    ].join('\n'),
  )
}

await main()
