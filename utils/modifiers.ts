export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

let prewarmed = false

type ModifiersModule = {
  prewarm?: () => void
  isModifierPressed: (modifier: string) => boolean
}

function loadModifiersModule(): ModifiersModule | null {
  try {
    const requireFn = Function(
      'return typeof require === "function" ? require : null',
    )() as ((id: string) => ModifiersModule) | null
    return requireFn?.('modifiers-napi') ?? null
  } catch {
    return null
  }
}

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  // Load module in background
  try {
    loadModifiersModule()?.prewarm?.()
  } catch {
    // Ignore errors during prewarm
  }
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  return loadModifiersModule()?.isModifierPressed(modifier) ?? false
}
