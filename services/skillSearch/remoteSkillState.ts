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

// Strips the canonical 'remote/' (or similar) prefix from a command name and
// returns the slug, or null if the name isn't a canonical remote-skill name.
// Phantom stub — always returns null in external builds because no remote
// skills are discoverable.
export function stripCanonicalPrefix(_name: string): string | null {
  return null
}

// Looks up a remote skill discovered earlier in this session. Returns the
// metadata (URL + display fields) needed to load the skill, or undefined if
// no skill with that slug was discovered.
export function getDiscoveredRemoteSkill(
  _slug: string,
):
  | {
      url: string
      [key: string]: unknown
    }
  | undefined {
  return undefined
}
