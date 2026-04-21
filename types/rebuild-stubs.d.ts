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
  export type ComputerExecutor = Record<string, unknown>
  export type CuCallToolResult = Record<string, unknown>
  export type CuPermissionRequest = Record<string, unknown>
  export type CuPermissionResponse = Record<string, unknown>
  export type DisplayGeometry = Record<string, unknown>
  export type FrontmostApp = Record<string, unknown>
  export type InstalledApp = Record<string, unknown>
  export type ResolvePrepareCaptureResult = Record<string, unknown>
  export type RunningApp = Record<string, unknown>
  export type ScreenshotDims = Record<string, unknown>
  export type ScreenshotResult = Record<string, unknown>
}

declare module '@ant/computer-use-mcp/types' {
  export const DEFAULT_GRANT_FLAGS: string[]
  export type CoordinateMode = string
  export type ComputerUseHostAdapter = Record<string, unknown>
  export type CuSubGates = Record<string, unknown>
  export type CuPermissionRequest = Record<string, unknown>
  export type CuPermissionResponse = Record<string, unknown>
  export type Logger = {
    debug: (...args: unknown[]) => void
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
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
  // Native module: key surface used by the CLI executor is typed loosely so
  // property access through swiftLoader doesn't fall back to `unknown`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ComputerUseAPI = { [key: string]: any }
}

declare module '@ant/computer-use-input' {
  // Native module: mouse/keyboard entry points are typed loosely so
  // consumers don't have to re-cast on every call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ComputerUseInput = { isSupported: boolean; [key: string]: any }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ComputerUseInputAPI = { [key: string]: any }
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
  export type NetworkHostPattern = {
    host: string
    [key: string]: unknown
  }
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

declare module 'react/compiler-runtime' {
  // React Compiler auto-injects `import { c as _c } from 'react/compiler-runtime'`
  // then writes `const $ = _c(n); if ($[i] === sentinel) $[i] = value; return $[i]`.
  // Return `any[]` so the cache-slot reads erase type-wise — otherwise every
  // memoized JSX expression degrades to `unknown` and cascades TS2786/TS18046.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function c(size: number): any[]
}
