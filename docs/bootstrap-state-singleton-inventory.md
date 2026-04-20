# `bootstrap/state.ts` singleton inventory

Phase 2 item 1 of `production-gap-analysis.html` calls for eliminating the
module-scope singletons in `bootstrap/state.ts` so tenant context isn't
global. The file is 1,758 lines and imported by 273 call sites — a
big-bang refactor is neither reviewable nor safe. This document is the
ledger the follow-up slices hang off of.

**Status:** telemetry counter tagging (item 1b) is complete across
every emission site, the in-memory error log partitioning landed in the
prior slice, and the OTel providers now live in
`services/observability/providers.ts` instead of `bootstrap/state.ts`.
The remaining work is planned below in order of value.

## Field inventory (by category)

State type at `bootstrap/state.ts:45–257`. Every field below is a
property of the single `STATE: State` at line 429.

### Category A — Truly process-global (keep in bootstrap, leave alone)

These fields are identical for every tenant/session inside one process
and have no meaningful "per-tenant" variant. Reading them from any
scope returns the same value; writing them once at startup is correct.

| Field | Rationale |
|---|---|
| `originalCwd`, `projectRoot`, `cwd` | One process = one working dir |
| `startTime` | Process start timestamp, used for uptime only |
| `meter` | Process-wide OTel meter handle |
| `sessionCounter`, `locCounter`, `prCounter`, `commitCounter`, `costCounter`, `tokenCounter`, `codeEditToolDecisionCounter`, `activeTimeCounter` | OTel counters — tenant is carried on `.add()` attrs (item 1b ✅) |
| `clientType`, `sessionSource`, `sessionProjectDir` | Startup-time immutable after boot |
| `flagSettingsPath`, `flagSettingsInline`, `allowedSettingSources` | Flag surface, one per process |
| `chromeFlagOverride`, `useCoworkPlugins` | CLI-flag surface |
| `sdkBetas`, `mainThreadAgentType`, `isRemoteMode`, `directConnectServerUrl` | Entrypoint configuration |
| `promptCache1hAllowlist`, `promptCache1hEligible` | GrowthBook cache, tenant-agnostic |
| `afkModeHeaderLatched`, `fastModeHeaderLatched`, `cacheEditingHeaderLatched`, `thinkingClearLatched` | Beta-header latches on the outbound API connection |
| `scrollDraining`, `scrollDrainTimer` | Ink render-loop hot path |

### Category B — Session-scoped (migrate to session-scoped storage when daemon HTTP path grows)

Today these live in `STATE` because the single-subprocess-per-session
model makes "process state = session state." When the daemon starts
serving concurrent requests that share one subprocess, these will need
AsyncLocalStorage wrappers. Not urgent — no current path multiplexes
them.

| Field | Migration shape |
|---|---|
| `sessionId`, `parentSessionId` | `AsyncLocalStorage<SessionContext>` (already see `onSessionSwitch`) |
| `totalCostUSD`, `totalAPIDuration*`, `totalToolDuration`, `totalLinesAdded`, `totalLinesRemoved`, `modelUsage` | Cost accumulators — fed by counter emissions anyway, per-session aggregate can move to the session scope |
| `turn*` duration/count fields | Per-conversation-turn — natural scope carrier |
| `lastInteractionTime`, `lastApiCompletionTimestamp`, `lastMainRequestId` | Per-session latency telemetry |
| `lastAPIRequest`, `lastAPIRequestMessages`, `lastClassifierRequests` | `/share` debug capture |
| `cachedClaudeMdContent`, `systemPromptSectionCache`, `planSlugCache` | Per-session caches |
| `modelStrings`, `mainLoopModelOverride`, `initialMainLoopModel` | Per-session model resolution |
| `isInteractive`, `kairosActive`, `strictToolResultPairing`, `sdkAgentProgressSummariesEnabled`, `userMsgOptIn` | Per-session mode flags |
| `hasExitedPlanMode`, `needsPlanModeExitAttachment`, `needsAutoModeExitAttachment`, `lspRecommendationShownThisSession` | Per-session UX one-shots |
| `initJsonSchema`, `registeredHooks`, `inlinePlugins`, `additionalDirectoriesForClaudeMd`, `allowedChannels`, `hasDevChannels` | Per-session SDK/plugin wiring |
| `teleportedSessionInfo`, `invokedSkills`, `slowOperations` | Per-session telemetry |
| `agentColorMap`, `agentColorIndex` | Per-session presentation |
| `sessionBypassPermissionsMode`, `sessionTrustAccepted`, `sessionPersistenceDisabled`, `sessionIngressToken`, `oauthTokenFromFd`, `apiKeyFromFd`, `questionPreviewFormat`, `hasUnknownModelCost`, `lastEmittedDate`, `promptId`, `pendingPostCompaction` | Per-session state scalars |

