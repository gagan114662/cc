#!/usr/bin/env bun

import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type TestQualitySeverity = 'error' | 'warning'

export type TestQualityFinding = {
  filePath: string
  line: number
  ruleId:
    | 'self_assertion'
    | 'literal_tautology'
    | 'expected_aliases_actual'
    | 'fixture_answer_leakage'
    | 'computed_expected'
  severity: TestQualitySeverity
  message: string
  snippet: string
}

export type TestQualityReport = {
  repoRoot: string
  scannedFileCount: number
  errorCount: number
  warningCount: number
  findings: TestQualityFinding[]
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/
const FILE_SUPPRESSION_MARKER = 'test-quality:ignore-file'
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'archive',
])

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function normalizeLiteral(literal: string): string {
  return literal.replaceAll(/\s+/g, ' ').trim()
}

function addFinding(
  findings: TestQualityFinding[],
  filePath: string,
  line: number,
  ruleId: TestQualityFinding['ruleId'],
  severity: TestQualitySeverity,
  message: string,
  snippet: string,
): void {
  findings.push({
    filePath,
    line,
    ruleId,
    severity,
    message,
    snippet: snippet.trim().slice(0, 180),
  })
}

export function analyzeTestSource(
  filePath: string,
  source: string,
): TestQualityFinding[] {
  if (source.includes(FILE_SUPPRESSION_MARKER)) {
    return []
  }

  const findings: TestQualityFinding[] = []

  const selfAssertionRe =
    /expect\(\s*([A-Za-z_$][\w$.]*)\s*\)\.(?:toBe|toEqual|toStrictEqual|toContain)\(\s*\1\s*\)/g
  for (const match of source.matchAll(selfAssertionRe)) {
    addFinding(
      findings,
      filePath,
      lineNumberAt(source, match.index ?? 0),
      'self_assertion',
      'error',
      'The assertion compares a value to itself, so it cannot fail for the intended behavior.',
      match[0],
    )
  }

  const literalTautologyRe =
    /expect\(\s*(true|false|null|undefined|\d+|(["'`])(?:\\.|(?!\2).){1,80}\2)\s*\)\.(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/g
  for (const match of source.matchAll(literalTautologyRe)) {
    addFinding(
      findings,
      filePath,
      lineNumberAt(source, match.index ?? 0),
      'literal_tautology',
      'error',
      'The test asserts a literal against the same literal, which proves nothing about the code under test.',
      match[0],
    )
  }

  const expectedAliasRe =
    /(?:const|let)\s+expected\s*=\s*(actual|result|output|response)\b/g
  const actualVsExpectedRe =
    /expect\(\s*(actual|result|output|response)\s*\)\.(?:toBe|toEqual|toStrictEqual)\(\s*expected\s*\)/g
  const hasExpectedAlias = expectedAliasRe.test(source)
  const aliasAssertion = actualVsExpectedRe.exec(source)
  if (hasExpectedAlias && aliasAssertion) {
    addFinding(
      findings,
      filePath,
      lineNumberAt(source, aliasAssertion.index ?? 0),
      'expected_aliases_actual',
      'error',
      'The expected value is aliased from the produced result, which makes the assertion circular.',
      aliasAssertion[0],
    )
  }

  const computedExpectedRe =
    /(?:const|let)\s+expected\s*=\s*([A-Za-z_$][\w$.]*)\(/g
  const computedExpectationUsed =
    /expect\(\s*(?:actual|result|output|response|value)\s*\)\.(?:toBe|toEqual|toStrictEqual)\(\s*expected\s*\)/.test(
      source,
    )
  for (const match of source.matchAll(computedExpectedRe)) {
    if (!computedExpectationUsed) continue
    addFinding(
      findings,
      filePath,
      lineNumberAt(source, match.index ?? 0),
      'computed_expected',
      'warning',
      'The expected value is computed in the test. Double-check that it is not calling the same logic the test is supposed to verify.',
      match[0],
    )
  }

  const fixtureLiteralRe =
    /(?:const|let)\s+(?:input|prompt|source|content|fixture)[A-Za-z0-9_]*\s*=\s*(["'])([^"'\\\n]{6,120})\1/g
  for (const match of source.matchAll(fixtureLiteralRe)) {
    const rawLiteral = normalizeLiteral(match[2] ?? '')
    if (rawLiteral.length < 6) continue
    const escapedLiteral = rawLiteral.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const expectationRe = new RegExp(
      `expect\\([\\s\\S]{0,120}?\\)\\.(?:toBe|toEqual|toContain)\\(\\s*["']${escapedLiteral}["']\\s*\\)`,
      'g',
    )
    const expectationMatch = expectationRe.exec(source)
    if (!expectationMatch) continue
    addFinding(
      findings,
      filePath,
      lineNumberAt(source, expectationMatch.index ?? 0),
      'fixture_answer_leakage',
      'error',
      'The asserted answer is copied directly from the arranged fixture/input, which often means the test is checking memorization instead of behavior.',
      expectationMatch[0],
    )
  }

  return findings
}

async function walkTestFiles(rootDir: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const filePaths: string[] = []

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      filePaths.push(...(await walkTestFiles(rootDir, absolute)))
      continue
    }
    if (!TEST_FILE_RE.test(entry.name)) continue
    filePaths.push(path.relative(rootDir, absolute))
  }

  return filePaths.sort()
}

export async function runTestQualityCheck(
  repoRoot: string,
): Promise<TestQualityReport> {
  const testFiles = await walkTestFiles(repoRoot, path.join(repoRoot, 'test')).catch(
    () => [],
  )
  const testsDirFiles = await walkTestFiles(
    repoRoot,
    path.join(repoRoot, 'tests'),
  ).catch(() => [])
  const e2eFiles = await walkTestFiles(repoRoot, path.join(repoRoot, 'e2e')).catch(
    () => [],
  )

  const fileSet = new Set([...testFiles, ...testsDirFiles, ...e2eFiles])
  const findings: TestQualityFinding[] = []

  for (const relativePath of [...fileSet].sort()) {
    const absolutePath = path.join(repoRoot, relativePath)
    const source = await readFile(absolutePath, 'utf8')
    findings.push(...analyzeTestSource(relativePath, source))
  }

  const errorCount = findings.filter(f => f.severity === 'error').length
  const warningCount = findings.filter(f => f.severity === 'warning').length

  return {
    repoRoot,
    scannedFileCount: fileSet.size,
    errorCount,
    warningCount,
    findings,
  }
}

function renderText(report: TestQualityReport): string {
  const lines = [
    `Scanned ${report.scannedFileCount} test files`,
    `Errors: ${report.errorCount}`,
    `Warnings: ${report.warningCount}`,
  ]

  if (report.findings.length === 0) {
    lines.push('No suspicious AI-style test shortcuts detected.')
    return lines.join('\n')
  }

  lines.push('')
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase()} ${finding.ruleId} ${finding.filePath}:${finding.line}`,
    )
    lines.push(`  ${finding.message}`)
    lines.push(`  ${finding.snippet}`)
  }
  return lines.join('\n')
}

function renderHtml(report: TestQualityReport): string {
  const generatedAt = new Date().toISOString()
  const findingsMarkup =
    report.findings.length === 0
      ? '<p>No suspicious AI-style test shortcuts detected.</p>'
      : report.findings
          .map(
            finding => `
              <article class="finding ${finding.severity}">
                <h3>${escapeHtml(
                  `${finding.severity.toUpperCase()} ${finding.ruleId}`,
                )}</h3>
                <p><strong>${escapeHtml(finding.filePath)}:${finding.line}</strong></p>
                <p>${escapeHtml(finding.message)}</p>
                <pre><code>${escapeHtml(finding.snippet)}</code></pre>
              </article>`,
          )
          .join('\n')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Test Quality Proof</title>
    <style>
      :root {
        --bg: #fffaf0;
        --panel: #ffffff;
        --ink: #171717;
        --muted: #5f5f5f;
        --accent: #14532d;
        --error: #991b1b;
        --warning: #92400e;
        --border: #e7d9be;
      }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
        background: radial-gradient(circle at top, #fff7e2, var(--bg) 42%);
        color: var(--ink);
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 48px 20px 80px;
      }
      section, article {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 20px 24px;
        box-shadow: 0 20px 40px rgba(23, 23, 23, 0.06);
      }
      section + section, article + article {
        margin-top: 18px;
      }
      h1, h2, h3 {
        margin: 0 0 12px;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px;
      }
      .stat {
        padding: 16px;
        border-radius: 14px;
        background: #fffdf8;
        border: 1px solid var(--border);
      }
      .label {
        color: var(--muted);
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .value {
        font-size: 32px;
        font-weight: 700;
      }
      .finding.error h3 {
        color: var(--error);
      }
      .finding.warning h3 {
        color: var(--warning);
      }
      pre {
        overflow-x: auto;
        padding: 14px;
        border-radius: 12px;
        background: #fff8ef;
        border: 1px solid var(--border);
      }
      ul {
        margin: 0;
        padding-left: 18px;
      }
      p, li {
        line-height: 1.55;
      }
      .meta {
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <section id="overview">
        <p class="meta">Generated ${escapeHtml(generatedAt)}</p>
        <h1>AI Test Quality Proof</h1>
        <p>This report flags suspicious lazy-test patterns so agent-written tests have to prove behavior instead of memorizing answers.</p>
        <div class="stats">
          <div class="stat">
            <div class="label">Scanned Files</div>
            <div class="value">${report.scannedFileCount}</div>
          </div>
          <div class="stat">
            <div class="label">Errors</div>
            <div class="value">${report.errorCount}</div>
          </div>
          <div class="stat">
            <div class="label">Warnings</div>
            <div class="value">${report.warningCount}</div>
          </div>
        </div>
      </section>
      <section>
        <h2>Rules</h2>
        <ul>
          <li>Tests cannot compare a value to itself.</li>
          <li>Tests cannot assert a literal against the same literal.</li>
          <li>Expected values cannot be aliases of actual results.</li>
          <li>Fixture text cannot be copied straight into assertions as the answer.</li>
          <li>Computed expected values are warnings and should be reviewed carefully.</li>
        </ul>
      </section>
      <section>
        <h2>Findings</h2>
        ${findingsMarkup}
      </section>
    </main>
  </body>
</html>`
}

function parseArgs(argv: string[]): {
  htmlPath?: string
  json: boolean
  root: string
} {
  let htmlPath: string | undefined
  let json = false
  let root = process.cwd()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--html') {
      htmlPath = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--root') {
      root = path.resolve(argv[index + 1] ?? root)
      index += 1
    }
  }

  return { htmlPath, json, root }
}

if (import.meta.main) {
  const { htmlPath, json, root } = parseArgs(process.argv.slice(2))
  const report = await runTestQualityCheck(root)

  if (htmlPath) {
    const outputPath = path.resolve(root, htmlPath)
    await writeFile(outputPath, renderHtml(report), 'utf8')
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderText(report)}\n`)
  }

  process.exit(report.errorCount > 0 ? 1 : 0)
}
