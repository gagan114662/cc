/**
 * Phantom stub — git commit attribution hooks (ant-only,
 * `feature('COMMIT_ATTRIBUTION')`).
 *
 * Callsites:
 *   - setup.ts:356                       — registerAttributionHooks()
 *   - services/compact/postCompactCleanup.ts:72 — sweepFileContentCache()
 *   - commands/clear/caches.ts:106       — clearAttributionCaches()
 *
 * All three are dynamic `import()` awaited for side effects — safe to
 * stub as no-ops until the real module is restored.
 */

export function registerAttributionHooks(): void {
  // FIXME: real impl registers PreToolUse/PostToolUse/Stop hooks that
  // capture file-read snapshots and bash-prompt state for commit
  // attribution. No-op stub until original source is recovered.
}

export function sweepFileContentCache(): void {
  // no-op stub
}

export function clearAttributionCaches(): void {
  // no-op stub
}
