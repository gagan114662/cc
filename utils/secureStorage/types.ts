// Discovery state persisted alongside OAuth tokens for MCP servers where
// the authorization server is at a different host than the MCP URL (XAA).
export type McpOAuthDiscoveryState = {
  authorizationServerUrl?: string
  resourceMetadataUrl?: string
  resourceMetadata?: unknown
  authorizationServerMetadata?: unknown
}

export type McpOAuthTokenData = {
  serverName?: string
  serverUrl?: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  clientId?: string
  clientSecret?: string
  discoveryState?: McpOAuthDiscoveryState
  stepUpScope?: string
}

export type McpOAuthClientConfig = {
  clientId?: string
  clientSecret?: string
  [key: string]: unknown
}

// Widened from `Record<string, unknown>` so callers in services/mcp/auth.ts
// can index/spread the well-known `mcpOAuth` / `mcpOAuthClientConfig`
// sub-records by serverKey without triggering TS7053. Other top-level keys
// remain open via the index signature.
export type SecureStorageData = {
  mcpOAuth?: Record<string, McpOAuthTokenData | undefined>
  mcpOAuthClientConfig?: Record<string, McpOAuthClientConfig | undefined>
  mcpXaaIdp?: Record<string, { idToken: string; expiresAt: number } | undefined>
  mcpXaaIdpConfig?: Record<string, { clientSecret: string } | undefined>
  pluginSecrets?: Record<string, Record<string, unknown> | undefined>
  // Stored Claude.ai OAuth tokens. Loose-typed here (avoids importing
  // services/oauth/types.ts to keep this module dependency-light); callers
  // in utils/auth.ts narrow via the OAuthTokens shape on read/write.
  claudeAiOauth?: import('../../services/oauth/types.js').OAuthTokens
  [key: string]: unknown
}

export type SecureStorage = {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): void
}
