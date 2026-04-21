// Phantom stub — memdir shape telemetry. Not reconstructed in this external
// build. Gated at call sites via feature('MEMORY_SHAPE_TELEMETRY').

export function logMemoryRecallShape(..._args: unknown[]): void {
  throw new Error('logMemoryRecallShape: not implemented in external build')
}

export function logMemoryReadShape(..._args: unknown[]): void {
  throw new Error('logMemoryReadShape: not implemented in external build')
}

export function logMemoryWriteShape(..._args: unknown[]): void {
  throw new Error('logMemoryWriteShape: not implemented in external build')
}