### Category C — Tenant-sensitive (actively migrated this quarter)

These are read/written by code paths the daemon HTTP surface exposes
concurrently to multiple tenants. If left process-global, tenant A's
state will leak into tenant B's view.

| Field | Status | Notes |
|---|---|---|
| `inMemoryErrorLog` | ✅ migrated | `utils/log.ts` partitions by tenant — see `test/scopeSingletons1b.test.ts` |
| OTel counter attributes | ✅ 1b done | All 8 counters now stamp `tenant.id` on `.add()` — this PR |
| `scheduledTasksEnabled` | ✅ keep global | Bootstrap latch, identical for every tenant on the process |
| `sessionCronTasks` | ✅ migrated | `Map<tenantId, SessionCronTask[]>`; scheduler reads via `getAllSessionCronTasks()` — see `test/sessionCronTasksTenantScope.test.ts` |
| `sessionCreatedTeams` | ✅ migrated | `Map<tenantId, Set<string>>`; `cleanupSessionTeams()` walks every bucket — see `test/sessionTeamsTenantScope.test.ts` |

### Category D — Test-only seams (leave alone)

| Field / helper | Purpose |
|---|---|
| `resetStateForTests()` | Re-initializes STATE for test isolation |
| `resetTotalDurationStateAndCost_FOR_TESTS_ONLY()`, `resetModelStringsForTestingOnly()` | Targeted resets for specific test suites |
| `statsStore` | Test observability seam, mocked in tests |

## Follow-up slices (ordered)

Each slice below is independently reviewable. The sequence is chosen so
later slices don't require rewriting earlier ones.

1. ~~**Session cron tasks → tenant-keyed lookup.**~~ ✅ shipped — see
   `test/sessionCronTasksTenantScope.test.ts`. `SessionCronTask` now
   carries `tenantId`; `addSessionCronTask` stamps from the active
   scope; `removeSessionCronTasks` sweeps every bucket; scheduler
   reads all tasks via `getAllSessionCronTasks()`.

2. ~~**`sessionCreatedTeams` → tenant-keyed set.**~~ ✅ shipped — see
   `test/sessionTeamsTenantScope.test.ts`. `cleanupSessionTeams()`
   walks every tenant bucket because shutdown runs outside any
   AsyncLocalStorage scope.

3. **Extract session-scoped state (Category B) behind an
   `AsyncLocalStorage<SessionContext>` wrapper.** Replace every
   `STATE.<sessionField>` access with `currentSession().<field>`. Big
   PR — ~1 week, best done slice-by-slice by Category-B subgroup
   (cost accumulators first, then turn counters, then caches, etc.).

4. **Delete `totalCostUSD` / `modelUsage` fields from `STATE` and let
   OTel counters be the source of truth for cost.** Depends on slice 3
   landing so per-session aggregation moves to the scope carrier.

5. ~~**Extract Category A OTel providers into
   `services/observability/providers.ts` — leaf module, no more
   `bootstrap/state.ts` exports for them.**~~ ✅ shipped — provider
   storage now resets through `resetStateForTests()` without living in
   the singleton `STATE`.

## What this PR ships

- **This inventory.** Running ledger of every field with a category
  tag, so every follow-up slice references it instead of re-deriving.
- **Finishes Phase 2 item 1b.** The six counter emission sites that
  weren't yet stamping `tenant.id` now do so through
  `tenantAttributesForTelemetry()`:
  - `utils/diff.ts` — `locCounter`
  - `tools/shared/gitOperationTracking.ts` — `commitCounter`, `prCounter`
  - `utils/activityManager.ts` — `activeTimeCounter`
  - `hooks/toolPermission/permissionLogging.ts` — `codeEditToolDecisionCounter`
  - `services/tools/toolExecution.ts` — `codeEditToolDecisionCounter`
  - `entrypoints/init.ts` — `sessionCounter`
- **Coverage tests** at `test/telemetryTenantTaggingCoverage.test.ts`
  install a spy meter via `setMeter()`, invoke each testable emission
  path inside a `runWithTenantScope`, and assert `tenant.id` on every
  `.add()` call. A static import-edge test guards the remaining sites
  against regression.
