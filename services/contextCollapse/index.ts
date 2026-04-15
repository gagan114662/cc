import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { QuerySource } from '../../constants/querySource.js'
import { createUserMessage } from '../../utils/messages.js'
import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from '../../types/logs.js'

type ContextCollapseStats = {
  collapsedSpans: number
  stagedSpans: number
  collapsedMessages: number
  health: {
    totalErrors: number
    totalEmptySpawns: number
    totalSpawns: number
    emptySpawnWarningEmitted: boolean
    lastError: string | null
  }
}

const listeners = new Set<() => void>()
type CommittedCollapse = ContextCollapseCommitEntry & { archivedCount: number }
type StagedCollapse = ContextCollapseSnapshotEntry['staged'][number]

const state: {
  enabled: boolean
  commits: CommittedCollapse[]
  staged: StagedCollapse[]
  armed: boolean
  lastSpawnTokens: number
  nextCollapseId: number
  health: ContextCollapseStats['health']
} = {
  enabled: false,
  commits: [],
  staged: [],
  armed: false,
  lastSpawnTokens: 0,
  nextCollapseId: 1,
  health: {
    totalErrors: 0,
    totalEmptySpawns: 0,
    totalSpawns: 0,
    emptySpawnWarningEmitted: false,
    lastError: null,
  },
}

const EMPTY_STATS: ContextCollapseStats = {
  collapsedSpans: 0,
  stagedSpans: 0,
  collapsedMessages: 0,
  health: {
    totalErrors: 0,
    totalEmptySpawns: 0,
    totalSpawns: 0,
    emptySpawnWarningEmitted: false,
    lastError: null,
  },
}

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function getUuid(message: Message): string | undefined {
  const candidate = message as { uuid?: string }
  return candidate.uuid
}

