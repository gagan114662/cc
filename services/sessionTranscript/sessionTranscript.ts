// Phantom stub — KAIROS session transcript recorder. Not reconstructed in
// this external build. Gated at call sites via feature('KAIROS').

export function recordSessionTranscript(..._args: unknown[]): void {
  throw new Error(
    'recordSessionTranscript: not implemented in external build',
  )
}

export function startSessionTranscript(..._args: unknown[]): unknown {
  throw new Error(
    'startSessionTranscript: not implemented in external build',
  )
}

export function appendTranscriptEvent(..._args: unknown[]): void {
  throw new Error('appendTranscriptEvent: not implemented in external build')
}

export function getSessionTranscript(..._args: unknown[]): unknown {
  throw new Error('getSessionTranscript: not implemented in external build')
}

export function logSessionTranscriptEvent(..._args: unknown[]): void {
  throw new Error(
    'logSessionTranscriptEvent: not implemented in external build',
  )
}
