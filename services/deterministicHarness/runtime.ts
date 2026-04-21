import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
// @ts-expect-error -- picomatch ships no types in this build
import picomatch from 'picomatch'
import type {
  HookInput,
  HookJSONOutput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionStartHookInput,
  StopHookInput,
  UserPromptSubmitHookInput,
} from 'src/entrypoints/agentSdkTypes.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import { safeParseJSON } from 'src/utils/json.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { logOTelEvent } from 'src/utils/telemetry/events.js'
import {
  type DeterministicHarnessSettings,
  DeterministicPhaseSchema,
  type DeterministicPhase,
  type EvidenceRecord,
  EvidenceRecordSchema,
  type PhaseResult,
  PhaseResultSchema,
  type PolicyDecision,
  PolicyDecisionSchema,
  type RepoAdapter,
  RepoAdapterSchema,
  type TaskSpec,
  TaskSpecSchema,
  type VerifierResult,
  VerifierResultSchema,
} from './types.js'

const PHASE_ORDER: DeterministicPhase[] = [
  'intake',
  'discover',
  'plan',
  'implement',
  'verify',
  'release',
  'done',
]

const PHASE_TOOL_ALLOWLIST: Record<DeterministicPhase, ReadonlySet<string>> = {
  intake: new Set(),
  discover: new Set(['Read', 'Grep', 'Glob', 'Bash']),
  plan: new Set(['Read', 'Grep', 'Glob', 'Bash']),
  implement: new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']),
  verify: new Set(['Read', 'Grep', 'Glob', 'Bash']),
  release: new Set(['Read', 'Bash']),
  done: new Set(),
}

const HIGH_RISK_TERMS = [
  'release',
  'deploy',
  'production',
  'schema',
  'database',
  'migration',
  'security',
  'payment',
  'billing',
  'delete',
  'remove',
]

const MEDIUM_RISK_TERMS = [
  'implement',
  'change',
  'refactor',
  'fix',
  'edit',
  'build',
  'test',
  'verify',
]

const TASK_INTENT_RULES: Array<{ intent: string; terms: string[] }> = [
  { intent: 'release', terms: ['release', 'ship', 'deploy'] },
  { intent: 'verification', terms: ['verify', 'test', 'validate'] },
  { intent: 'implementation', terms: ['implement', 'build', 'change', 'fix'] },
  { intent: 'analysis', terms: ['analyze', 'review', 'deep dive', 'inspect'] },
]

const CLAIMY_LANGUAGE =
  /\b(done|passed|fixed|verified|completed|ready for release)\b/i

const JSON_FENCE_PREFIX = /^```(?:json)?\s*/i
const JSON_FENCE_SUFFIX = /\s*```$/i

export type HarnessState = {
  sessionId: string
  taskId: string
  runId: string
  repoRoot: string
  adapterVersion: string
  currentPhase: DeterministicPhase
  bootstrapCompleted: boolean
  taskSpec: TaskSpec | null
  evidence: EvidenceRecord[]
  verifiers: VerifierResult[]
  policyLog: PolicyDecision[]
  writtenArtifacts: Record<string, { validated: boolean }>
  phaseHistory: PhaseResult[]
  pendingHumanGate:
    | {
        fromPhase: DeterministicPhase
        targetPhase: DeterministicPhase
        approvalToken: string
        summary: string
      }
    | null
  lastValidatedPhaseResult: PhaseResult | null
}

type ResolvedDeterministicHarnessConfig =
  | {
      enabled: false
    }
  | {
      enabled: true
      strictWorkflow: boolean
      requireHumanGate: boolean
      emitTelemetry: boolean
      strictJsonResponses: boolean
      invalidReason?: string
      repoRoot: string
      repoAdapter: RepoAdapter | null
    }

type StopDecision =
  | {
      kind: 'allow'
      state: HarnessState
    }
  | {
      kind: 'block'
      reason: string
      state: HarnessState
    }
  | {
      kind: 'require_human_gate'
      reason: string
      state: HarnessState
    }

type ToolPolicyDecision = {
  decision: PolicyDecision['decision']
  reason: string
}

type ParsedAssistantJson =
  | {
      ok: true
      value: unknown
    }
  | {
      ok: false
      reason: string
    }

type SerializableHarnessState = Omit<HarnessState, 'repoRoot'>

function createTaskId(prompt: string): string {
  return `task-${createHash('sha256').update(prompt).digest('hex').slice(0, 12)}`
}

function getStateDirectory(): string {
  return path.join(getClaudeConfigHomeDir(), 'deterministic-harness')
}

