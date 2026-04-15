import { plugin } from 'bun'

// These packages are --external in the production build (see package.json "build" script).
// They are not installed in dev/test and must be stubbed for tests to import source files.

const noop = () => {}
const noopClass = class {}

plugin({
  name: 'mock-externals',
  setup(build) {
    build.module('bun:bundle', () => ({
      exports: { feature: () => false },
      loader: 'object',
    }))

    build.module('@anthropic-ai/sandbox-runtime', () => ({
      exports: {
        SandboxManager: noopClass,
        SandboxRuntimeConfigSchema: {},
        SandboxViolationStore: noopClass,
      },
      loader: 'object',
    }))

    build.module('color-diff-napi', () => ({
      exports: {
        ColorDiff: noopClass,
        ColorFile: noopClass,
        getSyntaxTheme: noop,
      },
      loader: 'object',
    }))

    build.module('@ant/computer-use-mcp', () => ({
      exports: {
        bindSessionContext: noop,
        buildComputerUseTools: noop,
        createComputerUseMcpServer: noop,
        targetImageSize: noop,
        API_RESIZE_PARAMS: {},
        DEFAULT_GRANT_FLAGS: {},
      },
      loader: 'object',
    }))

    build.module('@ant/computer-use-mcp/types', () => ({
      exports: {
        DEFAULT_GRANT_FLAGS: {},
      },
      loader: 'object',
    }))

    build.module('@ant/computer-use-mcp/sentinelApps', () => ({
      exports: {
        getSentinelCategory: noop,
      },
      loader: 'object',
    }))

    build.module('@ant/claude-for-chrome-mcp', () => ({
      exports: {
        BROWSER_TOOLS: [],
        createClaudeForChromeMcpServer: noop,
      },
      loader: 'object',
    }))

    build.module('@ant/computer-use-swift', () => ({
      exports: {
        ComputerUseAPI: noopClass,
      },
      loader: 'object',
    }))

    build.module('@ant/computer-use-input', () => ({
      exports: {
        ComputerUseInput: noopClass,
        ComputerUseInputAPI: noopClass,
      },
      loader: 'object',
    }))

    build.module('@anthropic-ai/mcpb', () => ({
      exports: {},
      loader: 'object',
    }))

    // Packages with no named imports
    for (const pkg of ['audio-capture-napi', 'image-processor-napi', 'url-handler-napi']) {
      build.module(pkg, () => ({
        exports: {},
        loader: 'object',
      }))
    }
  },
})
