import { getSessionId, registerHookCallbacks } from 'src/bootstrap/state.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'
import type { HookCallback } from 'src/types/hooks.js'
import {
  DeterministicHarnessController,
  resolveDeterministicHarnessConfig,
} from './runtime.js'

let registrationPromise: Promise<void> | null = null

export async function registerDeterministicHarnessHooks(): Promise<void> {
  if (registrationPromise) {
    return registrationPromise
  }

  registrationPromise = (async () => {
    const settings = getInitialSettings()
    const resolvedConfig = await resolveDeterministicHarnessConfig(
      getCwd(),
      settings.deterministicHarness,
    )

    if (!resolvedConfig.enabled) {
      logForDebugging(
        '[deterministic-harness] strict deterministic workflow is disabled',
      )
      return
    }

    const controller = new DeterministicHarnessController(resolvedConfig)

    const sessionStartHook: HookCallback = {
      type: 'callback',
      internal: true,
      timeout: 2,
      callback: input => controller.handleSessionStart(input as never),
    }

    const userPromptHook: HookCallback = {
      type: 'callback',
      internal: true,
      timeout: 2,
      callback: input => controller.handleUserPromptSubmit(input as never),
    }

    const preToolHook: HookCallback = {
      type: 'callback',
      internal: true,
      timeout: 2,
      callback: input => controller.handlePreToolUse(input as never),
    }

    const postToolHook: HookCallback = {
      type: 'callback',
      internal: true,
      timeout: 2,
      callback: input => controller.handlePostToolUse(input as never),
    }

    const postToolFailureHook: HookCallback = {
      type: 'callback',
      internal: true,
      timeout: 2,
      callback: input => controller.handlePostToolUseFailure(input as never),
    }

    const stopHook: HookCallback = {
      type: 'callback',
      internal: true,
      timeout: 3,
      callback: input => controller.handleStop(input as never),
    }

    registerHookCallbacks({
      SessionStart: [{ matcher: '', hooks: [sessionStartHook] }],
      UserPromptSubmit: [{ matcher: '', hooks: [userPromptHook] }],
      PreToolUse: [{ matcher: '', hooks: [preToolHook] }],
      PostToolUse: [{ matcher: '', hooks: [postToolHook] }],
      PostToolUseFailure: [{ matcher: '', hooks: [postToolFailureHook] }],
      Stop: [{ matcher: '', hooks: [stopHook] }],
    })

    logForDebugging(
      `[deterministic-harness] registered strict workflow hooks for session ${getSessionId()}`,
    )
  })()

  return registrationPromise
}
