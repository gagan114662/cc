// Reconstructed phantom module. All three importers
// (SSETransport.ts, WebSocketTransport.ts, transportUtils.ts) use
// `import type { Transport }`, so this file only needs to publish the
// structural interface that SSETransport and WebSocketTransport implement.
//
// Surface derived from:
//   - `class SSETransport implements Transport`   (cli/transports/SSETransport.ts)
//   - `class WebSocketTransport implements Transport` (cli/transports/WebSocketTransport.ts)
//   - Consumer callsites: cli/remoteIO.ts, bridge/remoteBridgeCore.ts,
//     bridge/replBridge.ts, bridge/bridgeMessaging.ts.

import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import type { StreamClientEvent } from './SSETransport.js'

export interface Transport {
  /** Open the underlying connection. May be async (SSE returns a Promise;
   *  WebSocketTransport also returns a Promise). */
  connect(): Promise<void> | void

  /** Tear down the connection and any reconnect timers. Synchronous on both
   *  current implementations. */
  close(): void

  /** Enqueue/send a message. Returns a Promise because SSETransport does an
   *  HTTP POST under the hood and WebSocketTransport buffers for replay. */
  write(message: StdoutMessage): Promise<void>

  /** Data-frame callback (newline-delimited JSON payloads). */
  setOnData(callback: (data: string) => void): void

  /** Close callback, optionally with a WS/HTTP close code. */
  setOnClose(callback: (closeCode?: number) => void): void

  // Optional — only some transports implement these. Marked optional so
  // consumers that hold a `Transport` reference can call them guarded.
  // FIXME: verify whether setOnEvent/setOnConnect should be required on the
  // interface; SSETransport defines setOnEvent, WebSocketTransport defines
  // setOnConnect, and callers (remoteBridgeCore, ccrClient) invoke them
  // against the concrete classes.
  setOnEvent?(callback: (event: StreamClientEvent) => void): void
  setOnConnect?(callback: () => void): void

  /** Status probes used by the bridge/REPL layer. */
  isConnectedStatus(): boolean
  isClosedStatus(): boolean

  /** Diagnostic label for logs. Present on WebSocketTransport; optional on
   *  the interface since SSETransport does not expose it. */
  getStateLabel?(): string
}
