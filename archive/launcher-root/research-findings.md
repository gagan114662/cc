# Claude Code Rebuilt — Deep Technical Analysis

> Generated from direct source inspection of `src 2/` (26,692 TS/TSX files across ~40 subsystems)
> Research date: 2026-04-14

---

## 1. Entry Point & Boot Sequence

### Primary Entry: `src 2/entrypoints/cli.tsx`

The CLI entry is a **fast-path dispatcher** before any heavy loading occurs. All imports are dynamic to minimize module evaluation on rarely-hit paths.

```typescript
// cli.tsx — build-time macro for version (zero imports for --version flag)
const CLI_VERSION =
  typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string'
    ? MACRO.VERSION
    : '0.0.0-rebuilt';
```

**Fast paths handled before loading main.tsx:**
- `--version` / `-v` / `-V` — zero imports; prints and exits
- `--dump-system-prompt` — renders system prompt and exits (ant-only via `feature()` DCE)
- `--claude-in-chrome-mcp` — spawns Chrome MCP server
- `--chrome-native-host` — native messaging host for browser extension
- `--computer-use-mcp` — computer use MCP server (CHICAGO_MCP feature flag)
- `--daemon-worker=<kind>` — lean worker subprocess (no analytics, no configs)
- `remote-control` / `rc` / `remote` / `sync` / `bridge` — bridge mode
- `daemon` — long-running supervisor daemon
- `ps` / `logs` / `attach` / `kill` / `--bg` — background session management

### Main Entry: `src 2/main.tsx` (4,696 lines)

The **first three lines that execute** are side-effectful import-time calls, by design:

```typescript
// Line 12: profileCheckpoint fires before heavy module evaluation
profileCheckpoint('main_tsx_entry');

// Line 16: MDM config reads (plutil/reg query) run in parallel with imports
startMdmRawRead();

// Line 20: macOS keychain reads (OAuth + API key) fire in parallel
startKeychainPrefetch();  // saves ~65ms on every macOS startup
```

### Full Startup Sequence

```
cli.tsx: fast-path dispatch or dynamic import main.tsx
  ↓
main.tsx module evaluation:
  profileCheckpoint('main_tsx_entry')
  startMdmRawRead()          ← parallel MDM subprocess
  startKeychainPrefetch()    ← parallel keychain reads
  ~135ms of remaining imports
  ↓
init() function:
  GrowthBook init + OTel init + MCP official registry prefetch
  checkHasTrustDialogAccepted()
  initBuiltinPlugins() + initBundledSkills()
  getMcpToolsCommandsAndResources()
  ↓
renderAndRun() → App.tsx (React tree mounted into custom Ink renderer)
```

**Startup profiling phases tracked (for analytics):**
- `import_time`: cli_entry → main_tsx_imports_loaded
- `init_time`: init_function_start → init_function_end
- `settings_time`: eagerLoadSettings_start → eagerLoadSettings_end
- `total_time`: cli_entry → main_after_run

Profiling is sampled: 100% of internal (ant) users, 0.5% of external users.

---

## 2. Architecture Overview

### File Counts Per Subsystem

| Subsystem | TS/TSX files |
|-----------|-------------|
| `components/` | 390 |
| `tools/` | 192 |
| `commands/` | 195 |
| `services/` | 135 |
| `ink/` | 98 |
| `state/` | 6 |
| `vim/` | 5 |
| `coordinator/` | 1 (feature-flagged) |

### Top-Level Source Files of Interest

| File | Lines | Role |
|------|-------|------|
| `main.tsx` | 4,696 | CLI entry, startup, Commander.js parsing |
| `QueryEngine.ts` | — | AI conversation loop, retry, cost tracking, tool dispatch |
| `query.ts` | — | Raw Anthropic API streaming call |
| `Tool.ts` | 792 | Tool base type + all contracts |
| `Task.ts` | ~130 | Task state machine, ID generation |
| `tools.ts` | 389 | Tool registry + feature-flag conditional loader |
| `commands.ts` | — | Slash-command registry |

### Major Subsystems

