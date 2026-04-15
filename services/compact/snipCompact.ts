import type { Message, SystemMessage } from '../../types/message.js'

export type SnipCompactResult = {
  messages: Message[]
  tokensFreed: number
  boundaryMessage?: SystemMessage
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
