import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { Script, createContext } from 'node:vm'
import { getOriginalCwd, getSessionId, getSessionProjectDir } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import { commandBelongsToServer } from '../../services/mcp/utils.js'
import type { WorkflowCapabilityGrant } from '../../types/command.js'
import { WORKFLOW_CAPABILITY_GRANTS } from '../../types/command.js'
import { getBrowserHarnessStatus, type BrowserHarnessStatus } from '../../utils/browserHarness.js'
import {
  getCapabilityFamily,
  rankCapabilities,
  type CapabilityFamily,
} from '../../utils/capabilityDiscovery.js'
import { errorMessage } from '../../utils/errors.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import type {
  WorkflowCommand,
  WorkflowFinalState,
  WorkflowStepOutcome,
} from '../../utils/workflowCommands.js'

type CapabilityDescriptor = {
  name: string
  displayName: string
  description: string
  verbs: string[]
  outputs: string[]
  artifactKinds: string[]
  family: CapabilityFamily
  source: string | undefined
  kind: 'workflow' | 'capability'
}

type CliCapabilityDescriptor = {
  name: string
  workflowAllowed: boolean
  available: boolean
}

type McpServerDescriptor = {
  name: string
  connected: boolean
  workflowCount: number
  skillCount: number
  resourceCount: number
}

type CodeModeCapabilitySnapshot = {
  workspace: {
    root: string
    transcriptProjectDir: string
    sessionId: string
    transcriptSubdir: string
    statePath: string
  }
  discovery: {
    capabilityCount: number
    families: CapabilityFamily[]
  }
  github: {
    workflows: CapabilityDescriptor[]
    repoCapabilities: CapabilityDescriptor[]
  }
  docs: {
    workflows: CapabilityDescriptor[]
    docCapabilities: CapabilityDescriptor[]
  }
  browser: {
    status: BrowserHarnessStatus
    workflows: CapabilityDescriptor[]
  }
  cli: {
    allowedTools: string[]
    tools: CliCapabilityDescriptor[]
  }
  mcp: {
    servers: McpServerDescriptor[]
    workflows: CapabilityDescriptor[]
    skills: CapabilityDescriptor[]
  }
}

type PersistedStepOutcome = {
  stepIndex: number
  title: string
  status: WorkflowStepOutcome['state']['status']
  summary: string
  artifacts: string[]
  risks: string[]
  handoff: Record<string, string>
}

type PersistedCodeModeState = {
  workflow: {
    name: string
    displayName: string
    args: string
    runtime: 'code'
    capabilityGrants: WorkflowCapabilityGrant[]
    transcriptSubdir: string
  }
  phase: 'planning' | 'executing' | 'completed' | 'failed'
  programSource?: string
  userState: Record<string, unknown>
  stepOutcomes: PersistedStepOutcome[]
  capabilities: CodeModeCapabilitySnapshot
  finalState?: WorkflowFinalState
  error?: string
  updatedAt: string
}

type CodeModeStateApi = {
  get(key: string): unknown
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  snapshot(): Record<string, unknown>
  replace(nextState: Record<string, unknown>): Promise<void>
}

type CodeModeWorkflowApi = {
  name: string
  steps: ReadonlyArray<
    Readonly<NonNullable<WorkflowCommand['workflowSteps']>[number]>
  >
  inputs: ReadonlyArray<string>
  outputs: ReadonlyArray<string>
  artifactKinds: ReadonlyArray<string>
  successCriteria: ReadonlyArray<string>
  handoffFields: ReadonlyArray<string>
  runStep(stepIndex: number): Promise<WorkflowStepOutcome>
  skipStep(stepIndex: number, reason?: string): Promise<WorkflowStepOutcome>
  getHandoff(): Record<string, string>
  getOutcomes(): WorkflowStepOutcome[]
  hasOutcome(stepIndex: number): boolean
}

type CodeModeCliApi = {
  allowedTools(): string[]
  listTools(): CliCapabilityDescriptor[]
  isAllowed(toolName: string): boolean
  isAvailable(toolName: string): boolean
}

type CodeModeBrowserApi = {
  status(): BrowserHarnessStatus
  listWorkflows(): CapabilityDescriptor[]
  hasWorkflow(name: string): boolean
}

