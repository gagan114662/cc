import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { classifyClaudeCodeSessionObservation } from '../../services/autoresearch/claudeCodeSessions.js'

if (process.env.CLAUDE_CODE_HARNESS_MODE === '1') {
  process.exit(0)
}

type BaseHookInput = {
  session_id?: string
  transcript_path?: string
  cwd?: string
  agent_id?: string
}

type SessionIndexEntry = {
  sessionId: string
  summary?: string
  firstPrompt?: string
  messageCount?: number
  projectPath?: string
}

type SessionEndInput = BaseHookInput & {
  reason?: string
}

type StopFailureInput = BaseHookInput & {
  error?: {
    message?: string
  }
  error_details?: string
  last_assistant_message?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

function parseInput<T>(raw: string): T {
  if (!raw) {
    return {} as T
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return {} as T
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function readProjectConfigCosts(
  sessionId: string,
): Promise<{ tokenCost?: number; runtimeMs?: number }> {
  const claudeConfigDir = getClaudeConfigHomeDir()
  const globalConfigPath = path.join(claudeConfigDir, 'config.json')

  try {
    const raw = await readFile(globalConfigPath, 'utf8')
    const config = JSON.parse(raw)
    if (!config.projects) return {}

    for (const projectConfig of Object.values(config.projects) as any[]) {
      if (projectConfig?.lastSessionId === sessionId) {
        return {
          tokenCost: projectConfig.lastCost ?? undefined,
          runtimeMs: projectConfig.lastDuration ?? undefined,
        }
      }
    }
  } catch {
    // Config not readable — cost data unavailable
  }
  return {}
}

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

function getClaudeConfigHomeDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')).normalize(
    'NFC',
  )
}

function defaultStatePath(projectDir: string): string {
  return path.join(
    getClaudeConfigHomeDir(),
    'autoresearch',
    createHash('sha256').update(projectDir).digest('hex').slice(0, 12),
  )
}

async function resolveStatePath(projectDir: string): Promise<string | null> {
  const settingsPath = path.join(projectDir, '.claude', 'settings.json')
  const settings = await readJsonFile<{
    autoresearch?: {
      enabled?: boolean
      experimentStatePath?: string
    }
  }>(settingsPath)

  if (!settings?.autoresearch?.enabled) {
    return null
  }

  if (settings.autoresearch.experimentStatePath) {
    return path.resolve(projectDir, settings.autoresearch.experimentStatePath)
  }

  return defaultStatePath(projectDir)
}

async function loadSessionIndexEntry(
  transcriptPath: string,
  sessionId: string,
): Promise<SessionIndexEntry | undefined> {
  const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json')
  const index = await readJsonFile<{ entries?: SessionIndexEntry[] }>(indexPath)
  return index?.entries?.find(entry => entry.sessionId === sessionId)
}

async function writeObservationFile(
  statePath: string,
  observation: ReturnType<typeof classifyClaudeCodeSessionObservation>,
): Promise<void> {
  const observationDir = path.join(
    statePath,
    'incoming',
    'claude-code-sessions',
  )
  await mkdir(observationDir, { recursive: true })
  await writeFile(
    path.join(observationDir, `${observation.id}.json`),
    `${JSON.stringify(observation, null, 2)}\n`,
    'utf8',
  )
}

async function handleSessionEnd(
  projectDir: string,
  input: SessionEndInput,
): Promise<void> {
  if (!input.session_id || !input.transcript_path || !input.cwd) {
    return
  }

  const statePath = await resolveStatePath(projectDir)
  if (!statePath) {
    return
  }

  const indexEntry = await loadSessionIndexEntry(
    input.transcript_path,
    input.session_id,
  )
  const costs = await readProjectConfigCosts(input.session_id)
  const toolCallCount = await countToolCallsFromTranscript(input.transcript_path)
  const observation = classifyClaudeCodeSessionObservation({
    sessionId: input.session_id,
    eventType: 'session_end',
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    exitReason: input.reason,
    summary: indexEntry?.summary ?? `Session ended with reason: ${input.reason ?? 'other'}`,
    firstPrompt: indexEntry?.firstPrompt,
    messageCount: indexEntry?.messageCount,
    projectPath: indexEntry?.projectPath,
    recordedAt: nowIso(),
    tokenCost: costs.tokenCost,
    runtimeMs: costs.runtimeMs,
    toolCallCount,
  })
  await writeObservationFile(statePath, observation)
}

async function handleStopFailure(
  projectDir: string,
  input: StopFailureInput,
): Promise<void> {
  if (!input.session_id || !input.transcript_path || !input.cwd) {
    return
  }

  const statePath = await resolveStatePath(projectDir)
  if (!statePath) {
    return
  }

  const errorDetails = [
    input.error?.message,
    input.error_details,
    input.last_assistant_message,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()

  const observation = classifyClaudeCodeSessionObservation({
    sessionId: input.session_id,
    eventType: 'stop_failure',
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    summary: errorDetails || 'Claude Code stop failure.',
    lastAssistantMessage: input.last_assistant_message,
    errorDetails,
    recordedAt: nowIso(),
  })
  await writeObservationFile(statePath, observation)
}

async function main(): Promise<void> {
  const eventName = process.argv[2] ?? ''
  const projectDir = path.resolve(
    process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  )
  const rawInput = await readStdin()

  if (!rawInput) {
    return
  }

  if (eventName === 'SessionEnd') {
    const input = parseInput<SessionEndInput>(rawInput)
    if (input.agent_id) {
      return
    }
    await handleSessionEnd(projectDir, input)
    return
  }

  if (eventName === 'StopFailure') {
    const input = parseInput<StopFailureInput>(rawInput)
    if (input.agent_id) {
      return
    }
    await handleStopFailure(projectDir, input)
  }
}

await main()