```
entrypoints/   → Binary entry points (cli, agentSdk, mcp, workerAgent)
tools/         → 40 tool implementations
commands/      → 60+ slash commands
components/    → ~120 React/Ink UI components
services/      → Background services (MCP, OAuth, compact, analytics, voice)
state/         → Immutable global state store
ink/           → Custom terminal renderer
vim/           → Full vim mode engine
coordinator/   → Multi-agent coordination
remote/        → Remote session management (WebSocket)
bridge/        → IDE bridge protocol
skills/        → Skill runner (Markdown-defined commands)
plugins/       → Plugin system
bootstrap/     → Global state initialization (sessionId, cwd, flags)
utils/         → ~80 utility modules
types/         → Centralized shared types (permissions, tools, ids)
migrations/    → Settings schema migrations
memdir/        → ~/.claude/memory/ reader
upstreamproxy/ → IDE proxy relay
```

---

## 3. Custom Ink Renderer

The project ships its **own terminal renderer** — not the upstream `ink` npm package (though `ink` appears in `package.json` as a dependency, the custom renderer in `src 2/ink/` overrides it for the main rendering path).

### Key Files

| File | Role |
|------|------|
| `ink/reconciler.ts` | React Fiber → virtual DOM (wraps `react-reconciler`) |
| `ink/renderer.ts` | Layout engine (Yoga WASM box model) |
| `ink/render-node-to-output.ts` | Virtual DOM → Output cells |
| `ink/render-to-screen.ts` | Screen buffer for search/match rendering |
| `ink/optimizer.ts` | Frame diff → minimal ANSI patch list |
| `ink/bidi.ts` | Unicode BiDi algorithm (RTL support) |
| `ink/parse-keypress.ts` | Full keypress parsing |
| `ink/wrapAnsi.ts` | ANSI-aware word wrap |
| `ink/screen.js` | Screen buffer with StylePool, CharPool, HyperlinkPool |
| `ink/output.ts` | Output accumulator with grapheme clustering cache |

### Reconciler (reconciler.ts)

Uses `react-reconciler` directly, implementing a custom host environment:

```typescript
// Fiber introspection for debug repaint overlay
type FiberLike = {
  elementType?: { displayName?: string; name?: string } | string | null
  _debugOwner?: FiberLike | null
  return?: FiberLike | null
}

export function getOwnerChain(fiber: unknown): string[] { ... }
// Walks up to 50 fibers to build the component ownership chain
```

- `applyProp()` routes props to: style (Yoga), textStyles, event handlers, or generic attributes
- Yoga WASM nodes are freed with `freeRecursive()` on unmount, with a careful ordering to avoid freeing WASM memory that other code might reference during concurrent operations
- Dev mode: optionally connects to `react-devtools-core`

### Renderer (renderer.ts)

```typescript
export default function createRenderer(node: DOMElement, stylePool: StylePool): Renderer {
  // Output object persists across frames — charCache (tokenize + grapheme clustering)
  // persists so most unchanged lines don't re-tokenize
  let output: Output | undefined
  return options => { ... }
}
```

- Validates Yoga layout dimensions before rendering (guards against `NaN`, `Infinity`, negative values that would throw `RangeError`)
- Uses front/back framebuffer swap with contamination tracking (prevents stale inverted cells after selection overlay or alt-screen reset)

### Frame Optimizer (optimizer.ts)

Single-pass diff optimizer that reduces ANSI escape sequences:
- Removes empty stdout patches
- **Merges consecutive cursorMove patches** (x+dx, y+dy accumulation)
- Collapses consecutive cursorTo (only last one matters)
- Concatenates adjacent style patches (transition diffs)
- Dedupes consecutive hyperlinks with same URI
- Cancels cursor hide/show pairs
- Removes clear patches with count 0

### BiDi Support (bidi.ts)

Software BiDi reordering for terminals that lack native RTL support:

```typescript
function needsBidi(): boolean {
  return (
    process.platform === 'win32' ||
    typeof process.env['WT_SESSION'] === 'string' || // WSL in Windows Terminal
    process.env['TERM_PROGRAM'] === 'vscode' // VS Code integrated terminal
  )
}
```

Applies the Unicode BiDi algorithm to reorder `ClusteredChar` arrays from logical to visual order before Ink's LTR cell placement loop.

### Search Rendering (render-to-screen.ts)

A secondary rendering path used exclusively for **search highlighting**:
- Renders a single React element (one message) to an isolated `Screen` buffer
- Scans that buffer for a query string to get exact `(row, col)` match positions
- Reuses root/container/pools across calls for performance (~1-3ms per call)
- Uses `LegacyRoot` (not `ConcurrentRoot`) to avoid scheduler cross-root leaks

---

## 4. Tool System

### Tool Base Contract (Tool.ts, 792 lines)

