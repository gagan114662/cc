// Phantom stub — remote skill loader. Not reconstructed in this external
// build. Gated at call sites via feature('EXPERIMENTAL_SKILL_SEARCH').

export async function loadRemoteSkill(..._args: unknown[]): Promise<unknown> {
  throw new Error('loadRemoteSkill: not implemented in external build')
}

export async function fetchRemoteSkillIndex(
  ..._args: unknown[]
): Promise<unknown> {
  throw new Error('fetchRemoteSkillIndex: not implemented in external build')
}

export async function resolveRemoteSkill(
  ..._args: unknown[]
): Promise<unknown> {
  throw new Error('resolveRemoteSkill: not implemented in external build')
}
