export type CacheEditsBlock = {
  type: 'cache_edits'
  toolUseIds: string[]
  deletedToolIds: string[]
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
    toolUseIds,
    deletedToolIds: [],
  }
}
