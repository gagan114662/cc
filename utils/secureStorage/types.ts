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
  [key: string]: unknown
}

export type SecureStorage = {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): void
}
