// Phantom stub — Cursor type for ink frame state. Not reconstructed in this
// external build. Kept structural so render/frame code type-checks.

export type Cursor = {
  row?: number
  col?: number
  x?: number
  y?: number
  visible: boolean
  shape?: 'block' | 'underline' | 'bar'
  blinking?: boolean
  [key: string]: unknown
}
