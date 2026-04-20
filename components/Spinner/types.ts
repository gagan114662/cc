export type RGBColor = { r: number; g: number; b: number }

export type SpinnerMode =
  | 'idle'
  | 'requesting'
  | 'thinking'
  | 'tool'
  | 'streaming'
  | 'error'
