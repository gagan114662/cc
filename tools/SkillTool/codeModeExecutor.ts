import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { Script, createContext } from 'node:vm'
import { getOriginalCwd, getSessionId, getSessionProjectDir } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import { commandBelongsToServer } from '../../services/mcp/utils.js'
import { getBrowserHarnessStatus, type BrowserHarnessStatus } from '../../utils/browserHarness.js'
import { getCapabilityFamily } from '../../utils/capabilityDiscovery.js'
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
  browser: CodeModeBrowserApi
  cli: CodeModeCliApi
  mcp: CodeModeMcpApi
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
  }
}

function looksBrowserBackedCapability(command: Command): boolean {
  const text = [
    command.name,
    command.description,
    command.whenToUse,
    ...(command.verbs ?? []),
    ...(command.outputs ?? []),
    ...(command.artifactKinds ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return (
    getCapabilityFamily(command) === 'browser' ||
    text.includes('browser') ||
    text.includes('funnel') ||
    text.includes('website')
  )
}

function buildCapabilitySnapshot(
  command: WorkflowCommand,
  context: ToolUseContext,
  commands: Command[],
  browserStatus: BrowserHarnessStatus,
): CodeModeCapabilitySnapshot {
  const commandMap = new Map(commands.map(item => [item.name, item]))
  for (const mcpCommand of context.getAppState().mcp.commands) {
    commandMap.set(mcpCommand.name, mcpCommand)
  }
  const allCommands = [...commandMap.values()]

  const browserWorkflows = allCommands.filter(
    item => item.type === 'prompt' && looksBrowserBackedCapability(item),
  )
  const mcpCommands = allCommands.filter(item => item.loadedFrom === 'mcp')
  const mcpWorkflows = mcpCommands.filter(item => item.kind === 'workflow')
  const mcpSkills = mcpCommands.filter(item => item.kind !== 'workflow')
  const allowedTools = [...(command.allowedTools ?? [])]
  const availableTools = context.options.tools.map(tool => ({
    name: tool.name,
    workflowAllowed: allowedTools.includes(tool.name),
    available: true,
  }))

  const mcpServers = context.getAppState().mcp.clients.map(client => {
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
      resourceCount: context.getAppState().mcp.resources[client.name]?.length ?? 0,
    }
  })

  return {
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
    private readonly capabilitySnapshot: CodeModeCapabilitySnapshot,
    readonly stateStore: CodeModeStateStore,
  ) {}

  static async create(args: CodeModeExecutorArgs): Promise<CodeModeExecutor> {
    const browserStatus = await getBrowserHarnessStatus()
    const capabilitySnapshot = buildCapabilitySnapshot(
      args.command,
      args.context,
      args.commands,
      browserStatus,
    )
    const stateStore = await CodeModeStateStore.create({
      path: getCodeModeStatePath(args.transcriptSubdir, args.statePath),
      command: args.command,
      argsText: args.argsText,
      transcriptSubdir: args.transcriptSubdir,
      capabilities: capabilitySnapshot,
    })

    return new CodeModeExecutor(args, capabilitySnapshot, stateStore)
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
        this.capabilitySnapshot.browser.workflows.map(workflow => ({
          ...workflow,
          verbs: [...workflow.verbs],
          outputs: [...workflow.outputs],
          artifactKinds: [...workflow.artifactKinds],
        })),
      hasWorkflow: name =>
        this.capabilitySnapshot.browser.workflows.some(
          workflow =>
            workflow.name === name || workflow.displayName === name,
        ),
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

    const api: CodeModeProgramApi = Object.freeze({
      args: this.args.argsText,
      state: stateApi,
      workflow: workflowApi,
      browser: browserApi,
      cli: cliApi,
      mcp: mcpApi,
      runStep: workflowApi.runStep,
      skipStep: workflowApi.skipStep,
      getHandoff: workflowApi.getHandoff,
      getOutcomes: workflowApi.getOutcomes,
      hasOutcome: workflowApi.hasOutcome,
    })

    try {
      await runProgramInSandbox(program, api)
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
