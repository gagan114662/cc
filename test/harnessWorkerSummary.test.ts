import { describe, expect, test } from 'bun:test'
import {
  deriveWorkerExecutionSummary,
  extractLastAgentNarrative,
  shouldBypassRemotePrimaryLeadSession,
  wasWorkerTranscriptInterrupted,
} from 'src/services/harness/runtime.js'
import type { JobSpec, QueuedHarnessJob } from 'src/services/harness/types.js'

describe('harness worker summary', () => {
  test('prefers the last agent narrative over runtime warnings', () => {
    const transcript = [
      '2026-04-19T14:43:28.562422Z  WARN codex_state::runtime: failed to open state db',
      'OpenAI Codex v0.111.0 (research preview)',
      'codex',
      'I am bootstrapping the workspace first, then I will inspect the existing PM/company artifacts.',
      'exec',
      '/bin/zsh -lc "bun run repo:bootstrap"',
      'codex',
      'I found the active pack path and I am drafting the customer operations playbook now.',
    ].join('\n')

    expect(extractLastAgentNarrative(transcript)).toBe(
      'I found the active pack path and I am drafting the customer operations playbook now.',
    )
    expect(
      deriveWorkerExecutionSummary({
        stdout: '',
        stderr: transcript,
        exitCode: 0,
      }),
    ).toBe(
      'I found the active pack path and I am drafting the customer operations playbook now.',
    )
  })

  test('marks interrupted transcripts explicitly', () => {
    const transcript = [
      'codex',
      'I found the report path and I am collecting the last missing data point.',
      'task interrupted',
    ].join('\n')

    expect(wasWorkerTranscriptInterrupted(transcript)).toBeTrue()
    expect(
      deriveWorkerExecutionSummary({
        stdout: '',
        stderr: transcript,
        exitCode: 0,
      }),
    ).toContain('task interrupted before completion')
  })

  test('keeps PM/company lead-session jobs on the local execution path', () => {
    const jobSpec = {
      id: 'pm-company-research',
    } as JobSpec
    const queuedJob = {
      instanceId: 'job-1',
      jobId: 'pm-company-research',
      metadata: {
        companyId: 'company-1',
      },
    } as QueuedHarnessJob

    expect(shouldBypassRemotePrimaryLeadSession(jobSpec, queuedJob)).toBeTrue()
  })
})