function getStatePath(sessionId: string): string {
  return path.join(getStateDirectory(), `${sessionId}.json`)
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, maxLength: number = 280): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 1)}…`
}

function createHashDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function getPhaseIndex(phase: DeterministicPhase): number {
  return PHASE_ORDER.indexOf(phase)
}

function isTransitionAllowed(
  currentPhase: DeterministicPhase,
  nextPhase: DeterministicPhase,
): boolean {
  const currentIndex = getPhaseIndex(currentPhase)
  const nextIndex = getPhaseIndex(nextPhase)
  return nextIndex === currentIndex || nextIndex === currentIndex + 1
}

function requiresHumanGate(
  currentPhase: DeterministicPhase,
  nextPhase: DeterministicPhase,
): boolean {
  return (
    (currentPhase === 'plan' && nextPhase === 'implement') ||
    (currentPhase === 'verify' && nextPhase === 'release')
  )
}

function getApprovalToken(targetPhase: DeterministicPhase): string {
  return `approve ${targetPhase}`
}

function classifyRisk(prompt: string): TaskSpec['riskLevel'] {
  const lowerPrompt = prompt.toLowerCase()
  if (HIGH_RISK_TERMS.some(term => lowerPrompt.includes(term))) {
    return 'high'
  }
  if (MEDIUM_RISK_TERMS.some(term => lowerPrompt.includes(term))) {
    return 'medium'
  }
  return 'low'
}

function classifyIntent(prompt: string): string {
  const lowerPrompt = prompt.toLowerCase()
  for (const rule of TASK_INTENT_RULES) {
    if (rule.terms.some(term => lowerPrompt.includes(term))) {
      return rule.intent
    }
  }
  return 'analysis'
}

export function deriveTaskSpec(prompt: string, repoRoot: string): TaskSpec {
  return TaskSpecSchema().parse({
    taskIntent: classifyIntent(prompt),
    repoTarget: repoRoot,
    requestedOutcome: truncate(normalizeWhitespace(prompt), 200),
    riskLevel: classifyRisk(prompt),
    userPrompt: prompt,
  })
}

function getPhaseResponseExample(phase: DeterministicPhase): string {
  return jsonStringify(
    {
      phase,
      summary: 'Short factual summary of the phase result.',
      proposedActions: ['Action one', 'Action two'],
      assumptions: ['Only include unresolved assumptions'],
      expectedEvidence: ['What evidence the next phase should gather'],
      claims: [
        {
          text: 'A grounded claim',
          status: 'verified',
          evidenceIds: ['ev-1'],
        },
      ],
      nextPhase:
        phase === 'done'
          ? 'done'
          : PHASE_ORDER[Math.min(getPhaseIndex(phase) + 1, PHASE_ORDER.length - 1)],
    },
    null,
    2,
  )
}

function getAllowedToolsText(phase: DeterministicPhase): string {
  const tools = [...PHASE_TOOL_ALLOWLIST[phase]]
  return tools.length > 0 ? tools.join(', ') : 'No tool use is allowed.'
}

function buildEvidenceSummary(state: HarnessState): string {
  if (state.evidence.length === 0) {
    return 'No evidence has been recorded yet.'
  }
  return state.evidence
    .slice(-5)
    .map(record => `${record.id}: ${record.summary}`)
    .join(' | ')
}

function buildPhaseContext(state: HarnessState, adapter: RepoAdapter): string {
  const requiredDocsText =
    adapter.requiredDocs.length > 0
      ? `Required docs before broad discovery: ${adapter.requiredDocs.join(', ')}.`
      : ''
  const gateText = state.pendingHumanGate
    ? `A human gate is pending. The user must type "${state.pendingHumanGate.approvalToken}" to continue into ${state.pendingHumanGate.targetPhase}.`
    : ''
  const taskText = state.taskSpec
    ? `TaskSpec: ${jsonStringify(state.taskSpec)}`
    : 'TaskSpec has not been initialized yet.'
  return [
    'Deterministic harness strict workflow is active.',
    `Current phase: ${state.currentPhase}.`,
    `Allowed tools for this phase: ${getAllowedToolsText(state.currentPhase)}`,
    requiredDocsText,
    taskText,
    `Evidence ledger: ${buildEvidenceSummary(state)}`,
    'Return ONLY JSON for your phase result.',
    `Use this exact shape: ${getPhaseResponseExample(state.currentPhase)}`,
    'Claims must use one of: verified, assumption, proposal.',
    'Verified claims must reference evidenceIds already present in the evidence ledger.',
    gateText,
  ]
    .filter(Boolean)
    .join(' ')
}

function buildBootstrapReminder(adapter: RepoAdapter): string {
  if (adapter.bootstrapCommands.length === 0) {
    return ''
  }
  return `Run the bootstrap commands before broad shell discovery: ${adapter.bootstrapCommands.join(', ')}.`
}

function buildToolFeedbackContext(
  state: HarnessState,
  record: EvidenceRecord,
  verifierResult?: VerifierResult,
): string {
  const parts = [
    `Evidence recorded as ${record.id}: ${record.summary}.`,
    `Current phase remains ${state.currentPhase}.`,
  ]
  if (verifierResult) {
    parts.push(
      `Verifier ${verifierResult.verifierName} ${verifierResult.status}.`,
    )
  }
  parts.push('Reference evidenceIds from the ledger in your next phase JSON.')
  return parts.join(' ')
}

function normalizeCommand(command: string): string {
  return normalizeWhitespace(command)
}

function commandStartsWithAny(command: string, prefixes: string[]): boolean {
  const normalizedCommand = normalizeCommand(command)
  return prefixes.some(prefix => normalizedCommand.startsWith(prefix))
}

function matchesArtifactPattern(filePath: string, pattern: string): boolean {
  return picomatch.isMatch(filePath, pattern)
}

function parseStrictJson(text: string): ParsedAssistantJson {
  const trimmed = text.trim()
  if (!trimmed) {
    return {
      ok: false,
      reason: 'The assistant response was empty. Return a JSON object for the current phase.',
    }
  }

  const candidate = trimmed.startsWith('```')
    ? trimmed.replace(JSON_FENCE_PREFIX, '').replace(JSON_FENCE_SUFFIX, '')
    : trimmed
  const parsed = safeParseJSON(candidate)
  if (parsed === null) {
    return {
      ok: false,
      reason:
        'Strict deterministic mode requires a raw JSON phase result with no surrounding prose.',
    }
  }

  return { ok: true, value: parsed }
}