type CodeModeGitHubApi = {
  listWorkflows(): CapabilityDescriptor[]
  hasWorkflow(name: string): boolean
  listRepoCapabilities(): CapabilityDescriptor[]
}

type CodeModeDocsApi = {
  listWorkflows(): CapabilityDescriptor[]
  hasWorkflow(name: string): boolean
  listDocCapabilities(): CapabilityDescriptor[]
}

type CodeModeWorkspaceApi = {
  root(): string
  sessionId(): string
  transcriptProjectDir(): string
  transcriptSubdir(): string
  statePath(): string
  info(): CodeModeCapabilitySnapshot['workspace']
}

type CodeModeDiscoveryApi = {
  listFamilies(): CapabilityFamily[]
  search(query: string, limit?: number): CapabilityDescriptor[]
  searchByFamily(
    family: CapabilityFamily,
    query?: string,
    limit?: number,
  ): CapabilityDescriptor[]
}

type CodeModeMcpApi = {
  listServers(): McpServerDescriptor[]
  listWorkflows(serverName?: string): CapabilityDescriptor[]
  listSkills(serverName?: string): CapabilityDescriptor[]
  hasServer(serverName: string): boolean
}

type CodeModeProgramApi = {
  args: string
  state: CodeModeStateApi
  workflow: CodeModeWorkflowApi
  browser?: CodeModeBrowserApi
  github?: CodeModeGitHubApi
  docs?: CodeModeDocsApi
  cli?: CodeModeCliApi
  mcp?: CodeModeMcpApi
  workspace?: CodeModeWorkspaceApi
  discovery?: CodeModeDiscoveryApi
  runStep(stepIndex: number): Promise<WorkflowStepOutcome>
  skipStep(stepIndex: number, reason?: string): Promise<WorkflowStepOutcome>
  getHandoff(): Record<string, string>
  getOutcomes(): WorkflowStepOutcome[]
  hasOutcome(stepIndex: number): boolean
}

type CodeModeExecutorArgs = {
  command: WorkflowCommand
  argsText: string
  transcriptSubdir: string
  context: ToolUseContext
  commands: Command[]
  statePath?: string
  runStep(stepIndex: number): Promise<WorkflowStepOutcome>
  skipStep(stepIndex: number, reason?: string): Promise<WorkflowStepOutcome>
  getOutcomes(): WorkflowStepOutcome[]
  getHandoff(): Record<string, string>
  hasOutcome(stepIndex: number): boolean
}

type CodeModeExecutionResult = {
  stepOutcomes: WorkflowStepOutcome[]
  stateStore: CodeModeStateStore
  programSource: string
}

function toSerializable<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch (error) {
    throw new Error(
      `Code mode state values must be JSON-serializable: ${errorMessage(error)}`,
    )
  }
}

function summarizeCommand(command: Command): CapabilityDescriptor {
  return {
    name: command.name,
    displayName: command.userFacingName?.() ?? command.name,
    description: command.description,
    verbs: [...(command.verbs ?? [])],
    outputs: [...(command.outputs ?? [])],
    artifactKinds: [...(command.artifactKinds ?? [])],
    family: getCapabilityFamily(command),
    source: command.loadedFrom ?? ('source' in command ? command.source : undefined),
    kind: command.kind === 'workflow' ? 'workflow' : 'capability',
  }
}

const CAPABILITY_FAMILIES: CapabilityFamily[] = [
  'workflow',
  'browser',
  'integration',
  'pack',
  'builtin',
  'general',
]

function clampDiscoveryLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return 5
  }
  return Math.min(25, Math.max(1, Math.trunc(limit)))
}

function buildAllCommands(context: ToolUseContext, commands: Command[]): Command[] {
  const commandMap = new Map<string, Command>()
  for (const item of commands) {
    commandMap.set(item.name, item)
  }
  for (const mcpCommand of context.getAppState().mcp.commands) {
    commandMap.set(mcpCommand.name, mcpCommand)
  }
  return [...commandMap.values()]
}

function looksBrowserBackedCapability(command: Command): boolean {
  const text = collectCommandText(command)

  return (
    getCapabilityFamily(command) === 'browser' ||
    text.includes('browser') ||
    text.includes('funnel') ||
    text.includes('website')
  )
}

