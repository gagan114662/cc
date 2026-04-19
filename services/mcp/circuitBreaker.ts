// Per-MCP-server circuit breaker. A hung or reliably-failing MCP server
// must not consume the duty timeout budget on every call — after
// `failureThreshold` consecutive failures the breaker opens and
// subsequent calls fail instantly with MCPCircuitOpenError until
// `cooldownMs` elapses. A single probe is then allowed through
// (half-open); success closes the breaker, failure re-opens it.
//
// Scope: in-memory per-process. Phase 2 may promote to shared state
// (Redis) so multiple daemons converge, but a single-process daemon
// only needs this much.

export type CircuitState = 'closed' | 'open' | 'half-open'

export type CircuitOptions = {
  failureThreshold: number
  cooldownMs: number
  now?: () => number
}

export const DEFAULT_CIRCUIT_OPTIONS: CircuitOptions = {
  failureThreshold: 5,
  cooldownMs: 30_000,
}

type CircuitEntry = {
  state: CircuitState
  consecutiveFailures: number
  openedAt: number | null
}

export class MCPCircuitOpenError extends Error {
  readonly serverName: string
  readonly retryAt: number
  constructor(serverName: string, retryAt: number) {
    super(
      `MCP server "${serverName}" circuit breaker is open — retry after ${new Date(retryAt).toISOString()}`,
    )
    this.name = 'MCPCircuitOpenError'
    this.serverName = serverName
    this.retryAt = retryAt
  }
}

export class MCPCircuitRegistry {
  private readonly entries = new Map<string, CircuitEntry>()
  private readonly opts: CircuitOptions

  constructor(opts: Partial<CircuitOptions> = {}) {
    this.opts = { ...DEFAULT_CIRCUIT_OPTIONS, ...opts }
  }

  private nowMs(): number {
    return (this.opts.now ?? Date.now)()
  }

  private get(serverName: string): CircuitEntry {
    let entry = this.entries.get(serverName)
    if (!entry) {
      entry = { state: 'closed', consecutiveFailures: 0, openedAt: null }
      this.entries.set(serverName, entry)
    }
    return entry
  }

  // Call at the entry of every MCP tool call. Throws MCPCircuitOpenError
  // if the breaker is open and the cooldown hasn't elapsed. If cooldown
  // has elapsed, transitions to half-open and returns (the caller's one
  // probe is allowed through).
  guard(serverName: string): void {
    const entry = this.get(serverName)
    if (entry.state === 'open') {
      const retryAt = (entry.openedAt ?? 0) + this.opts.cooldownMs
      if (this.nowMs() < retryAt) {
        throw new MCPCircuitOpenError(serverName, retryAt)
      }
      entry.state = 'half-open'
    }
  }

  recordSuccess(serverName: string): void {
    const entry = this.get(serverName)
    entry.state = 'closed'
    entry.consecutiveFailures = 0
    entry.openedAt = null
  }

  recordFailure(serverName: string): void {
    const entry = this.get(serverName)
    entry.consecutiveFailures += 1
    if (
      entry.state === 'half-open' ||
      entry.consecutiveFailures >= this.opts.failureThreshold
    ) {
      entry.state = 'open'
      entry.openedAt = this.nowMs()
    }
  }

  getState(serverName: string): CircuitState {
    return this.get(serverName).state
  }

  // Run an async function under the breaker. Convenience wrapper so
  // callers don't have to hand-roll guard/recordSuccess/recordFailure.
  async run<T>(serverName: string, fn: () => Promise<T>): Promise<T> {
    this.guard(serverName)
    try {
      const out = await fn()
      this.recordSuccess(serverName)
      return out
    } catch (err) {
      this.recordFailure(serverName)
      throw err
    }
  }
}

// A process-wide default registry. Tests construct their own; production
// code paths that don't inject a registry share this one so breaker
// state is consistent across every MCP tool call in the daemon.
export const defaultMCPCircuitRegistry = new MCPCircuitRegistry()
