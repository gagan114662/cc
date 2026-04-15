import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setIsRemoteMode } from 'src/bootstrap/state.js'
import { getSystemPrompt } from 'src/constants/prompts.js'
import { getSimplePrompt } from 'src/tools/BashTool/prompt.js'
import { shouldUseSandbox } from 'src/tools/BashTool/shouldUseSandbox.js'
import { getPrompt as getPowerShellPrompt } from 'src/tools/PowerShellTool/prompt.js'
import { initialPermissionModeFromCLI } from 'src/utils/permissions/permissionSetup.js'

const originalEnv = {
  CLAUDE_CODE_REMOTE: process.env.CLAUDE_CODE_REMOTE,
  CLAUDE_CODE_LOCAL_YOLO_ACTIVE: process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE,
}

beforeEach(() => {
  setIsRemoteMode(false)
  delete process.env.CLAUDE_CODE_REMOTE
  delete process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE
})

afterEach(() => {
  setIsRemoteMode(false)

  if (originalEnv.CLAUDE_CODE_REMOTE === undefined) {
    delete process.env.CLAUDE_CODE_REMOTE
  } else {
    process.env.CLAUDE_CODE_REMOTE = originalEnv.CLAUDE_CODE_REMOTE
  }

  if (originalEnv.CLAUDE_CODE_LOCAL_YOLO_ACTIVE === undefined) {
    delete process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE
  } else {
    process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE =
      originalEnv.CLAUDE_CODE_LOCAL_YOLO_ACTIVE
  }
})

describe('local YOLO mode', () => {
  test('defaults local runs to bypass permissions', () => {
    const result = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: undefined,
    })

    expect(result.mode).toBe('bypassPermissions')
    expect(process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE).toBe('1')
  })

  test('respects an explicit guarded mode and disables YOLO prompt state', () => {
    const result = initialPermissionModeFromCLI({
      permissionModeCli: 'default',
      dangerouslySkipPermissions: undefined,
    })

    expect(result.mode).toBe('default')
    expect(process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE).toBe('0')
  })

  test('turns sandboxing off in local YOLO mode', () => {
    process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE = '1'

    expect(shouldUseSandbox({ command: 'rm -rf build' })).toBe(false)
  })

  test('strips sandbox-first coaching from the bash prompt', () => {
    process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE = '1'

    const prompt = getSimplePrompt()

    expect(prompt).toContain('Local YOLO mode is active')
    expect(prompt).not.toContain('You should always default to running commands within the sandbox')
    expect(prompt).not.toContain('Read files: Use')
  })

  test('strips specialized-tool coaching from the PowerShell prompt', async () => {
    process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE = '1'

    const prompt = await getPowerShellPrompt()

    expect(prompt).toContain('Local YOLO mode is active')
    expect(prompt).not.toContain('DO NOT use it for file operations')
  })

  test('renders the default system prompt in YOLO mode without permission-mode coaching', async () => {
    process.env.CLAUDE_CODE_LOCAL_YOLO_ACTIVE = '1'

    const prompt = await getSystemPrompt([], 'claude-sonnet-4-6')
    const rendered = prompt.join('\n')

    expect(rendered).toContain('Local YOLO mode is active')
    expect(rendered).not.toContain('user-selected permission mode')
    expect(rendered).not.toContain('Do NOT use the Bash')
  })
})
