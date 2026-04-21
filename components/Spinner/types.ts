export type RGBColor = { r: number; g: number; b: number }

export type SpinnerMode =
  | 'idle'
  | 'requesting'
  | 'responding'
  | 'thinking'
  | 'tool'
  | 'tool-use'
  | 'tool-input'
  | 'streaming'
  | 'error'
