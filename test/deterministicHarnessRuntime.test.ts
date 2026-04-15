import { describe, expect, test } from 'bun:test'
import { RepoAdapterSchema } from 'src/services/deterministicHarness/types.js'
import {
  createTestHarnessState,
  deriveTaskSpec,
  evaluateToolPolicy,
  type HarnessState,
  validatePhaseResult,
} from 'src/services/deterministicHarness/runtime.js'

const adapter = RepoAdapterSchema().parse({
  version: '1',
  canonicalRoots: ['.'],
  requiredDocs: ['ARCHITECTURE.md'],
  searchExcludes: ['node_modules/'],
  bootstrapCommands: ['bun run repo:bootstrap'],
  analysisCommands: ['bun run repo:facts'],
  implementationVerificationCommands: ['bun test'],
  releaseVerificationCommands: ['bun run pipeline'],
  artifactRules: [
    {
      pattern: '*.html',
      validationCommand: 'bun run report:check',
      requiredAnchor: 'overview',
    },
  ],
  riskyCommandAllowlist: ['git status --short'],
  approvedCommandPrefixes: {
    discover: ['bun run repo:bootstrap', 'bun run repo:facts', 'rg -n '],
    plan: ['bun run repo:facts'],
    implement: ['bun test', 'rg -n '],
    verify: ['bun test', 'bun run pipeline', 'bun run report:check'],
    release: ['bun run pipeline', 'bun run report:check'],
  },
})

function withEvidence(
  state: HarnessState,
  id: string = 'ev-1',
): HarnessState {
  state.evidence.push({
    id,
    phase: state.currentPhase,
    event: 'tool_succeeded',
    toolName: 'Read',
    summary: 'Read deterministic harness runtime.',
    contentHash: 'abc123',
    timestamp: new Date().toISOString(),
  })
  return state
}

describe('deterministic harness runtime', () => {
  test('derives a high-risk task spec for release-style work', () => {
    const spec = deriveTaskSpec(
      'Deploy the release and validate the production migration plan',
      '/repo',
    )

    expect(spec.taskIntent).toBe('release')
    expect(spec.riskLevel).toBe('high')
    expect(spec.repoTarget).toBe('/repo')
  })

  test('blocks broad shell discovery before bootstrap completes', () => {
    const state = createTestHarnessState('/repo')
    state.currentPhase = 'discover'

    const decision = evaluateToolPolicy(state, adapter, 'Bash', {
      command: 'rg -n deterministicHarness .',
    })

    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('bootstrap')
  })

  test('requires explicit excludes for shell ripgrep after bootstrap', () => {
    const state = createTestHarnessState('/repo')
    state.currentPhase = 'discover'
    state.bootstrapCompleted = true

    const decision = evaluateToolPolicy(state, adapter, 'Bash', {
      command: 'rg -n deterministicHarness .',
    })

    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('explicit excludes')
  })

  test('allows approved bootstrap commands in discover phase', () => {
    const state = createTestHarnessState('/repo')
    state.currentPhase = 'discover'

    const decision = evaluateToolPolicy(state, adapter, 'Bash', {
      command: 'bun run repo:bootstrap',
    })

    expect(decision.decision).toBe('allow')
  })

  test('blocks verified claims that are missing evidence references', () => {
    const state = withEvidence(createTestHarnessState('/repo'))
    state.currentPhase = 'discover'

    const result = validatePhaseResult(
      state,
      adapter,
      JSON.stringify({
        phase: 'discover',
        summary: 'Collected repo facts.',
        proposedActions: ['Draft the implementation plan'],
        assumptions: [],
        expectedEvidence: ['repo facts'],
        claims: [
          {
            text: 'The repo facts are complete.',
            status: 'verified',
          },
        ],
        nextPhase: 'plan',
      }),
    )

    expect(result.kind).toBe('block')
    expect(result.reason).toContain('missing evidenceIds')
  })

  test('requires a human gate between plan and implement', () => {
    const state = withEvidence(createTestHarnessState('/repo'))
    state.currentPhase = 'plan'

    const result = validatePhaseResult(
      state,
      adapter,
      JSON.stringify({
        phase: 'plan',
        summary: 'Implementation plan is ready.',
        proposedActions: ['Approve implementation'],
        assumptions: [],
        expectedEvidence: ['implementation diff', 'test output'],
        claims: [
          {
            text: 'The plan is grounded in repo evidence.',
            status: 'verified',
            evidenceIds: ['ev-1'],
          },
        ],
        nextPhase: 'implement',
      }),
    )

    expect(result.kind).toBe('require_human_gate')
    expect(result.state.pendingHumanGate?.approvalToken).toBe(
      'approve implement',
    )
  })

  test('blocks completion without a passing release verifier', () => {
    const state = withEvidence(createTestHarnessState('/repo'))
    state.currentPhase = 'release'

    const result = validatePhaseResult(
      state,
      adapter,
      JSON.stringify({
        phase: 'release',
        summary: 'Everything is done.',
        proposedActions: [],
        assumptions: [],
        expectedEvidence: [],
        claims: [
          {
            text: 'Release checks passed.',
            status: 'verified',
            evidenceIds: ['ev-1'],
          },
        ],
        nextPhase: 'done',
      }),
    )

    expect(result.kind).toBe('block')
    expect(result.reason).toContain('passing release verifier')
  })
})
