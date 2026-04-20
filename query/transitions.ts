// Phantom stub — query-loop transition types. Not reconstructed in this
// external build. Callers use these as structural types only.

/**
 * Reason a queryLoop iteration decided to continue rather than terminate.
 * Shape kept generic so union narrowing at call sites stays permissive.
 */
export type Continue = {
  readonly kind: string
  readonly reason?: string
  [key: string]: unknown
}

/**
 * Terminal result of the query loop. Shape kept generic so consumers can
 * treat it as an opaque return value.
 */
export type Terminal = {
  readonly kind: 'terminal' | string
  readonly reason?: string
  [key: string]: unknown
}
