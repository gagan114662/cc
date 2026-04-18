import { afterEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { buildHarnessCommandEnv } from 'src/services/harness/shell.js'

const ORIGINAL_PATH = process.env.PATH
const ORIGINAL_BUN_INSTALL = process.env.BUN_INSTALL

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH
  process.env.BUN_INSTALL = ORIGINAL_BUN_INSTALL
})

describe('buildHarnessCommandEnv', () => {
  test('preserves the base path and injects Bun locations for child commands', () => {
    process.env.PATH = '/usr/bin:/bin'
    process.env.BUN_INSTALL = '/tmp/custom-bun'

    const env = buildHarnessCommandEnv({
      CLAUDE_CODE_HARNESS_JOB_ID: 'job-123',
    })

    expect(env.CLAUDE_CODE_HARNESS_JOB_ID).toBe('job-123')
    expect(env.PATH?.split(path.delimiter)).toContain('/tmp/custom-bun/bin')
    expect(env.PATH?.split(path.delimiter)).toContain(path.dirname(process.execPath))
    expect(env.PATH?.split(path.delimiter)).toContain('/usr/bin')
  })
})