function normalizeToolPayload(value: unknown): string {
  if (typeof value === 'string') {
    return truncate(normalizeWhitespace(value), 400)
  }
  try {
    return truncate(normalizeWhitespace(jsonStringify(value)), 400)
  } catch {
    return truncate(normalizeWhitespace(String(value)), 400)
  }
}

function createEvidenceSummary(
  toolName: string,
  toolInput: Record<string, unknown>,
  payload: unknown,
): string {
  if (toolName === 'Bash') {
    const command =
      typeof toolInput.command === 'string' ? normalizeCommand(toolInput.command) : ''
    return truncate(`Bash: ${command}`, 240)
  }

  if (toolName === 'Write' || toolName === 'Edit') {
    const filePath =
      typeof toolInput.file_path === 'string' ? toolInput.file_path : 'unknown'
    return truncate(`${toolName}: ${filePath}`, 240)
  }

  return truncate(`${toolName}: ${normalizeToolPayload(payload)}`, 240)
}

function createEvidenceRecord(
  state: HarnessState,
  toolName: string,
  event: EvidenceRecord['event'],
  toolInput: Record<string, unknown>,
  payload: unknown,
): EvidenceRecord {
  const summary = createEvidenceSummary(toolName, toolInput, payload)
  const contentHash = createHashDigest(
    jsonStringify({
      toolName,
      toolInput,
      payload: normalizeToolPayload(payload),
      phase: state.currentPhase,
      event,
    }),
  )
  return EvidenceRecordSchema().parse({
    id: `ev-${state.evidence.length + 1}`,
    phase: state.currentPhase,
    event,
    toolName,
    summary,
    contentHash,
    timestamp: new Date().toISOString(),
  })
}

function createPolicyRecord(
  state: HarnessState,
  decision: PolicyDecision['decision'],
  reason: string,
  toolName?: string,
  command?: string,
): PolicyDecision {
  return PolicyDecisionSchema().parse({
    decision,
    phase: state.currentPhase,
    reason,
    toolName,
    command,
    timestamp: new Date().toISOString(),
  })
}

function createVerifierResult(
  state: HarnessState,
  verifierName: string,
  status: VerifierResult['status'],
  failureReason?: string,
): VerifierResult {
  return VerifierResultSchema().parse({
    verifierName,
    status,
    phase: state.currentPhase,
    artifactsChecked: Object.keys(state.writtenArtifacts),
    failureReason,
    timestamp: new Date().toISOString(),
  })
}

function getVerifierName(
  adapter: RepoAdapter,
  command: string,
): { name: string; type: 'bootstrap' | 'implementation' | 'release' } | null {
  if (commandStartsWithAny(command, adapter.bootstrapCommands)) {
    return { name: 'bootstrap', type: 'bootstrap' }
  }
  if (commandStartsWithAny(command, adapter.implementationVerificationCommands)) {
    return { name: normalizeCommand(command), type: 'implementation' }
  }
  if (commandStartsWithAny(command, adapter.releaseVerificationCommands)) {
    return { name: normalizeCommand(command), type: 'release' }
  }
  return null
}

function recordArtifactWrite(state: HarnessState, adapter: RepoAdapter, filePath: string): void {
  const absoluteFilePath = path.resolve(state.repoRoot, filePath)
  const matchingRule = adapter.artifactRules.find(rule =>
    matchesArtifactPattern(absoluteFilePath, path.resolve(state.repoRoot, rule.pattern)),
  )
  if (!matchingRule) {
    return
  }

  state.writtenArtifacts[absoluteFilePath] = {
    validated: state.writtenArtifacts[absoluteFilePath]?.validated ?? false,
  }
}

function recordArtifactValidation(
  state: HarnessState,
  adapter: RepoAdapter,
  command: string,
): void {
  for (const rule of adapter.artifactRules) {
    if (!rule.validationCommand) {
      continue
    }
    if (!normalizeCommand(command).startsWith(rule.validationCommand)) {
      continue
    }
    for (const artifactPath of Object.keys(state.writtenArtifacts)) {
      if (matchesArtifactPattern(artifactPath, path.resolve(state.repoRoot, rule.pattern))) {
        state.writtenArtifacts[artifactPath] = { validated: true }
      }
    }
  }
}

function validatePhaseClaims(
  phaseResult: PhaseResult,
  state: HarnessState,
): string | null {
  const knownEvidenceIds = new Set(state.evidence.map(record => record.id))
  for (const claim of phaseResult.claims) {
    if (claim.status !== 'verified') {
      continue
    }
    if (!claim.evidenceIds || claim.evidenceIds.length === 0) {
      return `Verified claim "${claim.text}" is missing evidenceIds.`
    }
    for (const evidenceId of claim.evidenceIds) {
      if (!knownEvidenceIds.has(evidenceId)) {
        return `Verified claim "${claim.text}" references unknown evidenceId "${evidenceId}".`
      }
    }
  }
  return null
}

function validateClaimyLanguage(
  rawAssistantText: string,
  phaseResult: PhaseResult,
): string | null {
  if (!CLAIMY_LANGUAGE.test(rawAssistantText)) {
    return null
  }
  const groundedClaimCount = phaseResult.claims.filter(
    claim => claim.status === 'verified' && claim.evidenceIds && claim.evidenceIds.length > 0,
  ).length
  if (groundedClaimCount > 0) {
    return null
  }
  return 'The response contains completion-style claims but no grounded verified claims.'
}

