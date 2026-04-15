import { getIsRemoteMode } from '../../bootstrap/state.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isEnvTruthy, isInProtectedNamespace } from '../envUtils.js'

export const LOCAL_YOLO_ACTIVE_ENV = 'CLAUDE_CODE_LOCAL_YOLO_ACTIVE'

export function isLocalYoloEligibleEnvironment(): boolean {
  return (
    !isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    !getIsRemoteMode() &&
    !isInProtectedNamespace()
  )
}

export function isLocalYoloModeActive(mode?: PermissionMode): boolean {
  if (!isLocalYoloEligibleEnvironment()) {
    return false
  }

  if (mode !== undefined) {
    return mode === 'bypassPermissions'
  }

  return isEnvTruthy(process.env[LOCAL_YOLO_ACTIVE_ENV])
}

export function syncLocalYoloEnvironment(mode?: PermissionMode): void {
  process.env[LOCAL_YOLO_ACTIVE_ENV] = isLocalYoloModeActive(mode)
    ? '1'
    : '0'
}
