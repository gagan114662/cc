/**
 * Phantom stub — proactive/KAIROS autonomous-mode controller.
 *
 * All callsites `require('../proactive/index.js')` under a
 * `feature('PROACTIVE') || feature('KAIROS')` guard, so this file is only
 * pulled in on those builds. Surface derived from:
 *
 *   - constants/prompts.ts         — isProactiveActive()
 *   - cli/print.ts                 — isProactiveActive(), activateProactive('command')
 *   - services/compact/prompt.ts   — isProactiveActive()
 *   - main.tsx:4632                — isProactiveActive(), activateProactive('command')
 *   - components/PromptInput/usePromptInputPlaceholder.ts — isProactiveActive()
 *   - tools/AgentTool/AgentTool.tsx— isProactiveActive()
 *   - components/PromptInput/PromptInputFooterLeftSide.tsx
 *                                  — subscribeToProactiveChanges, getNextTickAt
 *   - components/Messages.tsx      — isProactiveActive()
 *   - utils/systemPrompt.ts        — isProactiveActive()
 *   - commands/clear/conversation.ts — setContextBlocked(boolean)
 *   - screens/REPL.tsx             — subscribeToProactiveChanges, isProactiveActive,
 *                                    pauseProactive, resumeProactive, setContextBlocked
 */

type Unsubscribe = () => void

export function isProactiveActive(): boolean {
  return false
}

// Used by cli/print.ts scheduleProactiveTick + main loop to suppress
// tick injection while the user has paused proactive mode. Complements
// pauseProactive/resumeProactive. Phantom stub; real impl tracks
// pause state alongside activation.
export function isProactivePaused(): boolean {
  return false
}

export function activateProactive(_source: string): void {
  throw new Error('not implemented')
}

export function deactivateProactive(): void {
  throw new Error('not implemented')
}

export function pauseProactive(): void {
  throw new Error('not implemented')
}

export function resumeProactive(): void {
  throw new Error('not implemented')
}

export function setContextBlocked(_blocked: boolean): void {
  throw new Error('not implemented')
}

export function subscribeToProactiveChanges(_cb: () => void): Unsubscribe {
  return () => {}
}

// FIXME: return type inferred from usage (React.useSyncExternalStore
// default value is `NULL` at callsites). Real impl may return `number`
// (epoch ms) or null when inactive.
export function getNextTickAt(): number | null {
  return null
}
