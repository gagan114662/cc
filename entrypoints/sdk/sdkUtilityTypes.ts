/**
 * Phantom stub — utility types that can't be expressed via Zod schemas,
 * re-exported by `entrypoints/sdk/coreTypes.ts`.
 *
 * `NonNullableUsage` is the API `Usage` shape with all normally-optional
 * fields required. Mirrors the definition in
 * `@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.d.ts` so that
 * values flow across the SDK boundary without TS2322.
 */

import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

export type NonNullableUsage = {
  [K in keyof Usage]: NonNullable<Usage[K]>
}