```typescript
export type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number }

// Tool is built via buildTool(ToolDef) — not a class
export type ToolDef = { ... }
```

Tools are **not classes** — they are plain objects built by `buildTool()`. Each tool defines:
- `name`: identifier string
- `inputSchema`: Zod v4 schema (validated before `call()`)
- `call()`: async function returning `ToolResultBlockParam`
- `renderToolUseMessage()`: React component for UI
- `isEnabled()`: capability check (async)
- `checkPermissions()`: permission gate
- `description`: string for system prompt

### Tool Registry (tools.ts, 389 lines)

The registry uses **feature-flag-gated conditional loading** via `bun:bundle`'s `feature()`:

```typescript
// Dead code elimination: conditional import for ant-only tools
const REPLTool = process.env.USER_TYPE === 'ant'
  ? require('./tools/REPLTool/REPLTool.js').REPLTool
  : null

// Feature-flag gated tools
const cronTools = feature('AGENT_TRIGGERS') ? [CronCreateTool, CronDeleteTool, CronListTool] : []
const RemoteTriggerTool = feature('AGENT_TRIGGERS_REMOTE') ? ... : null
const SleepTool = feature('PROACTIVE') || feature('KAIROS') ? ... : null

// Circular dep breaking via lazy require
const getTeamCreateTool = () => require('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
```

### Tool Categories (40 total)

| Category | Tools |
|----------|-------|
| **File system** | FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool |
| **Shell** | BashTool, PowerShellTool |
| **Agent orchestration** | AgentTool, SkillTool, WorkflowTool |
| **Task management** | TaskCreateTool, TaskGetTool, TaskListTool, TaskUpdateTool, TaskStopTool, TaskOutputTool |
| **Team/swarm** | TeamCreateTool, TeamDeleteTool, SendMessageTool |
| **Scheduling** | ScheduleCronTool (CronCreate/Delete/List), RemoteTriggerTool |
| **Web** | WebFetchTool, WebSearchTool |
| **MCP** | MCPTool, ListMcpResourcesTool, ReadMcpResourceTool |
| **Development** | NotebookEditTool, REPLTool (ant-only), LSPTool |
| **Planning** | EnterPlanModeTool, ExitPlanModeTool (V2), EnterWorktreeTool, ExitWorktreeTool |
| **UI/control** | AskUserQuestionTool, TodoWriteTool, ToolSearchTool, SyntheticOutputTool |
| **Internal/ant** | BriefTool, TungstenTool, SuggestBackgroundPRTool, MonitorTool |

### BashTool Deep Dive (BashTool.tsx)

The most feature-rich tool. Notable internals:
- Parses commands into semantic categories for collapsible display:
  ```typescript
  const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', ...])
  const BASH_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'jq', 'awk', ...])
  const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du'])
  const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])
  ```
- AST-based security parsing (`utils/bash/ast.ts`)
- Sandbox adapter (`utils/sandbox/sandbox-adapter.ts`)
- `sed`-style edit command parser (`bashTool/sedEditParser.ts`)
- Read-only constraint validation
- File history tracking (`fileHistoryTrackEdit`)
- Git operation detection (`trackGitOperations`)
- In assistant mode: auto-backgrounds blocking bash after 15,000ms
- Shows progress spinner after 2,000ms

---

## 5. Command System (60+ slash commands)

### Registry (commands.ts)

All commands are registered in a flat import list with feature-flag conditional loading:

```typescript
// Ant-only command (runtime check)
const agentsPlatform = process.env.USER_TYPE === 'ant'
  ? require('./commands/agents-platform/index.js').default
  : null

// Build-time DCE via feature()
const proactive = feature('PROACTIVE') || feature('KAIROS')
  ? require('./commands/proactive.js').default : null
const assistantCommand = feature('KAIROS')
  ? require('./commands/assistant/index.js').default : null
const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default : null
```

### Command Categories

| Category | Commands |
|----------|----------|
| **Git** | commit, diff, review, pr_comments, branch, autofix-pr, commit-push-pr |
| **Context management** | compact, context, memory, session, clear |
| **MCP** | mcp, skills, hooks, plugins |
| **Model/config** | model, fast, effort, theme, config, vim, voice |
| **Task/workflow** | tasks, worktree, teleport, remote-env |
| **Agent system** | agents, agents-platform, coordinator, employee |
| **Plan mode** | plan, ultraplan |
| **Debugging** | bughunter, perf-issue, ant-trace, ctx_viz, doctor |
| **Misc** | clear, copy, cost, help, init, login, logout, onboarding, rename, resume, share, status |

