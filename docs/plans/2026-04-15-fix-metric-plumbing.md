# Fix Autoresearch Metric Plumbing — Zero Medians

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the eval script produce real `tokenCost`, `runtimeMs`, and `toolCallCount` values per corpus case so the scorer can differentiate candidates.

**Architecture:** The SessionEnd hook already fires after every Claude Code session but passes no cost data. We add a **Stop hook** (fires before SessionEnd, when cost state is still live) that reads cost data from the project config file written by `saveCurrentSessionCosts()` and writes it into the observation file. The eval script then reads observation files from `AUTORESEARCH_STATE_DIR/incoming/claude-code-sessions/` and joins them to case results by session ID.

**Tech Stack:** Bun, TypeScript, Zod schemas in `services/autoresearch/types.ts`

---

## Problem Trace

```
cc-harness (Honeycomb)  ← has real cost events (624 events)
       ↓ (no connection)
autoresearchEval.ts     ← hardcodes tokenCost: 0, runtimeMs: 0, toolCallCount: 0
       ↓
scoreCandidateExperiment() in runtime.ts  ← computes medianTokenCost: 0, medianRuntimeMs: 0
       ↓
costCeilings (maxTokenCostDeltaPct: 5, maxRuntimeDeltaPct: 10) ← can't differentiate, always 0 delta
```

The cleanest fix avoids querying Honeycomb from the eval script (adds API key dependency, latency). Instead we read **local** cost data that `saveCurrentSessionCosts()` already writes to `~/.claude/projects/<hash>/.claude-project`.

But there's a better approach: the observation files in `AUTORESEARCH_STATE_DIR/incoming/claude-code-sessions/` are the designed integration point. We enrich them with cost fields.

## Fix Overview

1. **Extend the observation schema** to include optional cost fields (`tokenCost`, `runtimeMs`, `toolCallCount`)
2. **Add a Stop hook** that reads cost state and writes a cost-enriched observation file
3. **Update the eval script** to read observation files and populate real metrics per case
4. **Add tests** for each step

---

### Task 1: Extend ClaudeCodeSessionObservation Schema with Cost Fields

**Files:**
- Modify: `services/autoresearch/types.ts` (around line 131, ClaudeCodeSessionObservationSchema — find it)
- Test: `services/autoresearch/__tests__/types.test.ts` (create)

**Step 1: Find the ClaudeCodeSessionObservationSchema**

Search for `ClaudeCodeSessionObservationSchema` in `services/autoresearch/types.ts`.

**Step 2: Write the failing test**

```typescript
// services/autoresearch/__tests__/types.test.ts
import { describe, it, expect } from 'bun:test'
import { ClaudeCodeSessionObservationSchema } from '../types.js'

describe('ClaudeCodeSessionObservationSchema', () => {
  it('accepts cost fields when present', () => {
    const input = {
      id: 'abc123',
      sessionId: 'sess-1',
      eventType: 'session_end',
      transcriptPath: '/tmp/transcript.json',
      cwd: '/tmp',
      success: true,
      actualRegression: false,
      heuristicConfidence: 0.55,
      failureTags: [],
      source: 'claude_code_session_end_hook',
      recordedAt: '2026-04-15T00:00:00Z',
      // New cost fields
      tokenCost: 0.042,
      runtimeMs: 12345,
      toolCallCount: 37,
    }
    const result = ClaudeCodeSessionObservationSchema().parse(input)
    expect(result.tokenCost).toBe(0.042)
    expect(result.runtimeMs).toBe(12345)
    expect(result.toolCallCount).toBe(37)
  })

  it('defaults cost fields to undefined when absent', () => {
    const input = {
      id: 'abc456',
      sessionId: 'sess-2',
      eventType: 'session_end',
      transcriptPath: '/tmp/transcript.json',
      cwd: '/tmp',
      success: true,
      actualRegression: false,
      heuristicConfidence: 0.55,
      failureTags: [],
      source: 'claude_code_session_end_hook',
      recordedAt: '2026-04-15T00:00:00Z',
    }
    const result = ClaudeCodeSessionObservationSchema().parse(input)
    expect(result.tokenCost).toBeUndefined()
    expect(result.runtimeMs).toBeUndefined()
    expect(result.toolCallCount).toBeUndefined()
  })
})
```

**Step 3: Run test to verify it fails**

Run: `bun test services/autoresearch/__tests__/types.test.ts`
Expected: FAIL — schema rejects unknown keys (`.strict()`) or `tokenCost` field doesn't exist

**Step 4: Add cost fields to the schema**

In `services/autoresearch/types.ts`, find `ClaudeCodeSessionObservationSchema` and add three optional fields:

```typescript
tokenCost: z.number().nonnegative().optional(),
runtimeMs: z.number().nonnegative().optional(),
toolCallCount: z.number().nonnegative().optional(),
```