function validateVerifiers(
  state: HarnessState,
  adapter: RepoAdapter,
  phaseResult: PhaseResult,
): string | null {
  const hasImplementationVerifier =
    adapter.implementationVerificationCommands.length === 0 ||
    state.verifiers.some(
      verifier =>
        verifier.status === 'passed' &&
        adapter.implementationVerificationCommands.some(command =>
          verifier.verifierName.startsWith(command),
        ),
    )

  const hasReleaseVerifier =
    adapter.releaseVerificationCommands.length === 0 ||
    state.verifiers.some(
      verifier =>
        verifier.status === 'passed' &&
        adapter.releaseVerificationCommands.some(command =>
          verifier.verifierName.startsWith(command),
        ),
    )

  if (
    phaseResult.nextPhase === 'release' &&
    !hasImplementationVerifier
  ) {
    return 'Cannot advance to release without a passing implementation verifier.'
  }

  if (phaseResult.nextPhase === 'done' && !hasReleaseVerifier) {
    return 'Cannot complete the task without a passing release verifier.'
  }

  if (phaseResult.nextPhase === 'done') {
    const unvalidatedArtifacts = Object.entries(state.writtenArtifacts)
      .filter(([, artifact]) => !artifact.validated)
      .map(([artifactPath]) => artifactPath)
    if (unvalidatedArtifacts.length > 0) {
      return `Artifact completion is blocked until validation passes for: ${unvalidatedArtifacts.join(', ')}`
    }
  }

  return null
}

export function validatePhaseResult(
  state: HarnessState,
  adapter: RepoAdapter,
  rawAssistantText: string,
  requireHumanGate: boolean = true,
): StopDecision {
  const parsedJson = parseStrictJson(rawAssistantText)
  if (!parsedJson.ok) {
    return {
      kind: 'block',
      reason: `${parsedJson.reason}\nRequired shape:\n${getPhaseResponseExample(
        state.currentPhase,
      )}`,
      state,
    }
  }

  const phaseResult = PhaseResultSchema().safeParse(parsedJson.value)
  if (!phaseResult.success) {
    return {
      kind: 'block',
      reason: `Phase result did not match the required schema.\n${phaseResult.error.message}\nRequired shape:\n${getPhaseResponseExample(
        state.currentPhase,
      )}`,
      state,
    }
  }

  if (phaseResult.data.phase !== state.currentPhase) {
    return {
      kind: 'block',
      reason: `The reported phase "${phaseResult.data.phase}" does not match the current phase "${state.currentPhase}".`,
      state,
    }
  }

  if (!isTransitionAllowed(state.currentPhase, phaseResult.data.nextPhase)) {
    return {
      kind: 'block',
      reason: `Illegal phase transition from ${state.currentPhase} to ${phaseResult.data.nextPhase}.`,
      state,
    }
  }

  const claimValidationError = validatePhaseClaims(phaseResult.data, state)
  if (claimValidationError) {
    return {
      kind: 'block',
      reason: claimValidationError,
      state,
    }
  }

  const claimLanguageError = validateClaimyLanguage(
    rawAssistantText,
    phaseResult.data,
  )
  if (claimLanguageError) {
    return {
      kind: 'block',
      reason: claimLanguageError,
      state,
    }
  }

  const verifierError = validateVerifiers(state, adapter, phaseResult.data)
  if (verifierError) {
    return {
      kind: 'block',
      reason: verifierError,
      state,
    }
  }

  const nextState: HarnessState = {
    ...state,
    phaseHistory: [...state.phaseHistory, phaseResult.data],
    lastValidatedPhaseResult: phaseResult.data,
  }

  if (
    requireHumanGate &&
    requiresHumanGate(state.currentPhase, phaseResult.data.nextPhase)
  ) {
    nextState.pendingHumanGate = {
      fromPhase: state.currentPhase,
      targetPhase: phaseResult.data.nextPhase,
      approvalToken: getApprovalToken(phaseResult.data.nextPhase),
      summary: phaseResult.data.summary,
    }
    return {
      kind: 'require_human_gate',
      reason: `Human approval required before entering ${phaseResult.data.nextPhase}. Type "${nextState.pendingHumanGate.approvalToken}" to continue.`,
      state: nextState,
    }
  }

  nextState.currentPhase = phaseResult.data.nextPhase
  nextState.pendingHumanGate = null

  return {
    kind: 'allow',
    state: nextState,
  }
}

function evaluateBashPolicy(
  state: HarnessState,
  adapter: RepoAdapter,
  command: string,
): ToolPolicyDecision {
  const normalizedCommand = normalizeCommand(command)
  const allowedPrefixes =
    adapter.approvedCommandPrefixes[state.currentPhase] ?? []

  if (!state.bootstrapCompleted) {
    const bootstrapAllowed =
      commandStartsWithAny(normalizedCommand, adapter.bootstrapCommands) ||
      commandStartsWithAny(normalizedCommand, adapter.analysisCommands)

    if (!bootstrapAllowed && /\b(find|git|rg)\b/.test(normalizedCommand)) {
      return {
        decision: 'block',
        reason:
          'Broad shell discovery is blocked until bootstrap completes. Run the repo adapter bootstrap commands first.',
      }
    }
  }

  if (
    normalizedCommand.includes('rg ') &&
    !normalizedCommand.includes("-g '!") &&
    !normalizedCommand.includes('--glob !')
  ) {
    return {
      decision: 'block',
      reason:
        'Shell ripgrep commands must include explicit excludes from the repo adapter to stay deterministic.',
    }
  }

  if (
    allowedPrefixes.length > 0 &&
    !commandStartsWithAny(normalizedCommand, allowedPrefixes) &&
    !commandStartsWithAny(normalizedCommand, adapter.riskyCommandAllowlist)
  ) {
    return {
      decision: 'block',
      reason: `Bash command is outside the approved command templates for the ${state.currentPhase} phase.`,
    }
  }

  return {
    decision: 'allow',
    reason: `Command is allowed in phase ${state.currentPhase}.`,
  }
}

