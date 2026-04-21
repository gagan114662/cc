// Beta API types not yet exported from the installed @anthropic-ai/sdk
// version. Shapes mirror the runtime wire format accepted by the messages
// endpoint (see services/api/claude.ts callsites for the contract).

// Structured-output configuration carried on the request body as
// `output_config`. The SDK's published types don't include it yet; the
// runtime accepts the shape below.
export type BetaOutputConfig = {
  effort?: string
  [key: string]: unknown
}

// Structured-output format descriptor for the `output_format` field.
// The runtime accepts a JSON schema or a shorthand literal.
export type BetaJSONOutputFormat =
  | {
      type: 'json_schema'
      name?: string
      description?: string
      schema: Record<string, unknown>
      strict?: boolean
    }
  | {
      type: 'json'
    }
