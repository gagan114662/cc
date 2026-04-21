import type { Message, SystemMessage } from '../../types/message.js'

export type SnipCompactResult = {
  messages: Message[]
  tokensFreed: number
  boundaryMessage?: SystemMessage
}

export const SNIP_NUDGE_TEXT =
  'Older messages have been condensed to keep the context window efficient. Long-ago tool outputs may be summarized.'

export function isSnipRuntimeEnabled(): boolean {
  return false
}

export function isSnipBoundaryMessage(message: Message): boolean {
  return (
    message.type === 'system' &&
    typeof message.content === 'string' &&
    message.content.includes('history snip')
  )
}

export function snipCompactIfNeeded(
  messages: Message[],
  _options?: { force?: boolean },
): SnipCompactResult {
  return {
    messages,
    tokensFreed: 0,
  }
}