Add these **before** the `.strict()` call.

**Step 5: Run test to verify it passes**

Run: `bun test services/autoresearch/__tests__/types.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add services/autoresearch/types.ts services/autoresearch/__tests__/types.test.ts
git commit -m "feat(autoresearch): add cost fields to session observation schema"
```

---

### Task 2: Enrich the Session Observation Hook to Capture Cost Data

**Files:**
- Modify: `.claude/hooks/autoresearchSessionObservation.ts`
- Modify: `services/autoresearch/claudeCodeSessions.ts`
- Test: `services/autoresearch/__tests__/claudeCodeSessions.test.ts` (create)

**Context:** The `SessionEnd` hook input doesn't include cost data. But `saveCurrentSessionCosts()` writes cost data to the project config file at `~/.claude/projects/<key>/config.json` keyed by `lastSessionId`. The hook can read this file using the session ID to extract cost data.

However, there's a simpler approach: the hook fires during shutdown. At that point, the project config has **already** been written by `costHook.ts` (which calls `saveCurrentSessionCosts` on `process.exit`). We read it from there.

**Step 1: Write the failing test for classifyClaudeCodeSessionObservation with cost data**

```typescript
// services/autoresearch/__tests__/claudeCodeSessions.test.ts
import { describe, it, expect } from 'bun:test'
import { classifyClaudeCodeSessionObservation } from '../claudeCodeSessions.js'

describe('classifyClaudeCodeSessionObservation', () => {
  it('includes cost fields when provided', () => {
    const result = classifyClaudeCodeSessionObservation({
      sessionId: 'sess-cost-1',
      eventType: 'session_end',
      transcriptPath: '/tmp/t.json',
      cwd: '/tmp',
      summary: 'Session completed successfully',
      recordedAt: '2026-04-15T12:00:00Z',
      tokenCost: 0.15,
      runtimeMs: 30000,
      toolCallCount: 42,
    })
    expect(result.tokenCost).toBe(0.15)
    expect(result.runtimeMs).toBe(30000)
    expect(result.toolCallCount).toBe(42)
  })

  it('omits cost fields when not provided', () => {
    const result = classifyClaudeCodeSessionObservation({
      sessionId: 'sess-cost-2',
      eventType: 'session_end',
      transcriptPath: '/tmp/t.json',
      cwd: '/tmp',
      summary: 'Session completed',
      recordedAt: '2026-04-15T12:00:00Z',
    })
    expect(result.tokenCost).toBeUndefined()
    expect(result.runtimeMs).toBeUndefined()
    expect(result.toolCallCount).toBeUndefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test services/autoresearch/__tests__/claudeCodeSessions.test.ts`
Expected: FAIL — `tokenCost` not in input type or not passed through

**Step 3: Update `ClaudeCodeSessionObservationInput` type and `classifyClaudeCodeSessionObservation`**

In `services/autoresearch/claudeCodeSessions.ts`:

1. Add to `ClaudeCodeSessionObservationInput`:
```typescript
tokenCost?: number
runtimeMs?: number
toolCallCount?: number
```

2. In `classifyClaudeCodeSessionObservation`, pass them through to the schema parse:
```typescript
// Add to the object passed to ClaudeCodeSessionObservationSchema().parse():
...(input.tokenCost !== undefined && { tokenCost: input.tokenCost }),
...(input.runtimeMs !== undefined && { runtimeMs: input.runtimeMs }),
...(input.toolCallCount !== undefined && { toolCallCount: input.toolCallCount }),
```

**Step 4: Run test to verify it passes**

Run: `bun test services/autoresearch/__tests__/claudeCodeSessions.test.ts`
Expected: PASS

**Step 5: Update the hook to read cost data from project config**

In `.claude/hooks/autoresearchSessionObservation.ts`:

1. Add a `readProjectConfigCosts` function:
```typescript
async function readProjectConfigCosts(
  sessionId: string,
  projectDir: string,
): Promise<{ tokenCost?: number; runtimeMs?: number; toolCallCount?: number }> {
  // Claude Code writes cost data to ~/.claude/projects/<normalized-path-hash>/config.json
  // via saveCurrentSessionCosts(). The key is the absolute project path, normalized.
  // The simplest approach: scan the global config for a project entry matching this session.
  const claudeConfigDir = getClaudeConfigHomeDir()
  const globalConfigPath = path.join(claudeConfigDir, 'config.json')
  
  try {
    const raw = await readFile(globalConfigPath, 'utf8')
    const config = JSON.parse(raw)
    if (!config.projects) return {}
    
    // Find the project entry whose lastSessionId matches
    for (const projectConfig of Object.values(config.projects) as any[]) {
      if (projectConfig?.lastSessionId === sessionId) {
        const totalCost = projectConfig.lastCost ?? 0
        const totalDuration = projectConfig.lastDuration ?? 0
        // Approximate tool call count from input+output tokens / avg tokens per call
        // Better: read from transcript. For now, use total tokens as proxy.
        const inputTokens = projectConfig.lastTotalInputTokens ?? 0
        const outputTokens = projectConfig.lastTotalOutputTokens ?? 0
        return {
          tokenCost: totalCost,
          runtimeMs: totalDuration,
          toolCallCount: undefined, // Will be set from transcript in Task 3
        }
      }
    }
  } catch {
    // Config not readable — cost data unavailable
  }
  return {}
}
```

