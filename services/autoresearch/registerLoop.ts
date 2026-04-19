import { getProjectRoot } from 'src/bootstrap/state.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'
import {
  AutoresearchController,
  resolveAutoresearchConfig,
} from './runtime.js'

let registrationPromise: Promise<void> | null = null

export async function registerAutoresearchLoop(): Promise<void> {
  if (registrationPromise) {
    return registrationPromise
  }

  registrationPromise = (async () => {
    if (process.env.CLAUDE_CODE_HARNESS_MODE === '1') {
      logForDebugging(
        '[autoresearch] skipping background loop for harness worker session',
      )
      return
    }

    const settings = getInitialSettings()
    const resolvedConfig = await resolveAutoresearchConfig(
      getProjectRoot(),
      settings.autoresearch,
    )

    if (!resolvedConfig.enabled) {
      logForDebugging(
        `[autoresearch] unattended loop disabled${resolvedConfig.invalidReason ? `: ${resolvedConfig.invalidReason}` : ''}`,
      )
      return
    }

    const controller = new AutoresearchController(resolvedConfig)
    await controller.start()
    logForDebugging(
      `[autoresearch] unattended loop registered for ${resolvedConfig.repoRoot}`,
    )
  })()

  return registrationPromise
}
