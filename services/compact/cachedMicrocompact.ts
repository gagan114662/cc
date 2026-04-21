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
}

export function createCachedMCState(): CachedMCState {
  return {
    pinnedEdits: [],
    sentToolUseIds: new Set(),
  }
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

export function getCachedMCConfig(): { supportedModels: string[] } {
  return { supportedModels: [] }
}

export type CachedMCEditsBlock = CacheEditsBlock