function collectCommandText(command: Command): string {
  return [
    command.name,
    command.userFacingName?.(),
    command.description,
    command.whenToUse,
    ...(command.aliases ?? []),
    ...(command.verbs ?? []),
    ...(command.inputs ?? []),
    ...(command.outputs ?? []),
    ...(command.artifactKinds ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => text.includes(keyword))
}

const GITHUB_DOMAIN_KEYWORDS = [
  'github',
  'pull request',
  'pull-request',
  'pull_request',
  'repository',
  'issues',
  'issue',
  'workflow run',
]

const DOCS_DOMAIN_KEYWORDS = [
  'google docs',
  'google-docs',
  'google docs',
  'google drive',
  'google-drive',
  'google_drive',
  'document',
  'documents',
  'spreadsheet',
  'spreadsheets',
  'sheet',
  'slides',
  'deck',
  'docs',
  'drive',
]

function looksGitHubCapability(command: Command): boolean {
  const text = collectCommandText(command)
  return (
    command.name.startsWith('github:') ||
    command.name.includes('mcp__github__') ||
    matchesAnyKeyword(text, GITHUB_DOMAIN_KEYWORDS)
  )
}

function looksDocsCapability(command: Command): boolean {
  const text = collectCommandText(command)
  return (
    command.name.startsWith('google-drive:') ||
    command.name.startsWith('google-docs:') ||
    command.name.includes('google_drive') ||
    matchesAnyKeyword(text, DOCS_DOMAIN_KEYWORDS)
  )
}

function cloneCapabilityDescriptor(
  descriptor: CapabilityDescriptor,
): CapabilityDescriptor {
  return {
    ...descriptor,
    verbs: [...descriptor.verbs],
    outputs: [...descriptor.outputs],
    artifactKinds: [...descriptor.artifactKinds],
  }
}

function resolveCapabilityGrants(
  command: WorkflowCommand,
): Set<WorkflowCapabilityGrant> {
  return new Set(
    command.capabilityGrants && command.capabilityGrants.length > 0
      ? command.capabilityGrants
      : WORKFLOW_CAPABILITY_GRANTS,
  )
}

function hasCapabilityGrant(
  grants: Set<WorkflowCapabilityGrant>,
  grant: WorkflowCapabilityGrant,
): boolean {
  return grants.has(grant)
}

function isVisibleForCapabilityGrants(
  command: Extract<Command, { type: 'prompt' }>,
  grants: Set<WorkflowCapabilityGrant>,
): boolean {
  return (
    (hasCapabilityGrant(grants, 'browser') && looksBrowserBackedCapability(command)) ||
    (hasCapabilityGrant(grants, 'github') && looksGitHubCapability(command)) ||
    (hasCapabilityGrant(grants, 'docs') && looksDocsCapability(command)) ||
    (hasCapabilityGrant(grants, 'mcp') && command.loadedFrom === 'mcp')
  )
}

function buildCapabilitySnapshot(
  allCommands: Command[],
  command: WorkflowCommand,
  context: ToolUseContext,
  browserStatus: BrowserHarnessStatus,
  statePath: string,
  transcriptSubdir: string,
): CodeModeCapabilitySnapshot {
  const capabilityGrants = resolveCapabilityGrants(command)
  const hasExplicitCapabilityGrants = Boolean(command.capabilityGrants?.length)
  const promptCommands = allCommands.filter(
    (item): item is Extract<Command, { type: 'prompt' }> => item.type === 'prompt',
  )
  const visiblePromptCommands = hasExplicitCapabilityGrants
    ? promptCommands.filter(item =>
        isVisibleForCapabilityGrants(item, capabilityGrants),
      )
    : promptCommands
  const browserWorkflows = hasCapabilityGrant(capabilityGrants, 'browser')
    ? promptCommands.filter(looksBrowserBackedCapability)
    : []
  const githubCommands = hasCapabilityGrant(capabilityGrants, 'github')
    ? promptCommands.filter(looksGitHubCapability)
    : []
  const docsCommands = hasCapabilityGrant(capabilityGrants, 'docs')
    ? promptCommands.filter(looksDocsCapability)
    : []
  const githubWorkflows = githubCommands.filter(item => item.kind === 'workflow')
  const githubRepoCapabilities = githubCommands.filter(
    item => item.kind !== 'workflow',
  )
  const docsWorkflows = docsCommands.filter(item => item.kind === 'workflow')
  const docsCapabilities = docsCommands.filter(item => item.kind !== 'workflow')
  const mcpCommands = hasCapabilityGrant(capabilityGrants, 'mcp')
    ? allCommands.filter(item => item.loadedFrom === 'mcp')
    : []
  const mcpWorkflows = mcpCommands.filter(item => item.kind === 'workflow')
  const mcpSkills = mcpCommands.filter(item => item.kind !== 'workflow')
  const allowedTools = hasCapabilityGrant(capabilityGrants, 'cli')
    ? [...(command.allowedTools ?? [])]
    : []
  const availableTools = hasCapabilityGrant(capabilityGrants, 'cli')
    ? context.options.tools.map(tool => ({
        name: tool.name,
        workflowAllowed: allowedTools.includes(tool.name),
        available: true,
      }))
    : []

  const mcpServers = hasCapabilityGrant(capabilityGrants, 'mcp')
    ? context.getAppState().mcp.clients.map(client => {
        const serverCommands = mcpCommands.filter(item =>
          commandBelongsToServer(item, client.name),
        )
        return {
          name: client.name,
          connected: client.type === 'connected',
          workflowCount: serverCommands.filter(item => item.kind === 'workflow')
            .length,
          skillCount: serverCommands.filter(item => item.kind !== 'workflow')
            .length,
          resourceCount:
            context.getAppState().mcp.resources[client.name]?.length ?? 0,
        }
      })
    : []

  const visibleFamilies = [
    ...new Set(visiblePromptCommands.map(item => getCapabilityFamily(item))),
  ]

  return {
    workspace: {
      root: getOriginalCwd(),
      transcriptProjectDir:
        getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
      sessionId: getSessionId(),
      transcriptSubdir,
      statePath,
    },
    discovery: {
      capabilityCount: visiblePromptCommands.length,
      families:
        visibleFamilies.length > 0
          ? visibleFamilies
          : hasExplicitCapabilityGrants
            ? []
            : [...CAPABILITY_FAMILIES],
    },
    github: {
      workflows: githubWorkflows.map(summarizeCommand),
      repoCapabilities: githubRepoCapabilities.map(summarizeCommand),
    },
    docs: {
      workflows: docsWorkflows.map(summarizeCommand),
      docCapabilities: docsCapabilities.map(summarizeCommand),
    },
    browser: {
      status: browserStatus,
      workflows: browserWorkflows.map(summarizeCommand),
    },
    cli: {
      allowedTools,
      tools: availableTools,
    },
    mcp: {
      servers: mcpServers,
      workflows: mcpWorkflows.map(summarizeCommand),
      skills: mcpSkills.map(summarizeCommand),
    },
  }
}

function getCodeModeStatePath(
  transcriptSubdir: string,
  overridePath?: string,
): string {
  if (overridePath) {
    return overridePath
  }

  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(
    projectDir,
    getSessionId(),
    'subagents',
    transcriptSubdir,
    'code-mode-state.json',
  )
}

function toPersistedOutcome(
  stepOutcome: WorkflowStepOutcome,
  stepIndex: number,
): PersistedStepOutcome {
  return {
    stepIndex,
    title: stepOutcome.step.title,
    status: stepOutcome.state.status,
    summary: stepOutcome.state.summary,
    artifacts: [...stepOutcome.state.artifacts],
    risks: [...stepOutcome.state.risks],
    handoff: { ...stepOutcome.state.handoff },
  }
}

export class CodeModeStateStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    readonly path: string,
    private document: PersistedCodeModeState,
  ) {}

  static async create(args: {
    path: string
    command: WorkflowCommand
    argsText: string
    transcriptSubdir: string
    capabilities: CodeModeCapabilitySnapshot
  }): Promise<CodeModeStateStore> {
    const store = new CodeModeStateStore(args.path, {
      workflow: {
        name: args.command.name,
        displayName: args.command.userFacingName?.() ?? args.command.name,
        args: args.argsText,
        runtime: 'code',
        capabilityGrants: [
          ...(args.command.capabilityGrants?.length
            ? args.command.capabilityGrants
            : WORKFLOW_CAPABILITY_GRANTS),
        ],
        transcriptSubdir: args.transcriptSubdir,
      },
      phase: 'planning',
      userState: {},
      stepOutcomes: [],
      capabilities: args.capabilities,
      updatedAt: new Date().toISOString(),
    })
    await store.persist()
    return store
  }

  snapshot(): PersistedCodeModeState {
    return toSerializable(this.document)
  }

  buildStateApi(): CodeModeStateApi {
    return Object.freeze({
      get: (key: string) => this.document.userState[key],
      set: async (key: string, value: unknown) => {
        const next = {
          ...this.document.userState,
          [key]: toSerializable(value),
        }
        await this.replaceUserState(next)
      },
      delete: async (key: string) => {
        const next = { ...this.document.userState }
        delete next[key]
        await this.replaceUserState(next)
      },
      snapshot: () => toSerializable(this.document.userState),
      replace: async nextState => {
        await this.replaceUserState(nextState)
      },
    })
  }

  async setPhase(
    phase: PersistedCodeModeState['phase'],
    error?: string,
  ): Promise<void> {
    this.document.phase = phase
    this.document.error = error
    await this.persist()
  }

  async setProgramSource(source: string): Promise<void> {
    this.document.programSource = source
    await this.persist()
  }

  async recordOutcomes(stepOutcomes: WorkflowStepOutcome[]): Promise<void> {
    this.document.stepOutcomes = stepOutcomes.map((outcome, index) =>
      toPersistedOutcome(outcome, index),
    )
    await this.persist()
  }

  async setFinalState(finalState: WorkflowFinalState): Promise<void> {
    this.document.finalState = toSerializable(finalState)
    this.document.phase = 'completed'
    await this.persist()
  }

  private async replaceUserState(
    nextState: Record<string, unknown>,
  ): Promise<void> {
    this.document.userState = toSerializable(nextState)
    await this.persist()
  }

  private async persist(): Promise<void> {
    this.document.updatedAt = new Date().toISOString()
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(
        this.path,
        `${JSON.stringify(this.document, null, 2)}\n`,
        'utf-8',
      )
    })
    await this.writeQueue
  }
}

