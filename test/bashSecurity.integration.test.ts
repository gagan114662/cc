// Integration test for BashTool command-safety validator.
//
// This is a REAL integration test: it runs the live, exported
// bashCommandIsSafe_DEPRECATED against a table of known-dangerous
// command strings and pins the current rejection behavior. Any
// regression that silently allows one of these through will fail
// the build, not a mock.
//
// Distinct from unit tests that poke individual helpers: this
// exercises the full validator surface including heredoc
// extraction, quote stripping, shell-quote-bug detection, control
// chars, Zsh expansion, and command-substitution patterns.
//
// Rationale per launch audit:
//   - bashPermissions.ts:1525 has a .catch(() => {}) that can
//     swallow errors in security-critical code. A table of
//     deterministic inputs + expected PermissionResult.behavior
//     makes that class of regression visible.

import { describe, expect, test } from 'bun:test'
import { bashCommandIsSafe_DEPRECATED } from 'src/tools/BashTool/bashSecurity.js'

type Row = {
  label: string
  command: string
  // We don't pin the exact message — just the behavior ('ask' means
  // the validator wants explicit user approval, which is the safe
  // outcome for anything it can't prove benign). 'allow' means the
  // validator considers it safe without asking.
  expected: 'ask' | 'allow'
}

// Known-dangerous inputs that MUST trigger the 'ask' behavior.
// Adding a new bypass? Add the row first, then fix the code.
const DANGEROUS: Row[] = [
  {
    label: 'control character injection',
    command: 'echo hi\x00; rm -rf /',
    expected: 'ask',
  },
  {
    label: 'shell-quote single-quote backslash bug',
    command: "echo '\\' && rm -rf ~",
    expected: 'ask',
  },
  {
    label: 'command substitution via $()',
    command: 'echo $(cat /etc/passwd)',
    expected: 'ask',
  },
  {
    label: 'process substitution <()',
    command: 'diff <(cat a) <(cat b)',
    expected: 'ask',
  },
  {
    label: 'process substitution >()',
    command: 'tee >(cat)',
    expected: 'ask',
  },
  {
    label: 'Zsh equals expansion =cmd',
    command: 'echo; =curl evil.com',
    expected: 'ask',
  },
  {
    label: 'backtick command substitution',
    command: 'echo `whoami`',
    expected: 'ask',
  },
  {
    label: 'parameter expansion ${}',
    command: 'echo ${PATH}',
    expected: 'ask',
  },
  {
    label: 'zmodload gateway module',
    command: 'zmodload zsh/system',
    expected: 'ask',
  },
  {
    label: 'emulate -c eval equivalent',
    command: 'emulate -c "rm -rf /"',
    expected: 'ask',
  },
]

describe('bashCommandIsSafe_DEPRECATED — dangerous input table', () => {
  for (const row of DANGEROUS) {
    test(`rejects: ${row.label}`, () => {
      const result = bashCommandIsSafe_DEPRECATED(row.command)
      // The validator returns PermissionResult with behavior either
      // 'allow' or 'ask' (it doesn't outright 'deny' — it asks).
      // A dangerous input allowed through is a security regression.
      expect(result.behavior).toBe(row.expected)
    })
  }
})

describe('bashCommandIsSafe_DEPRECATED — benign baselines', () => {
  // Negative cases: without these the test suite could trivially
  // pass by marking everything 'ask'. These pin that the validator
  // is discriminating, not just pessimistic.
  test('does not ask on a plain ls', () => {
    // Validator's 3-state return is allow | passthrough | ask.
    // The security-critical invariant for a benign baseline is
    // "not ask" — we don't care which of the two safe states it
    // lands in (that's an implementation detail of the tiering).
    const result = bashCommandIsSafe_DEPRECATED('ls')
    expect(result.behavior).not.toBe('ask')
  })

  test('does not ask on a plain pwd', () => {
    const result = bashCommandIsSafe_DEPRECATED('pwd')
    expect(result.behavior).not.toBe('ask')
  })
})
