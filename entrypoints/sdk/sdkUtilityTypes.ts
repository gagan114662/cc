/**
 * Phantom stub — utility types that can't be expressed via Zod schemas,
 * re-exported by `entrypoints/sdk/coreTypes.ts`.
 *
 * `NonNullableUsage` is the API `Usage` shape with all normally-optional
 * fields required (zero-initialized via services/api/emptyUsage.ts).
 * Field list reconstructed from services/api/emptyUsage.ts + the
 * updateUsage() / accumulateUsage() bodies in services/api/claude.ts.
 */

export type NonNullableUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  server_tool_use: {
    web_search_requests: number
    web_fetch_requests: number
  }
  service_tier: string
  cache_creation: {
    ephemeral_1h_input_tokens: number
    ephemeral_5m_input_tokens: number
  }
  inference_geo: string
  // FIXME: `iterations` carries per-retry / per-stream diagnostic entries in
  // the real SDK. Elements are opaque here — callsites only spread/replace the
  // array, never inspect individual entries at known sites.
  iterations: unknown[]
  speed: string
  /**
   * Returned by the API when cache editing deletes KV cache content.
   * Excluded from external builds via dead-code-elimination of the
   * `CACHED_MICROCOMPACT` branch in claude.ts, so keep it optional.
   */
  cache_deleted_input_tokens?: number
}
