import type { Message } from '../../types/message.js'
import { projectCollapsedMessages } from './index.js'

export function projectView(messages: Message[]): Message[] {
  return projectCollapsedMessages(messages)
}
