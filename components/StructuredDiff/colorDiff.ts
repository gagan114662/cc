import { createRequire } from 'node:module'
import type {
  ColorDiff as ColorDiffType,
  ColorFile as ColorFileType,
  SyntaxTheme,
} from 'color-diff-napi'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

type ColorDiffModule = {
  ColorDiff: typeof ColorDiffType
  ColorFile: typeof ColorFileType
  getSyntaxTheme: (themeName: string) => SyntaxTheme | null
}

export type ColorModuleUnavailableReason = 'env' | 'module'

function loadColorDiffModule(): ColorDiffModule | null {
  const require = createRequire(import.meta.url)
  try {
    return require('color-diff-napi') as ColorDiffModule
  } catch {
    return null
  }
}

const colorDiffModule = loadColorDiffModule()

/**
 * Returns a static reason why the color-diff module is unavailable, or null if available.
 * 'env' = disabled via CLAUDE_CODE_SYNTAX_HIGHLIGHT
 * 'module' = native module not installed in this environment
 *
 * The TS port of color-diff works in all build modes, so the only way to
 * disable it is via the env var.
 */
export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT)) {
    return 'env'
  }
  if (!colorDiffModule) {
    return 'module'
  }
  return null
}

export function expectColorDiff(): typeof ColorDiffType | null {
  return getColorModuleUnavailableReason() === null ? colorDiffModule!.ColorDiff : null
}

export function expectColorFile(): typeof ColorFileType | null {
  return getColorModuleUnavailableReason() === null ? colorDiffModule!.ColorFile : null
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  return getColorModuleUnavailableReason() === null
    ? colorDiffModule!.getSyntaxTheme(themeName)
    : null
}
