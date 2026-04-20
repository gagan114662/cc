// Phantom stub — ResizeEvent. Not reconstructed in this external build.

import { TerminalEvent } from './terminal-event.js'

/**
 * Resize event. Fired when the terminal window size changes.
 * Matches the shape assumed by ink/events/event-handlers.ts.
 */
export class ResizeEvent extends TerminalEvent {
  readonly columns: number
  readonly rows: number

  constructor(type: 'resize', columns: number, rows: number) {
    super(type)
    this.columns = columns
    this.rows = rows
  }
}
