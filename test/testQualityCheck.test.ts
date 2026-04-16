// test-quality:ignore-file reason=self-test for the checker
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  analyzeTestSource,
  parseTestQualityArgs,
  renderTestQualityHtml,
  renderTestQualityText,
  runTestQualityCheck,
} from '../scripts/testQualityCheck.js'

function runGit(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  }
  return result.stdout
}

describe('testQualityCheck', () => {
  test('flags self assertions, tautologies, and expected aliases', () => {
    const findings = analyzeTestSource(
      'test/example.test.ts',
      `
        test('bad', () => {
          const result = runThing()
          const actual = result
          const expected = actual
          expect(actual).toBe(expected)
          expect(true).toBe(true)
        })
      `,
    )

    expect(findings.some(f => f.ruleId === 'expected_aliases_actual')).toBe(true)
    expect(findings.some(f => f.ruleId === 'literal_tautology')).toBe(true)
  })

  test('flags answer leakage from fixtures into assertions through aliases', () => {
    const findings = analyzeTestSource(
      'test/leak.test.ts',
      `
        test('leaks answer', () => {
          const prompt = 'expected answer'
          const leaked = \`\${prompt}\`
          const result = render(prompt)
          expect(result).toContain(leaked)
        })
      `,
    )

    expect(findings.some(f => f.ruleId === 'fixture_answer_leakage')).toBe(
      true,
    )
  })

  test('flags snapshot only assertions', () => {
    const findings = analyzeTestSource(
      'test/snapshot-only.test.ts',
      `
        test('snapshot only', () => {
          const result = renderThing()
          expect(result).toMatchSnapshot()
        })
      `,
    )

    expect(findings.some(f => f.ruleId === 'snapshot_only_assertion')).toBe(
      true,
    )
  })

  test('flags oracle calls produced by the same callable', () => {
    const findings = analyzeTestSource(
      'test/circular-call.test.ts',
      `
        test('circular oracle', () => {
          const actual = normalizeWhitespace('a   b')
          const expected = normalizeWhitespace('a   b')
          expect(actual).toEqual(expected)
        })
      `,
    )

    expect(findings.some(f => f.ruleId === 'computed_expected')).toBe(true)
  })

  test('flags missing negative coverage in changed single-case files', () => {
    const findings = analyzeTestSource(
      'test/happy-path-only.test.ts',
      `
        // test-intent: proves whitespace normalization for valid input without relying on implementation details.
        // test-spec: specs/normalization.md#whitespace-normalization
        test('normalizes spacing', () => {
          const result = normalizeWhitespace('a   b')
          expect(result).toBe('a b')
        })
      `,
      { changedTestFile: true, requireSpecTraceForChangedTests: false },
    )

    expect(findings.some(f => f.ruleId === 'missing_negative_case')).toBe(
      true,
    )
  })

  test('flags suppression comments without reasons', () => {
    const findings = analyzeTestSource(
      'test/ignored.test.ts',
      `// test-quality:ignore-file
       test('ignored', () => {
         expect(true).toBe(true)
       })
      `,
    )

    expect(findings.some(f => f.ruleId === 'suppression_missing_reason')).toBe(
      true,
    )
  })

  test('allows ordinary behavior checks with neighboring cases', () => {
    const findings = analyzeTestSource(
      'test/good.test.ts',
      `
        // test-intent: proves whitespace normalization changes visible output and rejects empty input.
        // test-spec: specs/normalization.md#whitespace-normalization
        test('normalizes spacing', () => {
          const result = normalizeWhitespace('a   b')
          expect(result).toBe('a b')
        })

        test('throws on empty input', () => {
          expect(() => normalizeWhitespace('')).toThrow('empty')
        })
      `,
      { changedTestFile: true, requireSpecTraceForChangedTests: false },
    )

    expect(findings).toHaveLength(0)
  })

  test('flags changed test files that do not declare intent', () => {
    const findings = analyzeTestSource(
      'test/missing-intent.test.ts',
      `
        // test-spec: specs/normalization.md#whitespace-normalization
        test('rejects empty input', () => {
          expect(() => normalizeWhitespace('')).toThrow('empty')
        })
      `,
      {
        changedTestFile: true,
        requireSpecTraceForChangedTests: false,
      },
    )

    expect(findings.some(f => f.ruleId === 'missing_intent_trace')).toBe(true)
  })

  test('flags changed test files that do not declare a spec reference', () => {
    const findings = analyzeTestSource(
      'test/missing-spec.test.ts',
      `
        // test-intent: proves empty input is rejected.
        test('rejects empty input', () => {
          expect(() => normalizeWhitespace('')).toThrow('empty')
        })
      `,
      {
        changedTestFile: true,
        requireIntentTraceForChangedTests: true,
      },
    )

    expect(findings.some(f => f.ruleId === 'missing_spec_trace')).toBe(true)
  })

  test('flags changed test files whose spec reference does not resolve', () => {
    const findings = analyzeTestSource(
      'test/invalid-spec.test.ts',
      `
        // test-intent: proves empty input is rejected.
        // test-spec: specs/normalization.md#whitespace-normalization
        test('rejects empty input', () => {
          expect(() => normalizeWhitespace('')).toThrow('empty')
        })
      `,
      {
        changedTestFile: true,
        repoRoot: '/definitely/missing',
      },
    )

    expect(findings.some(f => f.ruleId === 'invalid_spec_trace')).toBe(true)
  })

  test('deduplicates repeated findings and honors suppressions with reasons', () => {
    const deduped = analyzeTestSource(
      'test/deduped.test.ts',
      `
        // test-quality:ignore-file reason=fixture for checker self-test
        test('dedupe', () => {
          expect(true).toBe(true)
          expect(true).toBe(true)
        })
      `,
    )

    expect(deduped).toHaveLength(0)
  })

  test('treats uncommitted local test files as changed when enforcing negative cases', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'test-quality-git-'))
    await mkdir(path.join(repoRoot, 'test'), { recursive: true })
    await mkdir(path.join(repoRoot, 'specs'), { recursive: true })
    await writeFile(
      path.join(repoRoot, 'test', 'baseline.test.ts'),
      `
        test('baseline', () => {
          expect(1).toBe(1)
        })
      `,
      'utf8',
    )
    await writeFile(
      path.join(repoRoot, 'specs', 'normalization.md'),
      '# Whitespace Normalization\n\n## whitespace-normalization\n',
      'utf8',
    )

    try {
      runGit(repoRoot, ['init', '-b', 'main'])
      runGit(repoRoot, ['config', 'user.email', 'test-quality@example.com'])
      runGit(repoRoot, ['config', 'user.name', 'Test Quality'])
      runGit(repoRoot, ['add', '.'])
      runGit(repoRoot, ['commit', '-m', 'initial'])

      await writeFile(
        path.join(repoRoot, 'test', 'local-only.test.ts'),
        `
          // test-intent: proves whitespace normalization changes user-visible output for simple input.
          // test-spec: specs/normalization.md#whitespace-normalization
          test('happy path only', () => {
            const result = normalizeWhitespace('a   b')
            expect(result).toBe('a b')
          })
        `,
        'utf8',
      )

      const report = await runTestQualityCheck(repoRoot)

      expect(
        report.findings.some(f => f.ruleId === 'missing_negative_case' && f.filePath === 'test/local-only.test.ts'),
      ).toBe(true)
    } finally {
      await rm(repoRoot, { force: true, recursive: true })
    }
  })

  test('cli emits html and json output for findings', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'test-quality-cli-'))
    await mkdir(path.join(repoRoot, 'test'), { recursive: true })
    await mkdir(path.join(repoRoot, 'specs'), { recursive: true })
    await writeFile(
      path.join(repoRoot, 'test', 'bad.test.ts'),
      `
        // test-intent: proves the rendered output should preserve semantic structure in snapshots.
        // test-spec: specs/rendering.md#snapshot-behavior
        test('snapshot only', () => {
          const result = renderThing()
          expect(result).toMatchSnapshot()
        })
      `,
      'utf8',
    )
    await writeFile(
      path.join(repoRoot, 'specs', 'rendering.md'),
      '# Rendering\n\n## snapshot-behavior\n',
      'utf8',
    )
    const htmlPath = path.join(repoRoot, 'quality.html')

    try {
      const result = spawnSync(
        'bun',
        [
          path.join(process.cwd(), 'scripts/testQualityCheck.ts'),
          '--root',
          repoRoot,
          '--json',
          '--html',
          htmlPath,
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        },
      )

      expect(result.status).toBe(1)
      expect(result.stdout.includes('snapshot_only_assertion')).toBe(true)
      const html = await Bun.file(htmlPath).text()
      expect(html.includes('AI Test Quality Proof')).toBe(true)
      expect(html.includes('Snapshot-only tests must include semantic assertions.')).toBe(
        true,
      )
    } finally {
      await rm(repoRoot, { force: true, recursive: true })
    }
  })

  test('renders text and html reports and parses cli args', () => {
    const report = {
      repoRoot: '/repo',
      scannedFileCount: 1,
      errorCount: 1,
      warningCount: 0,
      findings: [
        {
          filePath: 'test/example.test.tsx',
          line: 4,
          ruleId: 'snapshot_only_assertion' as const,
          severity: 'error' as const,
          message: 'Snapshot-only tests are weak.',
          snippet: 'expect(view).toMatchSnapshot()',
        },
      ],
    }

    const text = renderTestQualityText(report)
    const html = renderTestQualityHtml(report)
    const args = parseTestQualityArgs([
      '--root',
      '/repo',
      '--json',
      '--html',
      './quality.html',
    ])

    expect(text.includes('ERROR snapshot_only_assertion')).toBe(true)
    expect(html.includes('AI Test Quality Proof')).toBe(true)
    expect(html.includes('declare their user-visible intent')).toBe(true)
    expect(html.includes('Changed test files need a neighboring or negative case.')).toBe(
      true,
    )
    expect(args).toEqual({
      root: '/repo',
      json: true,
      htmlPath: './quality.html',
    })
  })

  test('handles tsx parsing and deep alias chains without crashing', () => {
    const findings = analyzeTestSource(
      'test/view.test.tsx',
      `
        // test-intent: proves rendered view structure for aliased JSX input in a changed test file.
        // test-spec: specs/rendering.md#aliased-jsx
        const name = "example"
        const alias0 = name
        const alias1 = alias0
        const alias2 = alias1
        const alias3 = alias2
        const alias4 = alias3
        const alias5 = alias4
        const alias6 = alias5
        const alias7 = alias6
        const alias8 = alias7
        const alias9 = alias8

        test.only('bad tsx case', () => {
          const view = <div>{alias9}</div>
          expect(view).toMatchSnapshot()
        })
      `,
      {
        changedTestFile: true,
        requireSpecTraceForChangedTests: false,
      },
    )

    expect(findings.some(f => f.ruleId === 'snapshot_only_assertion')).toBe(
      true,
    )
  })

  test('walks property access expectations and non-literal test names safely', () => {
    const findings = analyzeTestSource(
      'test/edge-cases.test.ts',
      `
        const dynamicName = 'dynamic'
        test(dynamicName, () => {
          expect(true).not.toBe(false)
          expect().toBe(undefined)
          customExpect(value).toBe(null)
        })
      `,
    )

    expect(findings).toHaveLength(0)
  })
})