export function evaluateToolPolicy(
  state: HarnessState,
  adapter: RepoAdapter,
  toolName: string,
  toolInput: Record<string, unknown>,
): ToolPolicyDecision {
  if (!PHASE_TOOL_ALLOWLIST[state.currentPhase].has(toolName)) {
    return {
      decision: 'block',
      reason: `Tool ${toolName} is not allowed during the ${state.currentPhase} phase.`,
    }
  }

  if (toolName === 'Bash') {
    const command =
      typeof toolInput.command === 'string' ? toolInput.command : ''
    return evaluateBashPolicy(state, adapter, command)
  }

  return {
    decision: 'allow',
    reason: `Tool ${toolName} is allowed during the ${state.currentPhase} phase.`,
  }
}

async function loadPersistedState(
  sessionId: string,
  repoRoot: string,
  adapterVersion: string,
): Promise<HarnessState | null> {
  try {
    const raw = await readFile(getStatePath(sessionId), 'utf8')
    const parsed = safeParseJSON(raw)
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    const data = parsed as SerializableHarnessState
    return {
      sessionId,
      taskId: data.taskId,
      runId: data.runId,
      repoRoot,
      adapterVersion,
      currentPhase: DeterministicPhaseSchema().parse(data.currentPhase),
      bootstrapCompleted: Boolean(data.bootstrapCompleted),
      taskSpec: data.taskSpec ? TaskSpecSchema().parse(data.taskSpec) : null,
      evidence: Array.isArray(data.evidence)
        ? data.evidence.map(record => EvidenceRecordSchema().parse(record))
        : [],
      verifiers: Array.isArray(data.verifiers)
        ? data.verifiers.map(record => VerifierResultSchema().parse(record))
        : [],
      policyLog: Array.isArray(data.policyLog)
        ? data.policyLog.map(record => PolicyDecisionSchema().parse(record))
        : [],
      writtenArtifacts:
        data.writtenArtifacts && typeof data.writtenArtifacts === 'object'
          ? data.writtenArtifacts
          : {},
      phaseHistory: Array.isArray(data.phaseHistory)
        ? data.phaseHistory.map(result => PhaseResultSchema().parse(result))
        : [],
      pendingHumanGate: data.pendingHumanGate ?? null,
      lastValidatedPhaseResult: data.lastValidatedPhaseResult
        ? PhaseResultSchema().parse(data.lastValidatedPhaseResult)
        : null,
    }
  } catch {
    return null
  }
}

async function persistState(state: HarnessState): Promise<void> {
  await mkdir(getStateDirectory(), { recursive: true })
  const serializableState: SerializableHarnessState = {
    sessionId: state.sessionId,
    taskId: state.taskId,
    runId: state.runId,
    adapterVersion: state.adapterVersion,
    currentPhase: state.currentPhase,
    bootstrapCompleted: state.bootstrapCompleted,
    taskSpec: state.taskSpec,
    evidence: state.evidence,
    verifiers: state.verifiers,
    policyLog: state.policyLog,
    writtenArtifacts: state.writtenArtifacts,
    phaseHistory: state.phaseHistory,
    pendingHumanGate: state.pendingHumanGate,
    lastValidatedPhaseResult: state.lastValidatedPhaseResult,
  }
  await writeFile(
    getStatePath(state.sessionId),
    `${jsonStringify(serializableState, null, 2)}\n`,
    'utf8',
  )
}

async function emitTelemetry(
  config: ResolvedDeterministicHarnessConfig,
  eventName: string,
  metadata: Record<string, string | undefined>,
): Promise<void> {
  if (!config.enabled || !config.emitTelemetry) {
    return
  }
  await logOTelEvent(eventName, metadata)
}

