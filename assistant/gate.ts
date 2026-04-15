import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

export async function isKairosEnabled(): Promise<boolean> {
  const settings = (getSettings_DEPRECATED() || {}) as { assistant?: boolean }
  return settings.assistant === true
}
