# Architecture

> Pre-read this file instead of running `find` — it has everything you need for orientation.

## First 5 Minutes
- Treat the repo root as the analysis root. There is no nested code root anymore.
- Read this file before broad discovery, hotspot analysis, or deck/report work.
- Run `bun run repo:facts` for file counts, dominant directories, largest source files, and LOC.
- For HTML reports or decks, write the file as a direct child of the repo root, include `id="overview"`, then run:
  - `bun run report:check ./your-report.html`
  - `bun run report:open ./your-report.html`
- Prefer the direct `file:///...#overview` preview URL over screenshot tooling for the first verification pass.
- **Telemetry / observability issues:** read `.claude/settings.local.json` first — all OTLP endpoint, dataset, and API key config is there. Check `x-honeycomb-dataset` in `OTEL_EXPORTER_OTLP_HEADERS` matches the dataset name you observe in Honeycomb before diving into telemetry source code.

## Identity
- **Project:** `claude-code-rebuilt` (v0.0.0-rebuilt)
- **What it is:** Full source rebuild of the Anthropic Claude Code CLI
- **Runtime:** Bun 1.3.11 · **Language:** TypeScript strict · **UI:** React 18 + custom Ink terminal renderer
- **Build:** `bun run build` → `dist/cli.js` (single ESM bundle, native bindings external)