export async function resolveDeterministicHarnessConfig(
  repoRoot: string,
  settings: DeterministicHarnessSettings | undefined,
): Promise<ResolvedDeterministicHarnessConfig> {
  if (!settings?.enabled) {
    return { enabled: false }
  }

  if (settings.strictWorkflow === false) {
    return {
      enabled: true,
      strictWorkflow: false,
      requireHumanGate: settings.requireHumanGate ?? true,
      emitTelemetry: settings.emitTelemetry ?? true,
      strictJsonResponses: settings.strictJsonResponses ?? true,
      invalidReason:
        'deterministicHarness currently supports only strictWorkflow: true.',
      repoRoot,
      repoAdapter: null,
    }
  }

  if (settings.strictJsonResponses === false) {
    return {
      enabled: true,
      strictWorkflow: true,
      requireHumanGate: settings.requireHumanGate ?? true,
      emitTelemetry: settings.emitTelemetry ?? true,
      strictJsonResponses: false,
      invalidReason:
        'deterministicHarness currently supports only strictJsonResponses: true.',
      repoRoot,
      repoAdapter: null,
    }
  }

  let rawAdapter: unknown = settings.repoAdapter
  if (!rawAdapter && settings.repoAdapterPath) {
    const adapterPath = path.resolve(repoRoot, settings.repoAdapterPath)
    try {
      const raw = await readFile(adapterPath, 'utf8')
      rawAdapter = safeParseJSON(raw)
    } catch (error) {
      return {
        enabled: true,
        strictWorkflow: settings.strictWorkflow ?? true,
        requireHumanGate: settings.requireHumanGate ?? true,
        emitTelemetry: settings.emitTelemetry ?? true,
        strictJsonResponses: settings.strictJsonResponses ?? true,
        invalidReason: `Failed to read deterministic harness repo adapter at ${adapterPath}: ${String(
          error,
        )}`,
        repoRoot,
        repoAdapter: null,
      }
    }
  }

  if (!rawAdapter) {
    return {
      enabled: true,
      strictWorkflow: settings.strictWorkflow ?? true,
      requireHumanGate: settings.requireHumanGate ?? true,
      emitTelemetry: settings.emitTelemetry ?? true,
      strictJsonResponses: settings.strictJsonResponses ?? true,
      invalidReason:
        'Strict deterministic harness mode requires repoAdapter or repoAdapterPath.',
      repoRoot,
      repoAdapter: null,
    }
  }

  const parsedAdapter = RepoAdapterSchema().safeParse(rawAdapter)
  if (!parsedAdapter.success) {
    return {
      enabled: true,
      strictWorkflow: settings.strictWorkflow ?? true,
      requireHumanGate: settings.requireHumanGate ?? true,
      emitTelemetry: settings.emitTelemetry ?? true,
      strictJsonResponses: settings.strictJsonResponses ?? true,
      invalidReason: `Repo adapter validation failed: ${parsedAdapter.error.message}`,
      repoRoot,
      repoAdapter: null,
    }
  }

  return {
    enabled: true,
    strictWorkflow: settings.strictWorkflow ?? true,
    requireHumanGate: settings.requireHumanGate ?? true,
    emitTelemetry: settings.emitTelemetry ?? true,
    strictJsonResponses: settings.strictJsonResponses ?? true,
    repoRoot,
    repoAdapter: parsedAdapter.data,
  }
}

export class DeterministicHarnessController {
  private readonly states = new Map<string, HarnessState>()

  constructor(private readonly config: ResolvedDeterministicHarnessConfig) {}

  private getMainSessionKey(input: HookInput): string | null {
    return (input as { agent_id?: string }).agent_id ? null : input.session_id
  }

  private async getState(sessionId: string): Promise<HarnessState> {
    const cached = this.states.get(sessionId)
    if (cached) {
      return cached
    }

    const repoRoot = this.config.enabled ? this.config.repoRoot : process.cwd()
    const adapterVersion =
      this.config.enabled && this.config.repoAdapter
        ? this.config.repoAdapter.version
        : 'unconfigured'

    const persisted = await loadPersistedState(sessionId, repoRoot, adapterVersion)
    if (persisted) {
      this.states.set(sessionId, persisted)
      return persisted
    }

    const state: HarnessState = {
      sessionId,
      taskId: createTaskId(`session:${sessionId}`),
      runId: sessionId,
      repoRoot,
      adapterVersion,
      currentPhase: 'intake',
      bootstrapCompleted: false,
      taskSpec: null,
      evidence: [],
      verifiers: [],
      policyLog: [],
      writtenArtifacts: {},
      phaseHistory: [],
      pendingHumanGate: null,
      lastValidatedPhaseResult: null,
    }

    this.states.set(sessionId, state)
    await persistState(state)
    return state
  }

  private async saveState(state: HarnessState): Promise<void> {
    this.states.set(state.sessionId, state)
    await persistState(state)
  }