function summarizeMessages(messages: Message[]): string {
  const counts = new Map<string, number>()
  for (const message of messages) {
    counts.set(message.type, (counts.get(message.type) || 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([type, count]) => `${count} ${type}`)
    .join(', ')
}

function nextCollapseId(): string {
  const id = String(state.nextCollapseId).padStart(16, '0')
  state.nextCollapseId += 1
  return id
}

function findEligibleSpan(messages: Message[]): {
  startIndex: number
  endIndex: number
} | null {
  if (messages.length < 48) return null
  const endIndex = Math.max(0, messages.length - 13)
  const startIndex = Math.max(0, endIndex - 23)
  if (endIndex <= startIndex) return null
  return { startIndex, endIndex }
}

function projectMessages(messages: Message[]): Message[] {
  if (!state.enabled || state.commits.length === 0) {
    return messages
  }

  const projected: Message[] = []
  let commitIndex = 0

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const commit = state.commits[commitIndex]
    if (!message || !commit) {
      if (message) projected.push(message)
      continue
    }

    const uuid = getUuid(message)
    if (uuid !== commit.firstArchivedUuid) {
      projected.push(message)
      continue
    }

    let archivedCount = 0
    let cursor = index
    while (cursor < messages.length) {
      const candidate = messages[cursor]
      const candidateUuid = candidate ? getUuid(candidate) : undefined
      archivedCount += 1
      if (candidateUuid === commit.lastArchivedUuid) {
        break
      }
      cursor += 1
    }

    commit.archivedCount = Math.max(commit.archivedCount, archivedCount)
    projected.push(
      createUserMessage({
        content: commit.summaryContent,
        isMeta: true,
        uuid: commit.summaryUuid,
      }) as Message,
    )
    index = cursor
    commitIndex += 1
  }

  return projected
}

function commitSpan(messages: Message[]): { messages: Message[]; committed: number } {
  const span = findEligibleSpan(messages)
  if (!span) {
    state.health.totalEmptySpawns += 1
    state.health.emptySpawnWarningEmitted = state.health.totalEmptySpawns >= 3
    emit()
    return { messages, committed: 0 }
  }

  const archived = messages.slice(span.startIndex, span.endIndex + 1)
  const firstArchivedUuid = archived[0] ? getUuid(archived[0]) : undefined
  const lastArchivedUuid =
    archived[archived.length - 1]
      ? getUuid(archived[archived.length - 1])
      : undefined

  if (!firstArchivedUuid || !lastArchivedUuid) {
    state.health.totalEmptySpawns += 1
    emit()
    return { messages, committed: 0 }
  }

  const collapseId = nextCollapseId()
  const summary = `Collapsed ${archived.length} earlier messages (${summarizeMessages(archived)})`
  const commit: CommittedCollapse = {
    type: 'marble-origami-commit',
    sessionId: '' as ContextCollapseCommitEntry['sessionId'],
    collapseId,
    summaryUuid: `ctx-collapse-${collapseId}`,
    summaryContent: `<collapsed id="${collapseId}">${summary}</collapsed>`,
    summary,
    firstArchivedUuid,
    lastArchivedUuid,
    archivedCount: archived.length,
  }

  state.commits.push(commit)
  state.staged = []
  state.armed = true
  state.health.totalEmptySpawns = 0
  state.health.emptySpawnWarningEmitted = false
  emit()
  return { messages: projectMessages(messages), committed: 1 }
}

export function initContextCollapse(): void {
  state.enabled = process.env.CLAUDE_CODE_CONTEXT_COLLAPSE !== 'false'
  emit()
}

export function resetContextCollapse(): void {
  state.commits = []
  state.staged = []
  state.armed = false
  state.lastSpawnTokens = 0
  state.health = { ...EMPTY_STATS.health }
  emit()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getStats(): ContextCollapseStats {
  if (!state.enabled) return EMPTY_STATS
  return {
    collapsedSpans: state.commits.length,
    stagedSpans: state.staged.length,
    collapsedMessages: state.commits.reduce(
      (sum, commit) => sum + commit.archivedCount,
      0,
    ),
    health: { ...state.health },
  }
}

export function isContextCollapseEnabled(): boolean {
  return state.enabled
}

export async function applyCollapsesIfNeeded(
  messages: Message[],
  _context: ToolUseContext,
  _querySource?: QuerySource,
): Promise<{ messages: Message[] }> {
  if (!state.enabled) return { messages }
  state.health.totalSpawns += 1
  state.lastSpawnTokens = messages.length
  return { messages: commitSpan(messages).messages }
}

export function isWithheldPromptTooLong(
  _message: unknown,
  _isPromptTooLongMessage: (message: unknown) => boolean,
  _querySource?: QuerySource,
): boolean {
  if (!state.enabled) return false
  if (_isPromptTooLongMessage(_message)) return true
  if (
    typeof _message === 'object' &&
    _message !== null &&
    'message' in _message &&
    typeof (_message as { message?: { content?: unknown } }).message?.content ===
      'string'
  ) {
    return (
      ((_message as { message: { content: string } }).message.content || '')
        .length > 8_000
    )
  }
  return false
}

export function recoverFromOverflow(
  messages: Message[],
  _querySource?: QuerySource,
): { messages: Message[]; committed: number } {
  if (!state.enabled) return { messages, committed: 0 }
  return commitSpan(messages)
}

export function restoreContextCollapseState(
  commits: unknown[],
  snapshot: unknown,
): void {
  state.commits = Array.isArray(commits)
    ? commits
        .filter(
          (entry): entry is ContextCollapseCommitEntry =>
            !!entry &&
            typeof entry === 'object' &&
            (entry as { type?: string }).type === 'marble-origami-commit',
        )
        .map(entry => ({
          ...entry,
          archivedCount: 0,
        }))
    : []

  if (
    snapshot &&
    typeof snapshot === 'object' &&
    (snapshot as { type?: string }).type === 'marble-origami-snapshot'
  ) {
    const parsed = snapshot as ContextCollapseSnapshotEntry
    state.staged = Array.isArray(parsed.staged) ? parsed.staged : []
    state.armed = parsed.armed
    state.lastSpawnTokens = parsed.lastSpawnTokens
  } else {
    state.staged = []
    state.armed = false
    state.lastSpawnTokens = 0
  }

  state.nextCollapseId =
    state.commits.reduce((max, entry) => {
      const parsed = Number.parseInt(entry.collapseId, 10)
      return Number.isFinite(parsed) ? Math.max(max, parsed + 1) : max
    }, 1) || 1
  emit()
}

export function projectCollapsedMessages(messages: Message[]): Message[] {
  return projectMessages(messages)
}
