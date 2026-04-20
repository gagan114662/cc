// Reconstructed phantom module. Both importers
// (UnifiedInstalledCell.tsx, ManagePlugins.tsx) use `import type`, so this
// file only needs to publish the discriminated union describing rows in the
// plugin manager's unified installed list.
//
// Variants and fields are derived from object-literal construction sites in
// ManagePlugins.tsx (type: 'plugin' | 'failed-plugin' | 'flagged-plugin' |
// 'mcp') and from property access in UnifiedInstalledCell.tsx.

import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'

export type UnifiedInstalledScope =
  | 'user'
  | 'project'
  | 'local'
  | 'managed'
  | 'builtin'
  | 'enterprise'
  | 'dynamic'
  | 'flagged'

export type UnifiedInstalledPluginItem = {
  type: 'plugin'
  id: string
  name: string
  description?: string
  marketplace?: string
  scope: UnifiedInstalledScope
  isEnabled: boolean
  errorCount: number
  errors: PluginError[]
  plugin: LoadedPlugin
  pendingEnable?: boolean
  pendingUpdate?: boolean
  pendingToggle?: 'will-enable' | 'will-disable'
}

export type UnifiedInstalledFailedPluginItem = {
  type: 'failed-plugin'
  id: string
  name: string
  marketplace?: string
  scope: UnifiedInstalledScope
  errorCount: number
  errors: PluginError[]
}

export type UnifiedInstalledFlaggedPluginItem = {
  type: 'flagged-plugin'
  id: string
  name: string
  marketplace?: string
  scope: 'flagged'
  // FIXME: the 'reason' discriminant may grow beyond 'delisted'; inferred
  // from a single construction site in ManagePlugins.tsx.
  reason: 'delisted'
  text: string
  flaggedAt?: number
}

export type UnifiedInstalledMcpItem = {
  type: 'mcp'
  id: string
  name: string
  description?: string | undefined
  scope: UnifiedInstalledScope
  // Mirrors the return type of getMcpStatus() in ManagePlugins.tsx.
  status: 'connected' | 'disabled' | 'pending' | 'needs-auth' | 'failed'
  client: MCPServerConnection
  /** True when the row is rendered indented underneath a parent plugin. */
  indented?: boolean
}

export type UnifiedInstalledItem =
  | UnifiedInstalledPluginItem
  | UnifiedInstalledFailedPluginItem
  | UnifiedInstalledFlaggedPluginItem
  | UnifiedInstalledMcpItem