### Skills System (distinct from commands)

Skills are **Markdown files** with YAML frontmatter, loaded from `~/.claude/skills/`:

```typescript
// loadSkillsDir.ts — parses frontmatter for:
// - argument names (for substitution)
// - effort level
// - model override
// - shell commands to execute in the prompt
// - tools to enable/disable
```

Skills support argument substitution, gitignore filtering, and can be auto-generated from MCP server prompts (`mcpSkillBuilders.ts`).

---

## 6. React/Ink UI Components

### Component Count: ~120 components in `components/` (390 TS/TSX files)

### Root Component (App.tsx)

The `App.tsx` is compiled by the **React Compiler** (observable from the `_c()` memoization cache pattern):

```typescript
export function App(t0) {
  const $ = _c(9);  // React compiler cache with 9 slots
  // Manual memoization: checks if props changed before re-rendering children
  if ($[0] !== children || $[1] !== initialState) {
    t1 = <AppStateProvider ...>{children}</AppStateProvider>
    $[0] = children; $[1] = initialState; $[2] = t1;
  } else {
    t1 = $[2];  // cache hit
  }
  ...
}
```

Provider hierarchy (outermost first):
1. `FpsMetricsProvider` — FPS measurement context
2. `StatsProvider` — session stats
3. `AppStateProvider` — global app state + `onChangeAppState` side-effect bus

### Notable UI Components

| Component | Purpose |
|-----------|---------|
| `App.tsx` | Root provider wrapper |
| `Messages.tsx` / `Message.tsx` / `MessageRow.tsx` | Conversation rendering |
| `PromptInput/` | Text input with full vim mode integration |
| `agents/` | Agent progress UI (per-agent color-coded indicators) |
| `tasks/` | Background task list UI |
| `mcp/` | MCP server connection UI |
| `memory/` | Memory display overlay |
| `permissions/` | Permission grant/deny dialogs |
| `Settings/` | Settings configuration UI |
| `design-system/` | Shared design tokens |
| `Spinner.tsx` | Spinner component with configurable mode |

### FPS Tracking

The renderer tracks FPS metrics and exposes them via `FpsMetricsProvider` context. This feeds into the startup profiler and analytics logging.

---

## 7. Multi-Agent Coordinator

### Location: `src 2/coordinator/coordinatorMode.ts` (feature-flagged)

```typescript
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false  // DCE: false at build time if flag not set
}
```

The coordinator mode is controlled by `COORDINATOR_MODE` build-time feature flag + `CLAUDE_CODE_COORDINATOR_MODE` runtime env var. The dual check means the entire coordinator branch is dead-code-eliminated in non-coordinator builds.

### Session Mode Reconciliation

```typescript
export function matchSessionMode(sessionMode: 'coordinator' | 'normal' | undefined): string | undefined {
  // When resuming a session, flip the env var to match stored mode
  // No caching — isCoordinatorMode() reads env live
}
```

### Internal Worker Tools (coordinator-only)

```typescript
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
```

### Agent Swarm Architecture

Parallel to coordinator mode is the **agent swarms** system (enabled via `isAgentSwarmsEnabled()`):
- `TeamCreateTool` / `TeamDeleteTool`: create/destroy named agent swarms
- `SendMessageTool`: inject messages into running teammate agents
- `in_process_teammate` task type: swarm members run as in-process threads

### AgentTool (most complex tool)

File: `src 2/tools/AgentTool/`

Contains:
- `runAgent.ts` — full sub-agent lifecycle (fork, run, resume)
- `resumeAgent.ts` — resume a paused/interrupted agent
- `forkSubagent.ts` — fork current context for parallel work
- `agentColorManager.ts` — assigns unique colors to agent types (red, blue, green, yellow, purple, orange, pink, cyan)
- `agentMemory.ts` / `agentMemorySnapshot.ts` — per-agent memory
- `agentDisplay.ts` — UI rendering for agent progress
- Built-in agents: `generalPurposeAgent`, `exploreAgent`, `planAgent`, `verificationAgent`, `engineeringLeadAgent`, `claudeCodeGuideAgent`

---

## 8. State Management

### Architecture: Custom Zustand-style store

**Core store (store.ts) — 34 lines:**

```typescript
export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return  // reference equality check
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)  // cleanup function
    },
  }
}
```

