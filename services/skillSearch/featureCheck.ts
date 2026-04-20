/**
 * Runtime feature-check for the experimental skill-search module.
 *
 * Call sites (all gated behind `feature('EXPERIMENTAL_SKILL_SEARCH')` so this
 * module is only `require()`d when that build flag is on):
 *   - `constants/prompts.ts`      — `skillSearchFeatureCheck?.isSkillSearchEnabled()`
 *   - `tools/SkillTool/SkillTool.ts` — `remoteSkillModules!.isSkillSearchEnabled()`
 *   - `utils/attachments.ts`      — `skillSearchModules?.featureCheck.isSkillSearchEnabled()`
 *
 * The module is captured (not the function directly) so Vitest `spyOn()`
 * patches propagate — see the comment in `constants/prompts.ts`.
 */

/**
 * Whether the experimental skill-search capability should be active for this
 * session. Returning `false` disables downstream skill-search features
 * (DiscoverSkills guidance, capability rank limits, was_discovered tagging).
 *
 * FIXME: Real implementation likely checks user/org rollout flags, an env
 * var, or settings. Safe default until the live policy is ported.
 */
export function isSkillSearchEnabled(): boolean {
  return false
}
