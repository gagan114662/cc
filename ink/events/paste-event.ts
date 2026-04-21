// Phantom stub — PasteEvent. Not reconstructed in this external build.

import { TerminalEvent } from './terminal-event.js'

/**
 * Paste event. Fired when the terminal delivers a bracketed-paste payload.
 * Matches the shape assumed by ink/events/event-handlers.ts.
 */
export class PasteEvent extends TerminalEvent {
  readonly text: string

  constructor(type: 'paste', text: string) {
    super(type)
    this.text = text
  }
}
