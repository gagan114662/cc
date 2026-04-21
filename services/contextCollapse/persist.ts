import { restoreContextCollapseState } from './index.js'

export function restoreFromEntries(
  commits: unknown[],
  snapshot: unknown,
): void {
  restoreContextCollapseState(commits as never, snapshot as never)
}