function createLockedSandbox(programSource: string): (api: CodeModeProgramApi) => unknown {
  const sandbox = createContext(
    {
      Promise,
      Array,
      Object,
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Date,
      URL,
      URLSearchParams,
    },
    {
      codeGeneration: {
        strings: false,
        wasm: false,
      },
      name: 'cc-code-mode',
    },
  )

  Reflect.set(sandbox, 'globalThis', sandbox)

  let program: unknown
  try {
    program = new Script(`(${programSource.trim()})`, {
      filename: 'workflow-code-mode.js',
    }).runInContext(sandbox, {
      timeout: 1000,
    })
  } catch (error) {
    throw new Error(
      `Workflow code program could not be compiled in the locked sandbox: ${errorMessage(error)}`,
    )
  }

  if (typeof program !== 'function') {
    throw new Error(
      'Workflow code mode must return a JavaScript function of the form async (api) => { ... }',
    )
  }

  return program as (api: CodeModeProgramApi) => unknown
}

async function runProgramInSandbox(
  program: (api: CodeModeProgramApi) => unknown,
  api: CodeModeProgramApi,
): Promise<void> {
  const timeoutMs = 5000
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      Promise.resolve()
        .then(() => program(api))
        .then(() => undefined),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(`Workflow code program timed out after ${timeoutMs}ms`),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

export class CodeModeExecutor {
  private constructor(
    private readonly args: CodeModeExecutorArgs,
    private readonly allCommands: Command[],
    private readonly capabilitySnapshot: CodeModeCapabilitySnapshot,
    readonly stateStore: CodeModeStateStore,
  ) {}

  static async create(args: CodeModeExecutorArgs): Promise<CodeModeExecutor> {
    const allCommands = buildAllCommands(args.context, [
      args.command,
      ...args.commands,
    ])
    const browserStatus = await getBrowserHarnessStatus()
    const statePath = getCodeModeStatePath(args.transcriptSubdir, args.statePath)
    const capabilitySnapshot = buildCapabilitySnapshot(
      allCommands,
      args.command,
      args.context,
      browserStatus,
      statePath,
      args.transcriptSubdir,
    )
    const stateStore = await CodeModeStateStore.create({
      path: statePath,
      command: args.command,
      argsText: args.argsText,
      transcriptSubdir: args.transcriptSubdir,
      capabilities: capabilitySnapshot,
    })

    return new CodeModeExecutor(args, allCommands, capabilitySnapshot, stateStore)
  }

  async execute(programSource: string): Promise<CodeModeExecutionResult> {
    await this.stateStore.setProgramSource(programSource)
    await this.stateStore.setPhase('executing')

    const program = createLockedSandbox(programSource)
    const stateApi = this.stateStore.buildStateApi()

    const workflowApi: CodeModeWorkflowApi = Object.freeze({
      name: this.args.command.userFacingName?.() ?? this.args.command.name,
      steps: Object.freeze(
        (this.args.command.workflowSteps ?? []).map(step =>
          Object.freeze({ ...step }),
        ),
      ),
      inputs: Object.freeze([...(this.args.command.inputs ?? [])]),
      outputs: Object.freeze([...(this.args.command.outputs ?? [])]),
      artifactKinds: Object.freeze([...(this.args.command.artifactKinds ?? [])]),
      successCriteria: Object.freeze([
        ...(this.args.command.successCriteria ?? []),
      ]),
      handoffFields: Object.freeze([...(this.args.command.handoffFields ?? [])]),
      runStep: async stepIndex => {
        const outcome = await this.args.runStep(stepIndex)
        await this.stateStore.recordOutcomes(this.args.getOutcomes())
        return outcome
      },
      skipStep: async (stepIndex, reason) => {
        const outcome = await this.args.skipStep(stepIndex, reason)
        await this.stateStore.recordOutcomes(this.args.getOutcomes())
        return outcome
      },
      getHandoff: () => this.args.getHandoff(),
      getOutcomes: () => this.args.getOutcomes(),
      hasOutcome: stepIndex => this.args.hasOutcome(stepIndex),
    })

    const cliApi: CodeModeCliApi = Object.freeze({
      allowedTools: () => [...this.capabilitySnapshot.cli.allowedTools],
      listTools: () =>
        this.capabilitySnapshot.cli.tools.map(tool => ({ ...tool })),
      isAllowed: toolName =>
        this.capabilitySnapshot.cli.allowedTools.includes(toolName),
      isAvailable: toolName =>
        this.capabilitySnapshot.cli.tools.some(tool => tool.name === toolName),
    })

    const browserApi: CodeModeBrowserApi = Object.freeze({
      status: () => ({ ...this.capabilitySnapshot.browser.status }),
      listWorkflows: () =>
        this.capabilitySnapshot.browser.workflows.map(cloneCapabilityDescriptor),
      hasWorkflow: name =>
        this.capabilitySnapshot.browser.workflows.some(
          workflow =>
            workflow.name === name || workflow.displayName === name,
        ),
    })

    const githubApi: CodeModeGitHubApi = Object.freeze({
      listWorkflows: () =>
        this.capabilitySnapshot.github.workflows.map(cloneCapabilityDescriptor),
      hasWorkflow: name =>
        this.capabilitySnapshot.github.workflows.some(
          workflow =>
            workflow.name === name || workflow.displayName === name,
        ),
      listRepoCapabilities: () =>
        this.capabilitySnapshot.github.repoCapabilities.map(
          cloneCapabilityDescriptor,
        ),
    })

    const docsApi: CodeModeDocsApi = Object.freeze({
      listWorkflows: () =>
        this.capabilitySnapshot.docs.workflows.map(cloneCapabilityDescriptor),
      hasWorkflow: name =>
        this.capabilitySnapshot.docs.workflows.some(
          workflow =>
            workflow.name === name || workflow.displayName === name,
        ),
      listDocCapabilities: () =>
        this.capabilitySnapshot.docs.docCapabilities.map(
          cloneCapabilityDescriptor,
        ),
    })

    const workspaceApi: CodeModeWorkspaceApi = Object.freeze({
      root: () => this.capabilitySnapshot.workspace.root,
      sessionId: () => this.capabilitySnapshot.workspace.sessionId,
      transcriptProjectDir: () =>
        this.capabilitySnapshot.workspace.transcriptProjectDir,
      transcriptSubdir: () => this.capabilitySnapshot.workspace.transcriptSubdir,
      statePath: () => this.capabilitySnapshot.workspace.statePath,
      info: () => ({ ...this.capabilitySnapshot.workspace }),
    })

    const capabilityGrants = resolveCapabilityGrants(this.args.command)
    const hasExplicitCapabilityGrants = Boolean(
      this.args.command.capabilityGrants?.length,
    )
    const promptCapabilities = this.allCommands.filter(
      (item): item is Extract<Command, { type: 'prompt' }> =>
        item.type === 'prompt' &&
        (!hasExplicitCapabilityGrants ||
          isVisibleForCapabilityGrants(item, capabilityGrants)),
    )

    const discoveryApi: CodeModeDiscoveryApi = Object.freeze({
      listFamilies: () => [...this.capabilitySnapshot.discovery.families],
      search: (query, limit) =>
        rankCapabilities(promptCapabilities, {
          queryText: query,
        })
          .slice(0, clampDiscoveryLimit(limit))
          .map(summarizeCommand),
      searchByFamily: (family, query, limit) => {
        const filtered = promptCapabilities.filter(
          capability => getCapabilityFamily(capability) === family,
        )
        const limited = clampDiscoveryLimit(limit)
        if (!query?.trim()) {
          return filtered.slice(0, limited).map(summarizeCommand)
        }
        return rankCapabilities(filtered, {
          queryText: query,
        })
          .slice(0, limited)
          .map(summarizeCommand)
      },
    })

    const mcpApi: CodeModeMcpApi = Object.freeze({
      listServers: () =>
        this.capabilitySnapshot.mcp.servers.map(server => ({ ...server })),
      listWorkflows: serverName =>
        this.capabilitySnapshot.mcp.workflows
          .filter(workflow =>
            serverName ? workflow.name.startsWith(`${serverName}:`) : true,
          )
          .map(workflow => ({
            ...workflow,
            verbs: [...workflow.verbs],
            outputs: [...workflow.outputs],
            artifactKinds: [...workflow.artifactKinds],
          })),
      listSkills: serverName =>
        this.capabilitySnapshot.mcp.skills
          .filter(skill =>
            serverName ? skill.name.startsWith(`${serverName}:`) : true,
          )
          .map(skill => ({
            ...skill,
            verbs: [...skill.verbs],
            outputs: [...skill.outputs],
            artifactKinds: [...skill.artifactKinds],
          })),
      hasServer: serverName =>
        this.capabilitySnapshot.mcp.servers.some(
          server => server.name === serverName,
        ),
    })

    const api: CodeModeProgramApi = {
      args: this.args.argsText,
      state: stateApi,
      workflow: workflowApi,
      runStep: workflowApi.runStep,
      skipStep: workflowApi.skipStep,
      getHandoff: workflowApi.getHandoff,
      getOutcomes: workflowApi.getOutcomes,
      hasOutcome: workflowApi.hasOutcome,
    }
    if (hasCapabilityGrant(capabilityGrants, 'browser')) {
      api.browser = browserApi
    }
    if (hasCapabilityGrant(capabilityGrants, 'github')) {
      api.github = githubApi
    }
    if (hasCapabilityGrant(capabilityGrants, 'docs')) {
      api.docs = docsApi
    }
    if (hasCapabilityGrant(capabilityGrants, 'cli')) {
      api.cli = cliApi
    }
    if (hasCapabilityGrant(capabilityGrants, 'mcp')) {
      api.mcp = mcpApi
    }
    if (hasCapabilityGrant(capabilityGrants, 'workspace')) {
      api.workspace = workspaceApi
    }
    if (hasCapabilityGrant(capabilityGrants, 'discovery')) {
      api.discovery = discoveryApi
    }

    try {
      await runProgramInSandbox(program, Object.freeze(api))
      await this.stateStore.recordOutcomes(this.args.getOutcomes())
      return {
        stepOutcomes: this.args.getOutcomes(),
        stateStore: this.stateStore,
        programSource,
      }
    } catch (error) {
      await this.stateStore.recordOutcomes(this.args.getOutcomes())
      await this.stateStore.setPhase('failed', errorMessage(error))
      throw error
    }
  }
}
