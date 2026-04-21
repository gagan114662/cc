/**
 * History-snip projection: view over a message list that hides messages
 * marked as "snipped" by the history-snip compaction pass.
 *
 * Call sites (all gated on `feature('HISTORY_SNIP')`):
 *   - `QueryEngine.ts`         — `snipProjection!.isSnipBoundaryMessage(yielded)`
 *   - `components/Message.tsx` — `isSnipBoundaryMessage(message)` renderer branch
 *   - `utils/messages.ts::getMessagesAfterCompactBoundary`
 *                              — `projectSnippedView(sliced as Message[])`
 */

import type { Message } from '../../types/message.js'
import { isSnipBoundaryMessage as baseIsSnipBoundaryMessage } from './snipCompact.js'

/**
 * True when the given message is the synthetic "history snip" boundary
 * inserted by snipCompact. Re-exported (thin wrapper) so call sites can
 * import it from either snipCompact or snipProjection — matches how the
 * original module surface was split.
 */
export function isSnipBoundaryMessage(message: Message): boolean {
  return baseIsSnipBoundaryMessage(message)
}

/**
 * Return a view of `messages` with snipped entries hidden. The boundary
 * message itself is preserved so the UI can render the "history snip" marker.
 *
 * FIXME: The real projection drops messages between snip markers and
 * replaces them with the boundary. Until that logic is ported, pass the
 * list through unchanged — this preserves correctness (no data loss) at
 * the cost of not actually hiding snipped content in the view.
 */
export function projectSnippedView(messages: Message[]): Message[] {
  return messages
}
