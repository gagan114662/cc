import { createRequire } from 'module'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

type SyntaxTheme = {
  theme: string
  source?: string
}

type ColorRenderer = {
  render(themeName: string, width: number, dim: boolean): string[] | null
}

type ColorDiffConstructor = new (...args: unknown[]) => ColorRenderer
type ColorFileConstructor = new (...args: unknown[]) => ColorRenderer

type ColorDiffModule = {
  ColorDiff: ColorDiffConstructor
  ColorFile: ColorFileConstructor
  getSyntaxTheme: (themeName: string) => SyntaxTheme
}

const require = createRequire(import.meta.url)
let cachedColorDiffModule: ColorDiffModule | null | undefined

function loadColorDiffModule(): ColorDiffModule | null {
  if (cachedColorDiffModule !== undefined) {
    return cachedColorDiffModule
  }

  try {
    cachedColorDiffModule = require('color-diff-napi') as ColorDiffModule
  } catch (error) {
    logForDebugging(
      `[color-diff] optional runtime unavailable: ${String(error)}`,
    )
    cachedColorDiffModule = null
  }

  return cachedColorDiffModule
}

export type ColorModuleUnavailableReason = 'env' | 'missing'

/**
 * Returns a static reason why the color-diff module is unavailable, or null if available.
 * 'env' = disabled via CLAUDE_CODE_SYNTAX_HIGHLIGHT
 *
 * The TS port of color-diff works in all build modes, so the only way to
 * disable it is via the env var.
 */
export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT)) {
    return 'env'
  }
  if (!loadColorDiffModule()) {
    return 'missing'
  }
  return null
}

export function expectColorDiff(): ColorDiffConstructor | null {
  return getColorModuleUnavailableReason() === null
    ? loadColorDiffModule()?.ColorDiff ?? null
    : null
}

export function expectColorFile(): ColorFileConstructor | null {
  return getColorModuleUnavailableReason() === null
    ? loadColorDiffModule()?.ColorFile ?? null
    : null
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  return getColorModuleUnavailableReason() === null
    ? loadColorDiffModule()?.getSyntaxTheme(themeName) ?? null
    : null
}
