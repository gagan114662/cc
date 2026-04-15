import path from 'node:path'
import { enableConfigs } from 'src/utils/config.js'
import { flushTelemetry, initializeTelemetry } from 'src/utils/telemetry/instrumentation.js'
import { logOTelEvent } from 'src/utils/telemetry/events.js'
import { parseSettingsFile } from 'src/utils/settings/settings.js'
import {
  AutoresearchController,
  resolveAutoresearchConfig,
} from 'src/services/autoresearch/runtime.js'

const repoRoot = path.resolve(import.meta.dir, '..')
const localSettingsPath = path.join(repoRoot, '.claude', 'settings.local.json')
const projectSettingsPath = path.join(repoRoot, '.claude', 'settings.json')

const { settings: localSettings, errors: localErrors } =
  parseSettingsFile(localSettingsPath)
if (localErrors.length > 0) {
  throw new Error(
    `Failed to parse ${localSettingsPath}: ${localErrors.map(error => error.message).join('; ')}`,
  )
}

Object.assign(process.env, localSettings?.env ?? {})

enableConfigs()
await initializeTelemetry()

const { settings: projectSettings, errors: projectErrors } =
  parseSettingsFile(projectSettingsPath)
if (projectErrors.length > 0) {
  throw new Error(
    `Failed to parse ${projectSettingsPath}: ${projectErrors.map(error => error.message).join('; ')}`,
  )
}

const resolved = await resolveAutoresearchConfig(
  repoRoot,
  projectSettings?.autoresearch,
)
if (!resolved.enabled) {
  throw new Error(resolved.invalidReason ?? 'Autoresearch is disabled.')
}

const controller = new AutoresearchController(resolved)
await controller.runCycle()

await logOTelEvent('autoresearch_honeycomb_smoke', {
  'autoresearch.repo': repoRoot,
  'autoresearch.source': 'scripts/honeycombSmoke.ts',
  'autoresearch.result': 'smoke_ok',
  'autoresearch.timestamp': new Date().toISOString(),
})
await flushTelemetry()

console.log('honeycomb-smoke-ok')