## Key Dependencies (no need to read package.json)
| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` ^0.63.0 | Claude API (primary) |
| `@anthropic-ai/bedrock-sdk` | AWS Bedrock |
| `@anthropic-ai/vertex-sdk` | Google Vertex AI |
| `@anthropic-ai/foundry-sdk` | Internal Foundry |
| `@anthropic-ai/claude-agent-sdk` | Sub-agent SDK |
| `@modelcontextprotocol/sdk` ^1.20.0 | MCP client + server |
| `@opentelemetry/*` (14 packages) | Full OTel observability stack |
| `@growthbook/growthbook` | Feature flags (A/B gating) |
| `commander` ^14.0.0 | CLI argument parsing |
| `@aws-sdk/*`, `@azure/identity` | Cloud provider auth |

## Directory Map

```
./
├── main.tsx                  # 4696 lines — CLI entry, startup profiling, parallel prefetches
├── QueryEngine.ts            # AI conversation loop, retry, cost tracking, tool dispatch
├── query.ts                  # Raw Anthropic API call (streaming)
├── Tool.ts                   # Tool base type + contracts (792 lines)
├── Task.ts                   # Task state machine — 7 types, ID generation
├── tools.ts                  # Tool registry + loader (389 lines)
├── commands.ts               # Slash-command registry
│
├── tools/                    # 40 tool implementations
│   ├── AgentTool/            # MOST COMPLEX — fork/resume/memory/color/display
│   ├── BashTool/
│   ├── FileEditTool/
│   ├── FileReadTool/
│   ├── FileWriteTool/
│   ├── GlobTool/
│   ├── GrepTool/
│   ├── MCPTool/
│   ├── WebFetchTool/
│   ├── WebSearchTool/
│   ├── TaskCreateTool/ TaskGetTool/ TaskListTool/ TaskUpdateTool/ TaskStopTool/ TaskOutputTool/
│   ├── ScheduleCronTool/
│   ├── RemoteTriggerTool/
│   ├── SendMessageTool/
│   ├── TeamCreateTool/ TeamDeleteTool/
│   ├── SkillTool/
│   ├── EnterPlanModeTool/ ExitPlanModeTool/
│   ├── EnterWorktreeTool/ ExitWorktreeTool/
│   ├── NotebookEditTool/
│   ├── REPLTool/
│   ├── LSPTool/
│   ├── TodoWriteTool/
│   ├── ToolSearchTool/
│   ├── WorkflowTool/
│   ├── AskUserQuestionTool/
│   └── SyntheticOutputTool/ BriefTool/ TungstenTool/ PowerShellTool/
│
├── commands/                 # 60+ slash commands
│   ├── agents/ agents-platform/ coordinator/
│   ├── branch/ commit/ diff/ pr_comments/ review/
│   ├── compact/ memory/ context/ session/
│   ├── mcp/ skills/ hooks/ plugins/
│   ├── model/ fast/ effort/ theme/ vim/ voice/
│   ├── tasks/ worktree/ teleport/ remote-env/
│   ├── employee/             # Employee/Engineering Lead agent system
│   ├── plan/ ultraplan.tsx   # Plan mode commands
│   ├── bughunter/ perf-issue/ sandbox-toggle/
│   └── ... (60+ total)
│
├── components/               # ~120 React/Ink UI components
│   ├── App.tsx               # Root component
│   ├── Messages.tsx / Message.tsx / MessageRow.tsx
│   ├── PromptInput/          # Text input with vim mode
│   ├── agents/               # Agent progress UI
│   ├── tasks/                # Task list UI
│   ├── mcp/                  # MCP server UI
│   ├── memory/               # Memory display
│   ├── permissions/          # Permission dialogs
│   ├── Settings/             # Settings UI
│   └── design-system/        # Shared design tokens
│
├── services/                 # Background services
│   ├── analytics/            # GrowthBook flags + OTel event logging
│   ├── api/                  # Claude API, bootstrap, files, referral
│   ├── mcp/                  # MCP client, official registry, types
│   ├── oauth/                # OAuth2 PKCE flow
│   ├── lsp/                  # Language Server Protocol client
│   ├── compact/              # LLM-based context summarisation
│   ├── contextCollapse/      # Old message collapsing
│   ├── extractMemories/      # Auto-extract memories from conversation
│   ├── SessionMemory/        # Per-session context
│   ├── teamMemorySync/       # Shared team memory
│   ├── MagicDocs/            # Auto doc generation
│   ├── AgentSummary/         # Per-agent summaries
│   ├── plugins/              # Plugin install/update/scope commands
│   ├── policyLimits/         # Remote-managed usage caps
│   ├── remoteManagedSettings/ # Policy pushed from backend
│   ├── settingsSync/         # Settings sync
│   ├── autoresearch/         # Self-improvement controller (see section below)
│   └── voice.ts voiceStreamSTT.ts voiceKeyterms.ts
│
├── state/                    # Global state
│   ├── AppState.ts           # Shape of immutable global state
│   ├── AppStateStore.ts      # Zustand-style store
│   ├── store.ts              # Subscriber registry
│   ├── selectors.ts          # Memoized derived state
│   └── onChangeAppState.ts   # Side-effect bus
│
├── ink/                      # Custom React → terminal renderer (not upstream Ink)
│   ├── reconciler.ts         # React Fiber → virtual DOM
│   ├── renderer.ts           # Layout (Yoga-like box model)
│   ├── render-node-to-output.ts
│   ├── render-to-screen.ts   # Frame diff → minimal ANSI writes
│   ├── optimizer.ts          # Node cache + line-width cache
│   ├── bidi.ts               # Unicode BiDi (RTL support)
│   ├── parse-keypress.ts     # Full keypress parsing
│   ├── wrapAnsi.ts           # ANSI-aware word wrap
│   └── supports-hyperlinks.ts / terminal-querier.ts / selection.ts / searchHighlight.ts
│
├── vim/                      # Full vim mode engine
│   ├── motions.ts            # word, paragraph, line, column
│   ├── operators.ts          # d, c, y, p, >, <
│   ├── textObjects.ts        # w, b, s, p, brackets, quotes
│   └── transitions.ts        # N/I/V/C mode state machine
│
├── coordinator/              # Multi-agent coordination (COORDINATOR_MODE feature flag)
│   ├── coordinatorMode.ts
│   └── remotePermissionBridge.ts
│
├── remote/                   # Remote session management
│   ├── RemoteSessionManager.ts
│   ├── SessionsWebSocket.ts  # WebSocket multiplexing
│   ├── sdkMessageAdapter.ts  # SDK ↔ WebSocket protocol bridge
│   ├── remotePermissionBridge.ts
│   ├── createDirectConnectSession.ts
│   └── directConnectManager.ts
│
├── plugins/                  # Plugin system
│   ├── bundled/              # Built-in plugins (init'd at startup)
│   └── builtinPlugins.ts
│
├── skills/                   # Skill runner
│   ├── loadSkillsDir.ts      # Scans ~/.claude/skills/
│   ├── bundledSkills.ts      # Ships built-in skills
│   ├── bundled/              # Built-in skill implementations
│   └── mcpSkillBuilders.ts   # Auto-generate skills from MCP
│
├── bootstrap/                # Global state initialization
│   └── state.ts              # sessionId, cwd, remote mode flags
│
├── entrypoints/              # Binary entry points
│   ├── cli.tsx               # Primary CLI binary
│   ├── agentSdk.ts           # Embedded SDK mode
│   ├── mcp.ts                # MCP server mode
│   └── workerAgent.ts        # Worker thread agent
│
├── migrations/               # Settings schema migrations
├── memdir/                   # Memory directory reader (~/.claude/memory/)
├── upstreamproxy/            # IDE proxy relay
├── bridge/                   # IDE bridge protocol
├── utils/                    # ~80 utility modules
└── types/                    # Centralized shared types (permissions, tools, ids)
```

## Startup Sequence
```
profileCheckpoint('main_tsx_entry')   ← wall-clock marker
startMdmRawRead()                     ← MDM config (parallel with imports, saves ~65ms)
startKeychainPrefetch()               ← OAuth + API key (parallel, saves ~65ms)
↓
GrowthBook init + OTel init + MCP official registry prefetch
↓
checkHasTrustDialogAccepted()
↓
initBuiltinPlugins() + initBundledSkills()
↓
getMcpToolsCommandsAndResources()
↓
renderAndRun() → App.tsx
```

## Key Architectural Patterns

### 1. Build-time Dead Code Elimination
```typescript
// bun:bundle feature() resolved at build time — unused branches stripped
const coord = feature('COORDINATOR_MODE') ? require('./coordinator/coordinatorMode.js') : null;
const kairos = feature('KAIROS')          ? require('./assistant/index.js')            : null;
```

### 2. Immutable State (reducer pattern)
```typescript
type SetAppState = (f: (prev: AppState) => AppState) => void
// Never mutate directly — always spread
setAppState(prev => ({ ...prev, tasks: { ...prev.tasks, [id]: newTask } }))
```

### 3. Circular Dependency Breaking
- Permission types → `types/permissions.ts`
- Tool progress types → `types/tools.ts`
- Teammate utils → lazy `require()` inside functions

### 4. Startup Parallelism
- Pattern: fire prefetch → do other work → `await ensureXCompleted()` when needed
- Profiler checkpoints bracket every major startup phase

## Task Types (Task.ts)
| Type | Prefix | Description |
|------|--------|-------------|
| `local_bash` | `b` | Shell command subprocess |
| `local_agent` | `a` | In-process sub-agent |
| `remote_agent` | `r` | Remote agent via WebSocket |
| `in_process_teammate` | `t` | Swarm teammate thread |
| `local_workflow` | `w` | Workflow execution |
| `monitor_mcp` | `m` | MCP server watcher |
| `dream` | `d` | AutoDream background agent |

Task IDs: 8-char base-36 random string prefixed by type. 36⁸ ≈ 2.8T combinations.

## AI Backends
| Backend | SDK | Auth |
|---------|-----|------|
| Anthropic API (default) | `@anthropic-ai/sdk` | OAuth2 / API key (keychain) |
| AWS Bedrock | `@anthropic-ai/bedrock-sdk` | STS credential chain |
| Google Vertex AI | `@anthropic-ai/vertex-sdk` | GCP credentials |
| Internal Foundry | `@anthropic-ai/foundry-sdk` | Internal auth |

## Files Already in This Directory
- `analysis-deck.html` — 20-slide architecture slide deck (may exist from prior session — **Read before Write**)
- `session-transcript.html` — prior session transcript
- `session-retrospective.html` — wrong-turns analysis
- `session-review.html` — prior agent efficiency review

## Autoresearch Subsystem (`services/autoresearch/`)

Self-improvement controller: scores candidate prompt/policy changes against a benchmark corpus and manages a shadow → dogfood → canary → mainline rollout ladder.

### Key files
| File | Role |
|------|------|
| `runtime.ts` (~78KB) | Controller, scorer, cycle runner — the core |
| `types.ts` | All Zod schemas: CandidateManifest, CandidateEvaluation, Scorecard, RolloutState, etc. |
| `splitter.ts` | Splitter topology metadata (topology_only mode — no live coordinator yet) |
| `claudeCodeSessions.ts` | Processes recorded Claude Code sessions into DogfoodObservations |
| `scripts/autoresearchStatus.ts` | CLI: `bun run autoresearch:status` — local trend summary without Honeycomb |

### Key function entry points in runtime.ts
| Function | Line | Purpose |
|----------|------|---------|
| `scoreCandidateExperiment()` | 1261 | Build scorecard + make promotion decision from a CandidateEvaluation |
| `runEvaluationCommand()` | 1848 | Shell out to `evaluationCommand`, collect CandidateEvaluation JSON |
| `runCycle()` | 1975 | Main scheduler tick: scan mutationSources → evaluate → score → persist |

### Current config gaps (as of 2026-04-15)
- `evaluationCommand` is **unset** — controller scores evaluations but nothing produces them
- `mutationSources` is **`[]`** — no candidates flow in automatically

### Candidate flow
```
autoresearch.config.json mutationSources
  → runCycle() scans for new CandidateManifest JSON
  → runEvaluationCommand() runs evaluationCommand subprocess
      (env: AUTORESEARCH_CANDIDATE_MANIFEST, AUTORESEARCH_OUTPUT_PATH,
             AUTORESEARCH_CORPUS_PATH, AUTORESEARCH_CHALLENGE_SET_PATH)
  → scoreCandidateExperiment() builds Scorecard, checks reliability floors
  → RolloutState updated: shadow → dogfood → canary → mainline
```

### Reliability floors (zero-tolerance)
`unsupportedClaimRate=0`, `verifierBypassRate=0`, `phaseViolationRate=0`, `challengeSetCatchRate=1`

### Reference docs
- Full observability field reference: `docs/autoresearch-observability.md`
- Config: `autoresearch.config.json`
- Corpus: `autoresearch.seed-corpus.json` (3 cases)
- Challenge set: `autoresearch.seed-challenge-set.json` (4 candidates)

---

## HTML Artifact Conventions
- Reference artifacts: `session-transcript.html`, `session-review.html`, `session-retrospective.html`
- New generated outputs: unique direct-child files like `topic-deck.html` or `topic-report.html`
- Canonical landing anchor: `id="overview"`
- Canonical validation and preview flow:
  - `bun run report:check ./topic-report.html`
  - `bun run report:open ./topic-report.html`
