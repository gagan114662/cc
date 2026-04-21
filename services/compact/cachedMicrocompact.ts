export type CacheEditsBlock = {
  type: 'cache_edits'
  edits: { type: 'delete'; cache_reference: string }[]
}

export type PinnedCacheEdits = {
  userMessageIndex: number
  block: CacheEditsBlock
}

export type CachedMCState = {
  pinnedEdits: PinnedCacheEdits[]
  sentToolUseIds: Set<string>
  registeredTools: Set<string>
  toolOrder: string[]
  deletedRefs: Set<string>
}

export function createCachedMCState(): CachedMCState {
  return {
    pinnedEdits: [],
    sentToolUseIds: new Set(),
    registeredTools: new Set(),
    toolOrder: [],
    deletedRefs: new Set(),
  }
}

export function registerToolResult(
  _state: CachedMCState,
  _toolUseId: string,
): void {}

export function registerToolMessage(
  _state: CachedMCState,
  _toolUseIds: string[],
): void {}

export function getToolResultsToDelete(_state: CachedMCState): string[] {
  return []
}

export function createCacheEditsBlock(
  _state: CachedMCState,
  _toolUseIds: string[],
): CacheEditsBlock | null {
  return null
}

export function markToolsSentToAPI(state: CachedMCState): void {
  state.sentToolUseIds.clear()
}

export function resetCachedMCState(state: CachedMCState): void {
  state.pinnedEdits = []
  state.sentToolUseIds.clear()
}

export function buildCacheEditsBlock(toolUseIds: string[]): CacheEditsBlock {
  return {
    type: 'cache_edits',
    edits: toolUseIds.map(id => ({ type: 'delete', cache_reference: id })),
  }
}

export function isCachedMicrocompactEnabled(): boolean {
  return false
}

export function isModelSupportedForCacheEditing(_model: string): boolean {
  return false
}

export function getCachedMCConfig(): {
  supportedModels: string[]
  triggerThreshold: number
  keepRecent: number
} {
  return { supportedModels: [], triggerThreshold: 0, keepRecent: 0 }
}

export type CachedMCEditsBlock = CacheEditsBlock
