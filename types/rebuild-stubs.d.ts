declare module '@ant/computer-use-mcp' {
  export const DEFAULT_GRANT_FLAGS: string[]
  export const API_RESIZE_PARAMS: Record<string, unknown>
  export function targetImageSize(...args: unknown[]): unknown
  export function bindSessionContext<T>(context: T): T
  export function buildComputerUseTools(...args: unknown[]): unknown[]
  export function createComputerUseMcpServer(...args: unknown[]): {
    setRequestHandler: (...handlerArgs: unknown[]) => void
    connect: (...handlerArgs: unknown[]) => Promise<void>
  }
  export type ComputerUseSessionContext = Record<string, unknown>
  export type CuCallToolResult = Record<string, unknown>
  export type CuPermissionRequest = Record<string, unknown>
  export type CuPermissionResponse = Record<string, unknown>
  export type ScreenshotDims = Record<string, unknown>
}

declare module '@ant/computer-use-mcp/types' {
  export const DEFAULT_GRANT_FLAGS: string[]
  export type CoordinateMode = string
  export type CuSubGates = Record<string, unknown>
  export type CuPermissionRequest = Record<string, unknown>
  export type CuPermissionResponse = Record<string, unknown>
}

declare module '@ant/computer-use-mcp/sentinelApps' {
  export function getSentinelCategory(...args: unknown[]): string | undefined
}

declare module '@ant/claude-for-chrome-mcp' {
  export const BROWSER_TOOLS: Array<{ name: string }>
  export type Logger = Record<string, (...args: unknown[]) => void>
  export type PermissionMode =
    | 'ask'
    | 'skip_all_permission_checks'
    | 'follow_a_plan'
  export type ClaudeForChromeContext = Record<string, unknown>
  export function createClaudeForChromeMcpServer(...args: unknown[]): {
    connect: (...connectArgs: unknown[]) => Promise<void>
  }
}

declare module '@ant/computer-use-swift' {
  export type ComputerUseAPI = Record<string, unknown>
}

declare module '@ant/computer-use-input' {
  const computerUseInput: Record<string, unknown>
  export = computerUseInput
}

declare module '@anthropic-ai/mcpb' {
  export type McpbManifest = Record<string, unknown>
  export type McpbUserConfigurationOption = Record<string, unknown>
  export const McpbManifestSchema: {
    parse: (value: unknown) => unknown
  }
  export function getMcpConfigForManifest(...args: unknown[]): unknown
}

declare module '@anthropic-ai/sandbox-runtime' {
  export class SandboxManager {
    constructor(...args: unknown[])
  }
  export const SandboxRuntimeConfigSchema: {
    parse: (value: unknown) => unknown
  }
  export class SandboxViolationStore {
    constructor(...args: unknown[])
  }
  export type FsReadRestrictionConfig = Record<string, unknown>
  export type FsWriteRestrictionConfig = Record<string, unknown>
  export type IgnoreViolationsConfig = Record<string, unknown>
  export type NetworkHostPattern = string
  export type NetworkRestrictionConfig = Record<string, unknown>
  export type SandboxAskCallback = (...args: unknown[]) => unknown
  export type SandboxDependencyCheck = Record<string, unknown>
  export type SandboxRuntimeConfig = Record<string, unknown>
  export type SandboxViolationEvent = Record<string, unknown>
}

declare module 'audio-capture-napi' {
  const audioCapture: Record<string, unknown>
  export = audioCapture
}

declare module 'color-diff-napi' {
  export function diffStrings(...args: unknown[]): string
  export function diffWords(...args: unknown[]): string
  export function diffLines(...args: unknown[]): string
}

declare module 'image-processor-napi' {
  export function getNativeModule(): Record<string, unknown>
}

declare module 'url-handler-napi' {
  export function waitForUrlEvent(...args: unknown[]): Promise<unknown>
}