2. In `handleSessionEnd`, call it and pass to the classifier:
```typescript
const costs = await readProjectConfigCosts(input.session_id, projectDir)
const observation = classifyClaudeCodeSessionObservation({
  // ... existing fields ...
  tokenCost: costs.tokenCost,
  runtimeMs: costs.runtimeMs,
  toolCallCount: costs.toolCallCount,
})
```

**Step 6: Commit**

```bash
git add services/autoresearch/claudeCodeSessions.ts \
       services/autoresearch/__tests__/claudeCodeSessions.test.ts \
       .claude/hooks/autoresearchSessionObservation.ts
git commit -m "feat(autoresearch): enrich session observations with cost data from project config"
```

---

### Task 3: Extract Tool Call Count from Transcript

**Files:**
- Modify: `.claude/hooks/autoresearchSessionObservation.ts`
- Test: `services/autoresearch/__tests__/claudeCodeSessions.test.ts` (extend)

**Step 1: Add transcript tool call counter to the hook**

```typescript
async function countToolCallsFromTranscript(
  transcriptPath: string,
): Promise<number> {
  try {
    const raw = await readFile(transcriptPath, 'utf8')
    const transcript = JSON.parse(raw)
    let count = 0
    for (const msg of transcript) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') count++
        }
      }
    }
    return count
  } catch {
    return 0
  }
}
```

**Step 2: Wire it into handleSessionEnd**

```typescript
const toolCallCount = await countToolCallsFromTranscript(input.transcript_path)
const costs = await readProjectConfigCosts(input.session_id, projectDir)
const observation = classifyClaudeCodeSessionObservation({
  // ... existing fields ...
  tokenCost: costs.tokenCost,
  runtimeMs: costs.runtimeMs,
  toolCallCount,
})
```

**Step 3: Run tests**

Run: `bun test services/autoresearch/__tests__/claudeCodeSessions.test.ts`
Expected: PASS (existing tests still pass, tool call count flows through)

**Step 4: Commit**

```bash
git add .claude/hooks/autoresearchSessionObservation.ts
git commit -m "feat(autoresearch): extract tool call count from transcript in session hook"
```

---

### Task 4: Update Eval Script to Read Observation Files and Populate Real Metrics

**Files:**
- Modify: `scripts/autoresearchEval.ts`
- Test: `scripts/__tests__/autoresearchEval.test.ts` (create)

This is the main fix. The eval script currently hardcodes zeros. We make it read observation files.

**Step 1: Write the failing test**

```typescript
// scripts/__tests__/autoresearchEval.test.ts
import { describe, it, expect } from 'bun:test'
import { aggregateObservationMetrics } from '../autoresearchEval.js'

describe('aggregateObservationMetrics', () => {
  it('returns median values from observations', () => {
    const observations = [
      { tokenCost: 0.10, runtimeMs: 10000, toolCallCount: 20 },
      { tokenCost: 0.20, runtimeMs: 30000, toolCallCount: 40 },
      { tokenCost: 0.15, runtimeMs: 20000, toolCallCount: 30 },
    ]
    const result = aggregateObservationMetrics(observations)
    expect(result.tokenCost).toBe(0.15)
    expect(result.runtimeMs).toBe(20000)
    expect(result.toolCallCount).toBe(30)
  })

  it('returns zeros when no observations have cost data', () => {
    const observations = [
      { tokenCost: undefined, runtimeMs: undefined, toolCallCount: undefined },
    ]
    const result = aggregateObservationMetrics(observations)
    expect(result.tokenCost).toBe(0)
    expect(result.runtimeMs).toBe(0)
    expect(result.toolCallCount).toBe(0)
  })

  it('returns zeros for empty array', () => {
    const result = aggregateObservationMetrics([])
    expect(result.tokenCost).toBe(0)
    expect(result.runtimeMs).toBe(0)
    expect(result.toolCallCount).toBe(0)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test scripts/__tests__/autoresearchEval.test.ts`
Expected: FAIL — `aggregateObservationMetrics` not exported

**Step 3: Add observation reading and aggregation to the eval script**

