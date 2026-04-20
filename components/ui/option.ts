// Phantom stub — Option type for list/dropdown components. Not reconstructed
// in this external build. Kept shape-compatible with typical option-pickers.

export type Option<T = unknown> = {
  value: T
  label: string
  description?: string
  disabled?: boolean
  [key: string]: unknown
}