  async handleSessionStart(input: SessionStartHookInput): Promise<HookJSONOutput> {
    const sessionId = this.getMainSessionKey(input)
    if (!sessionId) {
      return {}
    }

    if (!this.config.enabled) {
      return {}
    }

    const state = await this.getState(sessionId)
    await emitTelemetry(this.config, 'deterministic_harness_session_start', {
      'deterministic.task_id': state.taskId,
      'deterministic.run_id': state.runId,
      'deterministic.repo': state.repoRoot,
      'deterministic.adapter_version': state.adapterVersion,
      'deterministic.phase': state.currentPhase,
      'deterministic.result': this.config.invalidReason ? 'invalid' : 'ready',
      'deterministic.policy_decision': this.config.invalidReason ? 'block' : 'allow',
    })

    const invalidContext = this.config.invalidReason
      ? `Strict deterministic harness mode is enabled but blocked: ${this.config.invalidReason}`
      : ''
    const adapter = this.config.repoAdapter
    const context = adapter
      ? [
          'Deterministic harness strict mode is active for this repository.',
          `Repo adapter version: ${adapter.version}.`,
          buildBootstrapReminder(adapter),
          buildPhaseContext(state, adapter),
        ]
          .filter(Boolean)
          .join(' ')
      : invalidContext

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    }
  }

  async handleUserPromptSubmit(
    input: UserPromptSubmitHookInput,
  ): Promise<HookJSONOutput> {
    const sessionId = this.getMainSessionKey(input)
    if (!sessionId || !this.config.enabled) {
      return {}
    }

    const state = await this.getState(sessionId)

    if (this.config.invalidReason || !this.config.repoAdapter) {
      return {
        decision: 'block',
        reason:
          this.config.invalidReason ??
          'Strict deterministic harness mode requires a valid repo adapter.',
      }
    }

    const normalizedPrompt = normalizeWhitespace(input.prompt).toLowerCase()
    if (state.pendingHumanGate) {
      if (normalizedPrompt !== state.pendingHumanGate.approvalToken) {
        return {
          decision: 'block',
          reason: `A human approval gate is pending. Type "${state.pendingHumanGate.approvalToken}" to continue from ${state.pendingHumanGate.fromPhase} to ${state.pendingHumanGate.targetPhase}.`,
        }
      }

      state.currentPhase = state.pendingHumanGate.targetPhase
      state.pendingHumanGate = null
      await this.saveState(state)
      await emitTelemetry(this.config, 'deterministic_harness_human_gate_approved', {
        'deterministic.task_id': state.taskId,
        'deterministic.run_id': state.runId,
        'deterministic.repo': state.repoRoot,
        'deterministic.adapter_version': state.adapterVersion,
        'deterministic.phase': state.currentPhase,
        'deterministic.result': 'approved',
        'deterministic.policy_decision': 'allow',
      })

      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: buildPhaseContext(state, this.config.repoAdapter),
        },
      }
    }

    if (state.currentPhase === 'done' || state.taskSpec === null) {
      state.taskSpec = deriveTaskSpec(input.prompt, state.repoRoot)
      state.taskId = createTaskId(input.prompt)
      state.currentPhase = 'discover'
      state.phaseHistory = []
      state.lastValidatedPhaseResult = null
      state.evidence = []
      state.verifiers = []
      state.policyLog = []
      state.writtenArtifacts = {}
      state.bootstrapCompleted = false
      await this.saveState(state)
      await emitTelemetry(this.config, 'deterministic_harness_task_initialized', {
        'deterministic.task_id': state.taskId,
        'deterministic.run_id': state.runId,
        'deterministic.repo': state.repoRoot,
        'deterministic.adapter_version': state.adapterVersion,
        'deterministic.phase': state.currentPhase,
        'deterministic.result': 'initialized',
        'deterministic.policy_decision': 'allow',
      })
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: buildPhaseContext(state, this.config.repoAdapter),
      },
    }
  }

  async handlePreToolUse(input: PreToolUseHookInput): Promise<HookJSONOutput> {
    const sessionId = this.getMainSessionKey(input)
    if (!sessionId || !this.config.enabled || !this.config.repoAdapter) {
      return {}
    }

    const state = await this.getState(sessionId)
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    const decision = evaluateToolPolicy(
      state,
      this.config.repoAdapter,
      input.tool_name,
      toolInput,
    )
    const command =
      input.tool_name === 'Bash' &&
      typeof toolInput.command === 'string'
        ? (toolInput.command as string)
        : undefined
    const policyRecord = createPolicyRecord(
      state,
      decision.decision,
      decision.reason,
      input.tool_name,
      command,
    )
    state.policyLog.push(policyRecord)
    await this.saveState(state)
    await emitTelemetry(this.config, 'deterministic_harness_policy_decision', {
      'deterministic.task_id': state.taskId,
      'deterministic.run_id': state.runId,
      'deterministic.repo': state.repoRoot,
      'deterministic.adapter_version': state.adapterVersion,
      'deterministic.phase': state.currentPhase,
      'deterministic.tool': input.tool_name,
      'deterministic.command': command ? truncate(normalizeCommand(command), 120) : undefined,
      'deterministic.result': decision.decision,
      'deterministic.policy_decision': decision.decision,
      'deterministic.evidence_count': String(state.evidence.length),
    })

    if (decision.decision === 'allow') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: decision.reason,
          additionalContext:
            input.tool_name === 'Bash'
              ? 'Approved command template matched the current deterministic phase.'
              : undefined,
        },
      }
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    }
  }

  async handlePostToolUse(input: PostToolUseHookInput): Promise<HookJSONOutput> {
    const sessionId = this.getMainSessionKey(input)
    if (!sessionId || !this.config.enabled || !this.config.repoAdapter) {
      return {}
    }

    const state = await this.getState(sessionId)
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    const record = createEvidenceRecord(
      state,
      input.tool_name,
      'tool_succeeded',
      toolInput,
      input.tool_response,
    )
    state.evidence.push(record)

    let verifierResult: VerifierResult | undefined
    if (
      input.tool_name === 'Bash' &&
      typeof toolInput.command === 'string'
    ) {
      const command = toolInput.command as string
      const verifier = getVerifierName(this.config.repoAdapter, command)
      if (verifier?.type === 'bootstrap') {
        state.bootstrapCompleted = true
      }
      if (verifier && verifier.type !== 'bootstrap') {
        verifierResult = createVerifierResult(state, verifier.name, 'passed')
        state.verifiers.push(verifierResult)
      }
      recordArtifactValidation(state, this.config.repoAdapter, command)
    }

    if (
      (input.tool_name === 'Write' || input.tool_name === 'Edit') &&
      typeof toolInput.file_path === 'string'
    ) {
      recordArtifactWrite(state, this.config.repoAdapter, toolInput.file_path as string)
    }

    await this.saveState(state)
    await emitTelemetry(this.config, 'deterministic_harness_evidence_recorded', {
      'deterministic.task_id': state.taskId,
      'deterministic.run_id': state.runId,
      'deterministic.repo': state.repoRoot,
      'deterministic.adapter_version': state.adapterVersion,
      'deterministic.phase': state.currentPhase,
      'deterministic.tool': input.tool_name,
      'deterministic.result': verifierResult?.status ?? 'recorded',
      'deterministic.verifier': verifierResult?.verifierName,
      'deterministic.evidence_count': String(state.evidence.length),
    })

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: buildToolFeedbackContext(
          state,
          record,
          verifierResult,
        ),
      },
    }
  }

  async handlePostToolUseFailure(
    input: PostToolUseFailureHookInput,
  ): Promise<HookJSONOutput> {
    const sessionId = this.getMainSessionKey(input)
    if (!sessionId || !this.config.enabled || !this.config.repoAdapter) {
      return {}
    }

    const state = await this.getState(sessionId)
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    const record = createEvidenceRecord(
      state,
      input.tool_name,
      'tool_failed',
      toolInput,
      input.error,
    )
    state.evidence.push(record)

    let verifierResult: VerifierResult | undefined
    if (
      input.tool_name === 'Bash' &&
      typeof toolInput.command === 'string'
    ) {
      const verifier = getVerifierName(
        this.config.repoAdapter,
        toolInput.command as string,
      )
      if (verifier && verifier.type !== 'bootstrap') {
        verifierResult = createVerifierResult(
          state,
          verifier.name,
          'failed',
          input.error,
        )
        state.verifiers.push(verifierResult)
      }
    }

    await this.saveState(state)
    await emitTelemetry(this.config, 'deterministic_harness_verifier_failure', {
      'deterministic.task_id': state.taskId,
      'deterministic.run_id': state.runId,
      'deterministic.repo': state.repoRoot,
      'deterministic.adapter_version': state.adapterVersion,
      'deterministic.phase': state.currentPhase,
      'deterministic.tool': input.tool_name,
      'deterministic.result': verifierResult?.status ?? 'failed',
      'deterministic.verifier': verifierResult?.verifierName,
      'deterministic.evidence_count': String(state.evidence.length),
    })

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: buildToolFeedbackContext(
          state,
          record,
          verifierResult,
        ),
      },
    }
  }

  async handleStop(input: StopHookInput): Promise<HookJSONOutput> {
    const sessionId = this.getMainSessionKey(input)
    if (!sessionId || !this.config.enabled || !this.config.repoAdapter) {
      return {}
    }

    const state = await this.getState(sessionId)
    const lastAssistantMessage = (input as { last_assistant_message?: string }).last_assistant_message ?? ''
    const decision = validatePhaseResult(
      state,
      this.config.repoAdapter,
      lastAssistantMessage,
      this.config.requireHumanGate,
    )

    if (decision.kind === 'allow') {
      await this.saveState(decision.state)
      await emitTelemetry(this.config, 'deterministic_harness_phase_transition', {
        'deterministic.task_id': decision.state.taskId,
        'deterministic.run_id': decision.state.runId,
        'deterministic.repo': decision.state.repoRoot,
        'deterministic.adapter_version': decision.state.adapterVersion,
        'deterministic.phase': decision.state.currentPhase,
        'deterministic.result': 'allow',
        'deterministic.policy_decision': 'allow',
        'deterministic.evidence_count': String(decision.state.evidence.length),
      })
      return {}
    }

    if (decision.kind === 'require_human_gate') {
      await this.saveState(decision.state)
      await emitTelemetry(this.config, 'deterministic_harness_human_gate_required', {
        'deterministic.task_id': decision.state.taskId,
        'deterministic.run_id': decision.state.runId,
        'deterministic.repo': decision.state.repoRoot,
        'deterministic.adapter_version': decision.state.adapterVersion,
        'deterministic.phase': decision.state.currentPhase,
        'deterministic.result': 'require_human_gate',
        'deterministic.policy_decision': 'require_human_gate',
        'deterministic.evidence_count': String(decision.state.evidence.length),
      })
      return {
        continue: false,
        stopReason: decision.reason,
        systemMessage: decision.reason,
      }
    }

    await this.saveState(decision.state)
    await emitTelemetry(this.config, 'deterministic_harness_phase_blocked', {
      'deterministic.task_id': decision.state.taskId,
      'deterministic.run_id': decision.state.runId,
      'deterministic.repo': decision.state.repoRoot,
      'deterministic.adapter_version': decision.state.adapterVersion,
      'deterministic.phase': decision.state.currentPhase,
      'deterministic.result': 'retry_with_feedback',
      'deterministic.policy_decision': 'retry_with_feedback',
      'deterministic.evidence_count': String(decision.state.evidence.length),
    })
    return {
      decision: 'block',
      reason: decision.reason,
      systemMessage: decision.reason,
    }
  }
}

export function createTestHarnessState(
  repoRoot: string,
  adapterVersion: string = 'test',
): HarnessState {
  return {
    sessionId: 'test-session',
    taskId: 'task-test',
    runId: 'run-test',
    repoRoot,
    adapterVersion,
    currentPhase: 'intake',
    bootstrapCompleted: false,
    taskSpec: null,
    evidence: [],
    verifiers: [],
    policyLog: [],
    writtenArtifacts: {},
    phaseHistory: [],
    pendingHumanGate: null,
    lastValidatedPhaseResult: null,
  }
}