**Key design decisions:**
- `Object.is()` equality check prevents unnecessary re-renders
- `onChange` callback enables the `onChangeAppState` side-effect bus
- Returns cleanup function from `subscribe()` (React-hook compatible)

### AppState Shape (AppStateStore.ts)

The `AppState` type uses `DeepImmutable<{...}>` for most fields:

```typescript
export type AppState = DeepImmutable<{
  settings: SettingsJson
  mainLoopModel: ModelSetting
  toolPermissionContext: ToolPermissionContext
  kairosEnabled: boolean
  remoteSessionUrl: string | undefined
  remoteConnectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  remoteBackgroundTaskCount: number
  replBridgeEnabled: boolean
  replBridgeConnected: boolean
  // ... 40+ more fields
}> & {
  // Tasks excluded from DeepImmutable (contain function types)
  tasks: TaskState
}
```

Notable state fields: speculation state (`SpeculationState`), completion boundaries, footerSelection, coordinatorTaskIndex, viewSelectionMode, expandedView.

### Side-Effect Bus (onChangeAppState.ts)

Single choke-point for state-change side effects:
- Permission mode changes → notify CCR/SDK
- Model overrides → update bootstrap state
- Settings changes → apply env variables, clear credential caches

This fixed a bug where 8+ permission mutation paths each independently (sometimes incorrectly) notified external systems.

### Speculation State

```typescript
export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] }      // mutable ref — avoids array spreading
      writtenPathsRef: { current: Set<string> } // mutable ref — relative paths written to overlay
      boundary: CompletionBoundary | null
      isPipelined: boolean
      pipelinedSuggestion?: { text: string; promptId: 'user_intent' | 'stated_intent'; ... }
    }
```

The speculation system pre-runs AI responses before the user submits, using mutable refs inside otherwise-immutable AppState to avoid O(n) array spreading per streamed token.

---

## 9. Vim Mode Engine

### Location: `src 2/vim/` (5 files)

### Motions (motions.ts)

Pure functional design — all motions return new `Cursor` positions:

```typescript
export function resolveMotion(key: string, cursor: Cursor, count: number): Cursor {
  let result = cursor
  for (let i = 0; i < count; i++) {
    const next = applySingleMotion(key, result)
    if (next.equals(result)) break  // idempotent — stop early
    result = next
  }
  return result
}
```

**Supported motions:** h, l, j, k, gj, gk, w, b, e, W, B, E, 0, ^, $, G

**Motion classification:**
- `isInclusiveMotion()`: e, E, $ (includes char at destination)
- `isLinewiseMotion()`: G (operates on full lines with operators)

### Operators (operators.ts)

```typescript
// Context injection pattern — no global state
export type OperatorContext = {
  cursor: Cursor
  text: string
  setText: (text: string) => void
  setOffset: (offset: number) => void
  enterInsert: (offset: number) => void
  getRegister: () => string
  setRegister: (content: string, linewise: boolean) => void
  getLastFind: () => { type: FindType; char: string } | null
  recordChange: (change: RecordedChange) => void
}
```

Implemented operators: d (delete), c (change), y (yank), p (paste), > (indent), < (dedent), x, ~ (toggle case), J (join), o/O (open line).

### State Machine (transitions.ts)

```typescript
export function transition(state: CommandState, input: string, ctx: TransitionContext): TransitionResult {
  switch (state.type) {
    case 'idle':      return fromIdle(input, ctx)
    case 'count':     return fromCount(state, input, ctx)
    case 'operator':  return fromOperator(state, input, ctx)
    case 'operatorCount': return fromOperatorCount(state, input, ctx)
    case 'operatorFind':  return fromOperatorFind(state, input, ctx)
    case 'operatorTextObj': return fromOperatorTextObj(state, input, ctx)
    case 'find':      return fromFind(state, input, ctx)
    case 'g':         return fromG(state, input, ctx)
    // ...
  }
}
```

States: idle, count, operator, operatorCount, operatorFind, operatorTextObj, find, g (gg/gj/gk dispatch).

### Text Objects (textObjects.ts)

