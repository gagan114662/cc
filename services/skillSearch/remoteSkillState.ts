// Phantom stub — remote skill state. Not reconstructed in this external
// build. Gated at call sites via feature('EXPERIMENTAL_SKILL_SEARCH').

export function getRemoteSkillState(..._args: unknown[]): unknown {
  throw new Error('getRemoteSkillState: not implemented in external build')
}

export function setRemoteSkillState(..._args: unknown[]): void {
  throw new Error('setRemoteSkillState: not implemented in external build')
}

export function clearRemoteSkillState(..._args: unknown[]): void {
  throw new Error('clearRemoteSkillState: not implemented in external build')
}

export function hasRemoteSkillState(..._args: unknown[]): boolean {
  return false
}
