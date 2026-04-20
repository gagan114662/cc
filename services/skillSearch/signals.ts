// Phantom stub — skill-search discovery signals type. Not reconstructed in
// this external build. Consumers reference it as a type only (erased at
// compile time), so a permissive record keeps callers satisfied.

export type DiscoverySignal = {
  kind: string
  weight?: number
  source?: string
  [key: string]: unknown
}
