// test-quality:ignore-file
import { describe, expect, test } from 'bun:test'
import { analyzeTestSource } from '../scripts/testQualityCheck.js'

describe('testQualityCheck', () => {
  test('flags self assertions and tautologies', () => {
    const findings = analyzeTestSource(
      'test/example.test.ts',
      `
        test('bad', () => {
          const result = 1
          expect(result).toBe(result)
          expect(true).toBe(true)
        })
      `,
    )

    expect(findings.some(f => f.ruleId === 'self_assertion')).toBe(true)
    expect(findings.some(f => f.ruleId === 'literal_tautology')).toBe(true)
  })

  test('flags answer leakage from fixtures into assertions', () => {
    const findings = analyzeTestSource(
      'test/leak.test.ts',
      `
        test('leaks answer', () => {
          const input = 'expected answer'
          const result = render(input)
          expect(result).toContain('expected answer')
        })
      `,
    )

    expect(findings.some(f => f.ruleId === 'fixture_answer_leakage')).toBe(
      true,
    )
  })

  test('flags circular expected aliases', () => {
    const findings = analyzeTestSource(
      'test/circular.test.ts',
      `
        test('circular', () => {
          const actual = runThing()
          const expected = actual
          expect(actual).toEqual(expected)
        })
      `,
    )

    expect(findings.some(f => f.ruleId === 'expected_aliases_actual')).toBe(
      true,
    )
  })

  test('allows ordinary behavior checks', () => {
    const findings = analyzeTestSource(
      'test/good.test.ts',
      `
        test('normalizes spacing', () => {
          const result = normalizeWhitespace('a   b')
          expect(result).toBe('a b')
        })
      `,
    )

    expect(findings).toHaveLength(0)
  })
})
