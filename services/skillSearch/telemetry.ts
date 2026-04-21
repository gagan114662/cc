// Phantom stub — skill-search telemetry. Not reconstructed in this external
// build. Gated at call sites via feature('EXPERIMENTAL_SKILL_SEARCH').

export function logSkillSearchEvent(..._args: unknown[]): void {
  throw new Error('logSkillSearchEvent: not implemented in external build')
}

export function logSkillSelection(..._args: unknown[]): void {
  throw new Error('logSkillSelection: not implemented in external build')
}

export function logSkillDiscoveryShape(..._args: unknown[]): void {
  throw new Error(
    'logSkillDiscoveryShape: not implemented in external build',
  )
}

// Logged on every loadRemoteSkill() outcome (success or failure). Phantom
// stub — real impl forwards a structured event to the telemetry pipeline.
export function logRemoteSkillLoaded(_payload: {
  slug: string
  cacheHit: boolean
  latencyMs: number
  urlScheme?: string
  fileCount?: number
  totalBytes?: number
  fetchMethod?: string
  error?: string
  [key: string]: unknown
}): void {
  // no-op in external build
}