Implements: w (word), b (WORD), s (sentence), p (paragraph), plus bracket/quote pairs (`()`, `[]`, `{}`, `<>`, `""`, `''`, `` ` ``).

Supports `a` (around, includes delimiter) and `i` (inner) scopes.

---

## 10. Services Layer

### MCP Service (services/mcp/client.ts)

Full Model Context Protocol client with three transport modes:
- `StdioClientTransport` — subprocess stdio
- `SSEClientTransport` — Server-Sent Events
- `StreamableHTTPClientTransport` — streaming HTTP

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
// Supports: CallTool, ListTools, ListPrompts, ListResources, Elicitation protocol
```

Features: per-server connection caching, MCP elicitation (prompting user for input), official MCP registry prefetch, resource listing tools auto-added when server supports resources.

### OAuth Service (services/oauth/index.ts)

Full OAuth 2.0 PKCE flow:

```typescript
export class OAuthService {
  async startOAuthFlow(authURLHandler, options?: {
    loginWithClaudeAi?: boolean
    inferenceOnly?: boolean
    skipBrowserOpen?: boolean  // SDK control protocol mode
    orgUUID?: string
    loginHint?: string
  }): Promise<OAuthTokens>
}
```

Two authorization modes:
1. **Automatic**: opens browser, local HTTP server captures redirect
2. **Manual**: user pastes authorization code (for headless environments)

### Compact Service (services/compact/)

LLM-based context summarization with 13 files:

| File | Role |
|------|------|
| `compact.ts` | Full conversation compaction (calls forked agent) |
| `autoCompact.ts` | Token threshold monitoring + auto-trigger |
| `microCompact.ts` | Micro-compaction (compress individual tool results) |
| `apiMicrocompact.ts` | API-based micro-compaction |
| `cachedMicrocompact.ts` | Cached micro-compaction |
| `snipCompact.ts` | Snip-mode compaction |
| `sessionMemoryCompact.ts` | Per-session memory compaction |
| `grouping.ts` | Message grouping for compaction |
| `prompt.ts` | System prompts for the compaction agent |

Compaction runs as a **forked agent** (`runForkedAgent`) with its own tool context, file state cache, and session transcript.

### Memory Extraction (services/extractMemories/)

Automatically extracts reusable memories from conversation history. Writes to `~/.claude/memory/` (the `memdir` system). Memory types defined in `utils/memory/types.ts`.

### Voice Service (services/voice.ts + voiceStreamSTT.ts + voiceKeyterms.ts)

Streaming speech-to-text for voice input mode. `voiceKeyterms.ts` handles keyword-triggered activation.

### Analytics / GrowthBook (services/analytics/)

- **GrowthBook** (`@growthbook/growthbook`) for feature flag A/B gating
- Full **OpenTelemetry** stack (14 OTel packages: traces, metrics, logs via OTLP/gRPC/HTTP/Prometheus)
- `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` type — enforced via TypeScript naming convention to prevent accidentally logging PII/code in analytics events

---

## 11. Build System

### package.json Key Facts

```json
{
  "name": "claude-code-rebuilt",
  "version": "0.0.0-rebuilt",
  "type": "module",
  "packageManager": "bun@1.2.23",
  "bin": { "claude": "./entrypoints/cli.tsx" }
}
```

### Build Command

```bash
bun build ./entrypoints/cli.tsx \
  --outfile ./dist/cli.js \
  --target bun \
  --format esm \
  --define MACRO='{"VERSION":"0.0.0-rebuilt","BUILD_TIME":"...","FEEDBACK_CHANNEL":"#claude-code",...}' \
  --external @ant/computer-use-mcp \
  --external @ant/claude-for-chrome-mcp \
  --external @anthropic-ai/mcpb \
  --external @anthropic-ai/sandbox-runtime \
  --external audio-capture-napi \
  --external color-diff-napi \
  --external image-processor-napi \
  --external url-handler-napi
```

**Key build features:**
- Single ESM bundle output (`dist/cli.js`)
- Native bindings (`*-napi` packages) are externalized — loaded at runtime
- `MACRO` object inlined at build time (version, build timestamp, feedback channel, package URL)
- `feature('FLAG_NAME')` calls resolved at build time → unused branches stripped (Dead Code Elimination)
- `bun:bundle` module used for `feature()` — Bun-specific build-time API

### Pipeline (pipeline script)
```
typecheck → lint → build → build:employee-smoke → smoke:cli → smoke:bundle → smoke:employee
```

### Dev Mode
```bash
bun ./entrypoints/cli.tsx  # runs TypeScript directly, no build needed
```

---

## 12. Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/sdk` | ^0.63.0 | Primary Claude API (streaming) |
| `@anthropic-ai/bedrock-sdk` | ^0.26.4 | AWS Bedrock backend |
| `@anthropic-ai/vertex-sdk` | ^0.14.4 | Google Vertex AI backend |
| `@anthropic-ai/foundry-sdk` | ^0.2.3 | Internal Foundry backend |
| `@anthropic-ai/claude-agent-sdk` | ^0.1.15 | Sub-agent embedding SDK |
| `@modelcontextprotocol/sdk` | ^1.20.0 | MCP client + server |
| `@growthbook/growthbook` | ^1.4.1 | Feature flags / A/B gating |
| `@opentelemetry/*` | 14 packages | Full OTel observability |
| `@commander-js/extra-typings` | ^14.0.0 | CLI argument parsing (typed) |
| `react` | ^19.2.0 | UI rendering |
| `react-reconciler` | ^0.33.0 | Custom renderer host |
| `zod` | ^4.1.12 | Schema validation for tool inputs |
| `@aws-sdk/*` | ^3.x | AWS auth + Bedrock |
| `@azure/identity` | ^4.13.0 | Azure auth |
| `bidi-js` | ^1.0.3 | Unicode BiDi algorithm |
| `chalk` | ^5.6.2 | Terminal color |
| `chokidar` | ^5.0.0 | File system watcher |
| `execa` | ^9.6.0 | Shell command execution |
| `fuse.js` | ^7.1.0 | Fuzzy search |
| `marked` | ^16.4.1 | Markdown parsing |
| `sharp` | ^0.34.4 | Image processing (for vision features) |
| `highlight.js` | ^11.11.1 | Code syntax highlighting |
| `vscode-languageserver-protocol` | ^3.17.5 | LSP client |
| `ws` | ^8.18.3 | WebSocket (remote sessions) |
| `yaml` | ^2.8.1 | YAML parsing (frontmatter) |
| `proper-lockfile` | ^4.1.2 | File locking |
| `qrcode` | ^1.5.4 | QR code generation (mobile pairing) |
| `fflate` | ^0.8.2 | Compression |
| `undici` | ^7.16.0 | HTTP client |
| `lru-cache` | ^11.2.2 | LRU caching |

---

## 13. Novel & Interesting Engineering Decisions

### 1. Build-time Dead Code Elimination via `bun:bundle`

```typescript
import { feature } from 'bun:bundle'

// This entire branch is stripped from external builds
const coord = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js')
  : null
```

`feature()` is resolved at build time by Bun's bundler. This means internal (ant-only) features — coordinator mode, KAIROS assistant, DAEMON, BRIDGE_MODE, AGENT_TRIGGERS — have **zero runtime overhead** in external builds. The pattern is used throughout all 778 source files.

### 2. Startup Parallelism via "Fire and Await Later"

```typescript
// These fire DURING import statement evaluation, before any code runs
startMdmRawRead()      // MDM config subprocess — saves ~65ms
startKeychainPrefetch() // macOS keychain read — saves ~65ms

// Later, when actually needed:
const token = await ensureKeychainPrefetchCompleted()
```

By firing I/O at the very first executable statement, the project achieves near-zero idle time waiting for auth/config during the startup sequence.

### 3. React Compiler Integration

`App.tsx` shows evidence of React Compiler (`_c()` caching pattern from `react/compiler-runtime`):
```typescript
import { c as _c } from "react/compiler-runtime";
const $ = _c(9); // 9-slot memoization cache, auto-generated
```

This is a pre-release React 19 feature — the compiler auto-generates memoization that would otherwise require manual `useMemo`/`useCallback`.

### 4. Task ID Design for Security

```typescript
// 36-character alphabet (digits + lowercase), 8 characters
// 36^8 ≈ 2.8 trillion combinations
// Prefix by type: b=bash, a=agent, r=remote, t=teammate, w=workflow, m=monitor, d=dream
export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)  // cryptographically random
  // ...
}
```

Uses `crypto.randomBytes()` specifically to **resist brute-force symlink attacks** on task output files.

### 5. Circular Dependency Breaking Strategy

Three separate strategies used:
- **Type-level**: shared types moved to `types/permissions.ts`, `types/tools.ts`
- **Lazy require inside functions**: `const getTeammateUtils = () => require('./utils/teammate.js')`
- **Module-level conditional**: `feature('FLAG') ? require(...) : null`

All three patterns are documented with explicit comments: "// Lazy require to break circular dependency: X -> Y -> ... -> Z"

### 6. AnalyticsMetadata Type Safety Convention

```typescript
type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = { ... }
```

A type whose **name itself is a verification comment**. Engineers must explicitly acknowledge that analytics payloads don't contain code or file paths (PII-adjacent data) by using this type.

### 7. AppState Speculation with Mutable Refs

```typescript
// Inside otherwise-immutable AppState:
messagesRef: { current: Message[] }      // mutable ref inside immutable state
writtenPathsRef: { current: Set<string> } // mutable ref inside immutable state
```

Speculation (pre-running AI responses) needs to accumulate streamed tokens without triggering O(n) array spreading on every token. The solution: a mutable ref object lives inside the immutable state — the ref's identity is stable, its `.current` mutates.

### 8. Frame Contamination Tracking

The renderer tracks whether the previous frame's screen buffer was "contaminated" (selection overlay, alt-screen reset, SIGCONT, forceRedraw) to decide whether blitting from it would copy stale inverted cells:

```typescript
prevFrameContaminated: boolean  // in RenderOptions
// When true: skip blit optimization, do full redraw
// When false: blit unchanged cells, only paint diffs
```

### 9. LegacyRoot vs ConcurrentRoot for Search Rendering

The secondary search-rendering path explicitly uses `LegacyRoot`:
```typescript
// LegacyRoot: all work sync, no scheduling
// ConcurrentRoot's scheduler backlog leaks across roots via flushSyncWork
// Measured: ~0.0003ms/call growth in concurrent mode — pathological for 8k-message thread
```

### 10. Remote Session Viewer Mode

The `claude assistant` command creates a **viewer-only WebSocket connection** to a remote daemon:
```typescript
// When isViewer=true:
// - Ctrl+C/Escape do NOT send interrupt to remote agent
// - 60s reconnect timeout disabled
// - Session title never updated
// - AppState.tasks is always empty (tasks live in remote process)
// - Remote task count tracked via event-sourced system/task_started events
```

### 11. Yoga WASM Layout with Explicit Memory Management

```typescript
const cleanupYogaNode = (node: DOMElement | TextNode): void => {
  const yogaNode = node.yogaNode
  if (yogaNode) {
    yogaNode.unsetMeasureFunc()
    // Clear ALL references BEFORE freeing — prevents other code from
    // accessing freed WASM memory during concurrent operations
    clearYogaNodeReferences(node)
    yogaNode.freeRecursive()
  }
}
```

The renderer uses Facebook's Yoga layout engine compiled to WASM, requiring explicit memory management to prevent use-after-free bugs in concurrent scenarios.

### 12. Four AI Backend Support

The project supports four AI backends with unified interface:
1. **Anthropic API** (default) — OAuth2 PKCE / API key via macOS Keychain
2. **AWS Bedrock** — STS credential chain, auto-prefetched on startup
3. **Google Vertex AI** — GCP credentials, auto-prefetched on startup
4. **Internal Foundry** — Anthropic-internal backend

Backend selection is transparent to the query layer — `query.ts` abstracts over all four.

### 13. Multi-Modal Message Types

The message system supports a rich taxonomy beyond simple user/assistant:
- `AttachmentMessage` — file/image attachments
- `ProgressMessage` — streaming tool progress
- `RequestStartEvent` / `StreamEvent` — API streaming events
- `SystemCompactBoundaryMessage` — marks compaction points
- `TombstoneMessage` — marks deleted/replaced messages
- `ToolUseSummaryMessage` — summarized tool call (post-compaction)
- `SystemLocalCommandMessage` — local slash command output

---

## Summary: Architectural Uniqueness

This is not a typical CLI tool. It is a **production-grade distributed AI system** implemented as a terminal application:

1. **Custom terminal renderer** (not using upstream Ink) with Yoga WASM layout, frame diffing, BiDi support, and search indexing
2. **React Compiler** integration for automated memoization in a terminal UI context
3. **Speculation engine** that pre-runs AI responses before user submits
4. **Multi-process agent orchestration** with 7 task types, swarm support, and coordinator mode
5. **Four AI backends** (Anthropic, Bedrock, Vertex, Foundry) unified behind one query interface
6. **Build-time feature flag DCE** eliminating internal-only code paths from external builds
7. **Full vim mode** in the terminal prompt input (motions, operators, text objects, registers, dot-repeat)
8. **LLM-based context management** (compaction, micro-compaction, memory extraction, speculation)
9. **Full OTel observability** stack (14 packages) for traces, metrics, and logs
10. **Remote session multiplexing** via WebSocket with viewer mode separation