In `scripts/autoresearchEval.ts`:

1. Add imports:
```typescript
import { readdir } from 'node:fs/promises'
```

2. Add the aggregation function (export it for testing):
```typescript
type ObservationMetrics = {
  tokenCost?: number
  runtimeMs?: number
  toolCallCount?: number
}

export function aggregateObservationMetrics(
  observations: ObservationMetrics[],
): { tokenCost: number; runtimeMs: number; toolCallCount: number } {
  const costs = observations.map(o => o.tokenCost).filter((v): v is number => v != null && v > 0)
  const runtimes = observations.map(o => o.runtimeMs).filter((v): v is number => v != null && v > 0)
  const toolCalls = observations.map(o => o.toolCallCount).filter((v): v is number => v != null && v > 0)

  return {
    tokenCost: median(costs),
    runtimeMs: median(runtimes),
    toolCallCount: median(toolCalls),
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}
```

3. Add a function to load observation files:
```typescript
async function loadObservationMetrics(): Promise<ObservationMetrics> {
  const stateDir = process.env.AUTORESEARCH_STATE_DIR
  if (!stateDir) return { tokenCost: 0, runtimeMs: 0, toolCallCount: 0 }

  const obsDir = path.join(stateDir, 'incoming', 'claude-code-sessions')
  let files: string[]
  try {
    files = await readdir(obsDir)
  } catch {
    return { tokenCost: 0, runtimeMs: 0, toolCallCount: 0 }
  }

  const observations: ObservationMetrics[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const obs = JSON.parse(await readFile(path.join(obsDir, file), 'utf8'))
      observations.push({
        tokenCost: obs.tokenCost,
        runtimeMs: obs.runtimeMs,
        toolCallCount: obs.toolCallCount,
      })
    } catch {
      // skip malformed files
    }
  }

  return aggregateObservationMetrics(observations)
}
```

4. Replace the hardcoded zeros in the case results loop:
```typescript
// Before the caseResults loop:
const observedMetrics = await loadObservationMetrics()

// In the case result object, replace:
//   tokenCost: 0,
//   runtimeMs: 0,
//   toolCallCount: 0,
// With:
      tokenCost: observedMetrics.tokenCost,
      runtimeMs: observedMetrics.runtimeMs,
      toolCallCount: observedMetrics.toolCallCount,
```

**Step 4: Run test to verify it passes**

Run: `bun test scripts/__tests__/autoresearchEval.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/autoresearchEval.ts scripts/__tests__/autoresearchEval.test.ts
git commit -m "feat(autoresearch): read real cost metrics from observation files instead of hardcoded zeros"
```

---

### Task 5: Integration Smoke Test

**Files:** None new — validation only

**Step 1: Run the full test suite**

Run: `bun run test:repo`
Expected: All tests pass

**Step 2: Verify the eval script still produces valid output**

Run a dry-run of the eval script with the baseline manifest:
```bash
AUTORESEARCH_CANDIDATE_MANIFEST=/dev/stdin \
AUTORESEARCH_OUTPUT_PATH=/tmp/eval-test-output.json \
AUTORESEARCH_CORPUS_PATH=./autoresearch.seed-corpus.json \
AUTORESEARCH_CHALLENGE_SET_PATH=./autoresearch.seed-challenge-set.json \
AUTORESEARCH_REPO_ROOT=. \
AUTORESEARCH_STATE_DIR=/tmp/fake-state \
echo '{"id":"baseline","revision":"test","mutationClass":"prompt","changedFiles":[]}' | \
bun run scripts/autoresearchEval.ts
```

Then inspect the output:
```bash
cat /tmp/eval-test-output.json | bun -e "const j=JSON.parse(await Bun.stdin.text()); console.log('tokenCost:', j.caseResults[0]?.tokenCost, 'runtimeMs:', j.caseResults[0]?.runtimeMs)"
```

Expected: Values will be 0 (no observation files in /tmp/fake-state), but the plumbing is wired. When real sessions write observations, the values will be non-zero.

**Step 3: Commit (if any fixes needed)**

---

## What This Fixes

After these changes:
- Every Claude Code session writes cost-enriched observation files via the Stop hook
- The eval script reads those observation files and populates real `tokenCost`, `runtimeMs`, `toolCallCount`
- The scorer in `runtime.ts` (`scoreCandidateExperiment`) will compute non-zero `medianTokenCost`, `medianRuntimeMs`, `medianToolCallCount`
- The `costCeilings.maxTokenCostDeltaPct: 5` and `maxRuntimeDeltaPct: 10` thresholds can now actually differentiate candidates

## What This Does NOT Fix (separate tasks)

- Corpus expansion (3 cases too few) — separate task
- Session count increase (2 per candidate too few) — config change
- Continuous scoring dimensions — separate task
