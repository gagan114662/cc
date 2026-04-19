import path from 'node:path'
import { enableConfigs } from 'src/utils/config.js'
import {
  flushTelemetry,
  initializeTelemetry,
} from 'src/utils/telemetry/instrumentation.js'
import { parseSettingsFile } from 'src/utils/settings/settings.js'
import {
  AutoresearchController,
  resolveAutoresearchConfig,
} from 'src/services/autoresearch/runtime.js'

if (process.env.CLAUDE_CODE_HARNESS_MODE === '1') {
  console.log('autoresearch-cycle-skipped')
  process.exit(0)
}

const repoRoot = path.resolve(import.meta.dir, '..')
const localSettingsPath = path.join(repoRoot, '.claude', 'settings.local.json')
const projectSettingsPath = path.join(repoRoot, '.claude', 'settings.json')

// Apply telemetry env vars from settings.local.json before initializing OTel
const { settings: localSettings, errors: localErrors } =
  parseSettingsFile(localSettingsPath)
if (localErrors.length > 0) {
  process.stderr.write(
    `Failed to parse ${localSettingsPath}: ${localErrors.map(e => e.message).join('; ')}\n`,
  )
  process.exit(1)
}
Object.assign(process.env, localSettings?.env ?? {})

enableConfigs()
await initializeTelemetry()

const { settings: projectSettings, errors: projectErrors } =
  parseSettingsFile(projectSettingsPath)
if (projectErrors.length > 0) {
  process.stderr.write(
    `Failed to parse ${projectSettingsPath}: ${projectErrors.map(e => e.message).join('; ')}\n`,
  )
  process.exit(1)
}

const resolved = await resolveAutoresearchConfig(
  repoRoot,
  projectSettings?.autoresearch,
)
if (!resolved.enabled) {
  process.stderr.write(
    `Autoresearch disabled: ${resolved.invalidReason ?? 'unknown reason'}\n`,
  )
  process.exit(1)
}

const controller = new AutoresearchController(resolved)
await controller.runCycle()
await flushTelemetry()

console.log('autoresearch-cycle-ok')
