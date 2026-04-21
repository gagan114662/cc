export type KeybindingContextName =
  | 'Global'
  | 'Chat'
  | 'Autocomplete'
  | 'Confirmation'
  | 'Help'
  | 'Transcript'
  | 'HistorySearch'
  | 'Task'
  | 'ThemePicker'
  | 'Settings'
  | 'Tabs'
  | 'Attachments'
  | 'Footer'
  | 'MessageSelector'
  | 'DiffDialog'
  | 'ModelPicker'
  | 'Select'
  | 'Plugin'
  | 'Scroll'
  | 'MessageActions'

export type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type Chord = ParsedKeystroke[]

export type ParsedBinding = {
  chord: Chord
  action: string | null
  context: KeybindingContextName
}

export type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, string | null>
}

// Action identifier (e.g. "confirm", "cancel", "cycleTheme"). String-typed
// because the action set is defined at the caller level (per-context), not
// enumerated in a single union.
export type KeybindingAction = string
