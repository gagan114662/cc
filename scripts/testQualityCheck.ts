#!/usr/bin/env bun

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { loadBuildTrustPolicy } from 'src/services/buildTrust/policy.js'

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
    | 'snapshot_only_assertion'
    | 'missing_negative_case'
    | 'missing_intent_trace'
    | 'missing_spec_trace'
    | 'invalid_spec_trace'
    | 'suppression_missing_reason'
    | 'environment_failure'
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

type AnalyzeOptions = {
  changedTestFile?: boolean
  requireIntentTraceForChangedTests?: boolean
  requireSpecTraceForChangedTests?: boolean
  repoRoot?: string
}

type TestCaseSummary = {
  name: string
  semanticExpectCount: number
  snapshotNodes: ts.CallExpression[]
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/
const FILE_SUPPRESSION_MARKER = 'test-quality:ignore-file'
const TEST_INTENT_MARKER = 'test-intent:'
const TEST_SPEC_MARKER = 'test-spec:'
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'archive',
])
const EQUALITY_MATCHERS = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toContain',
  'toContainEqual',
  'toMatch',
])
const SNAPSHOT_MATCHERS = new Set([
  'toMatchSnapshot',
  'toMatchInlineSnapshot',
  'toThrowErrorMatchingSnapshot',
  'toThrowErrorMatchingInlineSnapshot',
])
const NEGATIVE_TEST_NAME_RE =
  /\b(error|fail|throws?|reject|invalid|missing|without|empty|bad|block|den(?:y|ied)|negative)\b/i
const FIXTURE_NAME_RE = /(?:input|prompt|source|content|fixture)/i
const UNRESOLVED_LITERAL = Symbol('unresolved')

function lineNumberAt(sourceFile: ts.SourceFile, index: number): number {
  return sourceFile.getLineAndCharacterOfPosition(index).line + 1
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function normalizeText(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim()
}

function createDedupKey(finding: TestQualityFinding): string {
  return `${finding.filePath}:${finding.line}:${finding.ruleId}:${finding.snippet}`
}

function addFinding(
  findings: TestQualityFinding[],
  seen: Set<string>,
  sourceFile: ts.SourceFile,
  filePath: string,
  node: ts.Node,
  ruleId: TestQualityFinding['ruleId'],
  severity: TestQualitySeverity,
  message: string,
  snippet?: string,
): void {
  const finding: TestQualityFinding = {
    filePath,
    line: lineNumberAt(sourceFile, node.getStart(sourceFile)),
    ruleId,
    severity,
    message,
    snippet: normalizeText(snippet ?? node.getText(sourceFile)).slice(0, 220),
  }
  const key = createDedupKey(finding)
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  findings.push(finding)
}

function findIntentTrace(source: string): string | null {
  const lineCommentMatch = source.match(/^\s*\/\/\s*test-intent:\s*(.+)$/m)
  if (lineCommentMatch?.[1]) {
    return normalizeText(lineCommentMatch[1])
  }

  const blockCommentMatch = source.match(/\/\*\s*test-intent:\s*([\s\S]*?)\*\//m)
  if (blockCommentMatch?.[1]) {
    return normalizeText(blockCommentMatch[1])
  }

  return null
}

function findSpecTrace(source: string): string | null {
  const lineCommentMatch = source.match(/^\s*\/\/\s*test-spec:\s*(.+)$/m)
  if (lineCommentMatch?.[1]) {
    return normalizeText(lineCommentMatch[1])
  }

  const blockCommentMatch = source.match(/\/\*\s*test-spec:\s*([\s\S]*?)\*\//m)
  if (blockCommentMatch?.[1]) {
    return normalizeText(blockCommentMatch[1])
  }

  return null
}

function resolveSpecTrace(
  specTrace: string,
): { targetPath: string; anchor: string } | null {
  const hashIndex = specTrace.indexOf('#')
  if (hashIndex <= 0 || hashIndex === specTrace.length - 1) {
    return null
  }
  return {
    targetPath: specTrace.slice(0, hashIndex).trim(),
    anchor: specTrace.slice(hashIndex + 1).trim(),
  }
}

function parseSourceFile(filePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function resolveAliasExpression(
  expression: ts.Expression,
  env: Map<string, ts.Expression>,
  depth: number = 0,
): ts.Expression {
  if (depth > 8) {
    return expression
  }
  if (ts.isIdentifier(expression)) {
    const next = env.get(expression.text)
    if (next) {
      return resolveAliasExpression(next, env, depth + 1)
    }
  }
  return expression
}

function resolveExpressionText(
  expression: ts.Expression,
  env: Map<string, ts.Expression>,
): string {
  return normalizeText(resolveAliasExpression(expression, env).getText())
}

function resolveLiteralValue(
  expression: ts.Expression,
  env: Map<string, ts.Expression>,
  depth: number = 0,
): string | number | boolean | null | undefined | symbol {
  if (depth > 8) {
    return UNRESOLVED_LITERAL
  }
  const resolved = resolveAliasExpression(expression, env, depth)
  if (
    ts.isStringLiteralLike(resolved) ||
    ts.isNoSubstitutionTemplateLiteral(resolved)
  ) {
    return resolved.text
  }
  if (ts.isNumericLiteral(resolved)) {
    return Number(resolved.text)
  }
  if (resolved.kind === ts.SyntaxKind.TrueKeyword) {
    return true
  }
  if (resolved.kind === ts.SyntaxKind.FalseKeyword) {
    return false
  }
  if (resolved.kind === ts.SyntaxKind.NullKeyword) {
    return null
  }
  if (
    ts.isIdentifier(resolved) &&
    resolved.text === 'undefined'
  ) {
    return undefined
  }
  if (ts.isTemplateExpression(resolved)) {
    let value = resolved.head.text
    for (const span of resolved.templateSpans) {
      const spanValue = resolveLiteralValue(span.expression, env, depth + 1)
      if (typeof spanValue !== 'string' && typeof spanValue !== 'number') {
        return UNRESOLVED_LITERAL
      }
      value += String(spanValue)
      value += span.literal.text
    }
    return value
  }
  return UNRESOLVED_LITERAL
}

function getCallIdentity(
  expression: ts.Expression,
  env: Map<string, ts.Expression>,
): string | null {
  const resolved = resolveAliasExpression(expression, env)
  if (!ts.isCallExpression(resolved)) {
    return null
  }
  return normalizeText(resolved.expression.getText())
}

function getExpectation(
  node: ts.CallExpression,
): {
  actual: ts.Expression
  matcher: string
  arg: ts.Expression | undefined
} | null {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return null
  }
  const matcher = node.expression.name.text
  let cursor: ts.Expression = node.expression.expression
  while (ts.isPropertyAccessExpression(cursor)) {
    cursor = cursor.expression
  }
  if (
    !ts.isCallExpression(cursor) ||
    !ts.isIdentifier(cursor.expression) ||
    cursor.expression.text !== 'expect'
  ) {
    return null
  }
  const actual = cursor.arguments[0]
  if (!actual) {
    return null
  }
  return {
    actual,
    matcher,
    arg: node.arguments[0],
  }
}

function getTestName(node: ts.CallExpression): string | null {
  const callee = node.expression
  let calleeName: string | null = null
  if (ts.isIdentifier(callee)) {
    calleeName = callee.text
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    calleeName = callee.expression.text
  }
  if (calleeName !== 'test' && calleeName !== 'it') {
    return null
  }
  const firstArg = node.arguments[0]
  if (!firstArg || !ts.isStringLiteralLike(firstArg)) {
    return null
  }
  return firstArg.text
}

function collectChangedTestFiles(repoRoot: string): Set<string> {
  const candidates = ['origin/main', 'main']
  let baseRef: string | null = null
  for (const candidate of candidates) {
    const result = spawnSync('git', ['rev-parse', '--verify', candidate], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    if (result.status === 0) {
      baseRef = candidate
      break
    }
  }

  const baseDiffOutput =
    baseRef !== null
      ? spawnSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
          cwd: repoRoot,
          encoding: 'utf8',
        }).stdout
      : ''
  const statusOutput = spawnSync('git', ['status', '--short'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout

  return new Set(
    [...baseDiffOutput.split('\n'), ...statusOutput.split('\n')]
      .map(line => line.trimEnd())
      .filter(Boolean)
      .map(line => {
        const statusPath = line.replace(/^[A-Z?]+\s+/, '')
        const normalized = statusPath.includes(' -> ')
          ? statusPath.split(' -> ').at(-1) ?? statusPath
          : statusPath
        return normalized.trim()
      })
      .filter(line => TEST_FILE_RE.test(line)),
  )
}

function analyzeTestBlock(
  filePath: string,
  sourceFile: ts.SourceFile,
  callback: ts.FunctionLikeDeclaration,
  findings: TestQualityFinding[],
  seen: Set<string>,
  testCase: TestCaseSummary,
  inheritedEnv: Map<string, ts.Expression>,
): void {
  const env = new Map(inheritedEnv)
  const fixtureValues = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      env.set(node.name.text, node.initializer)
      const literalValue = resolveLiteralValue(node.initializer, env)
      if (
        FIXTURE_NAME_RE.test(node.name.text) &&
        typeof literalValue === 'string' &&
        literalValue.length >= 6
      ) {
        fixtureValues.add(normalizeText(literalValue))
      }
    }

    if (ts.isCallExpression(node)) {
      const expectation = getExpectation(node)
      if (expectation) {
        const { actual, matcher, arg } = expectation
        if (SNAPSHOT_MATCHERS.has(matcher)) {
          testCase.snapshotNodes.push(node)
        } else {
          testCase.semanticExpectCount += 1
        }

        if (!arg) {
          ts.forEachChild(node, visit)
          return
        }

        const actualText = resolveExpressionText(actual, env)
        const argText = resolveExpressionText(arg, env)
        const actualLiteral = resolveLiteralValue(actual, env)
        const argLiteral = resolveLiteralValue(arg, env)

        if (EQUALITY_MATCHERS.has(matcher)) {
          if (
            actualLiteral !== UNRESOLVED_LITERAL &&
            argLiteral !== UNRESOLVED_LITERAL &&
            typeof actualLiteral !== 'symbol' &&
            typeof argLiteral !== 'symbol' &&
            actualLiteral === argLiteral
          ) {
            addFinding(
              findings,
              seen,
              sourceFile,
              filePath,
              node,
              'literal_tautology',
              'error',
              'The test asserts the same literal value on both sides, which proves nothing about behavior.',
            )
          } else if (actualText === argText) {
            const argIsExpectedIdentifier =
              ts.isIdentifier(arg) && arg.text === 'expected'
            addFinding(
              findings,
              seen,
              sourceFile,
              filePath,
              node,
              argIsExpectedIdentifier
                ? 'expected_aliases_actual'
                : 'self_assertion',
              'error',
              argIsExpectedIdentifier
                ? 'The expected value resolves to the produced value, so the assertion is circular.'
                : 'The assertion compares a value to itself after alias resolution, so it cannot verify real behavior.',
            )
          }

          const actualCallIdentity = getCallIdentity(actual, env)
          const expectedCallIdentity = getCallIdentity(arg, env)
          if (
            actualCallIdentity &&
            expectedCallIdentity &&
            actualCallIdentity === expectedCallIdentity
          ) {
            addFinding(
              findings,
              seen,
              sourceFile,
              filePath,
              node,
              'computed_expected',
              'error',
              'The expected value is produced by the same callable as the actual value, which makes the oracle circular.',
            )
          }

          if (
            typeof argLiteral === 'string' &&
            fixtureValues.has(normalizeText(argLiteral))
          ) {
            addFinding(
              findings,
              seen,
              sourceFile,
              filePath,
              node,
              'fixture_answer_leakage',
              'error',
              'The asserted answer is copied from arranged fixture/input content instead of being independently derived.',
            )
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  if (callback.body) {
    ts.forEachChild(callback.body, visit)
  }
}

export function analyzeTestSource(
  filePath: string,
  source: string,
  options: AnalyzeOptions = {},
): TestQualityFinding[] {
  const suppressionMatch = source.match(
    /test-quality:ignore-file(?:\s+reason=([^\n]+))?/,
  )
  if (suppressionMatch) {
    if (suppressionMatch[1]?.trim()) {
      return []
    }
    const sourceFile = parseSourceFile(filePath, source)
    return [
      {
        filePath,
        line: lineNumberAt(sourceFile, suppressionMatch.index ?? 0),
        ruleId: 'suppression_missing_reason',
        severity: 'error',
        message:
          'File-level test-quality suppressions must include a reason, for example: test-quality:ignore-file reason=fixture for checker self-test.',
        snippet: FILE_SUPPRESSION_MARKER,
      },
    ]
  }

  const sourceFile = parseSourceFile(filePath, source)
  const findings: TestQualityFinding[] = []
  const seen = new Set<string>()
  const fileEnv = new Map<string, ts.Expression>()
  const tests: TestCaseSummary[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      fileEnv.set(node.name.text, node.initializer)
    }

    if (ts.isCallExpression(node)) {
      const testName = getTestName(node)
      const callback = node.arguments[1]
      if (
        testName &&
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        const testCase: TestCaseSummary = {
          name: testName,
          semanticExpectCount: 0,
          snapshotNodes: [],
        }
        analyzeTestBlock(
          filePath,
          sourceFile,
          callback,
          findings,
          seen,
          testCase,
          fileEnv,
        )
        if (testCase.snapshotNodes.length > 0 && testCase.semanticExpectCount === 0) {
          addFinding(
            findings,
            seen,
            sourceFile,
            filePath,
            testCase.snapshotNodes[0]!,
            'snapshot_only_assertion',
            'error',
            'Snapshot-only assertions are too easy to overfit. Add at least one semantic assertion for behavior.',
          )
        }
        tests.push(testCase)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  if (
    options.changedTestFile &&
    options.requireIntentTraceForChangedTests !== false &&
    tests.length > 0 &&
    !findIntentTrace(source)
  ) {
    addFinding(
      findings,
      seen,
      sourceFile,
      filePath,
      sourceFile,
      'missing_intent_trace',
      'error',
      'Changed test files must declare the behavior they prove with a file-level comment like: test-intent: proves <user-visible rule>.',
      TEST_INTENT_MARKER,
    )
  }

  if (
    options.changedTestFile &&
    options.requireSpecTraceForChangedTests !== false &&
    tests.length > 0
  ) {
    const specTrace = findSpecTrace(source)
    if (!specTrace) {
      addFinding(
        findings,
        seen,
        sourceFile,
        filePath,
        sourceFile,
        'missing_spec_trace',
        'error',
        'Changed test files must reference a real feature spec with a file-level comment like: test-spec: specs/feature.md#section-id.',
        TEST_SPEC_MARKER,
      )
    } else {
      const resolvedTrace = resolveSpecTrace(specTrace)
      const targetPath = resolvedTrace?.targetPath
      const anchor = resolvedTrace?.anchor
      const targetExists =
        Boolean(targetPath) &&
        Boolean(options.repoRoot) &&
        existsSync(path.resolve(options.repoRoot!, targetPath))
      if (!resolvedTrace || !targetPath || !anchor || !targetExists) {
        addFinding(
          findings,
          seen,
          sourceFile,
          filePath,
          sourceFile,
          'invalid_spec_trace',
          'error',
          'Changed test files must reference an existing spec file and section, for example: test-spec: specs/feature.md#section-id.',
          specTrace,
        )
      }
    }
  }

  if (options.changedTestFile && tests.length === 1 && !NEGATIVE_TEST_NAME_RE.test(tests[0]!.name)) {
    addFinding(
      findings,
      seen,
      sourceFile,
      filePath,
      sourceFile,
      'missing_negative_case',
      'error',
      'Changed test files must include at least one neighboring or negative case so the assertions cannot overfit to a single happy-path example.',
      tests[0]!.name,
    )
  }

  return findings.sort(
    (left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line,
  )
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
  const policy = await loadBuildTrustPolicy(repoRoot).catch(() => null)
  const changedTestFiles = collectChangedTestFiles(repoRoot)
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
    findings.push(
      ...analyzeTestSource(relativePath, source, {
        changedTestFile: changedTestFiles.has(relativePath),
        requireIntentTraceForChangedTests:
          policy?.qualityRules.requireIntentTraceForChangedTests ?? true,
        requireSpecTraceForChangedTests:
          policy?.qualityRules.requireSpecTraceForChangedTests ?? true,
        repoRoot,
      }),
    )
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

export function renderTestQualityText(report: TestQualityReport): string {
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

export function renderTestQualityHtml(report: TestQualityReport): string {
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
          <li>Tests cannot compare a value to itself, even through aliases.</li>
          <li>Tests cannot assert a literal against the same literal.</li>
          <li>Expected values cannot be aliases of actual results.</li>
          <li>Expected values cannot be computed by the same callable under test.</li>
          <li>Fixture text cannot be copied straight into assertions as the answer.</li>
          <li>Snapshot-only tests must include semantic assertions.</li>
          <li>Changed test files must declare their user-visible intent with a <code>// test-intent:</code> comment.</li>
          <li>Changed test files must reference a real feature spec with a <code>// test-spec:</code> comment.</li>
          <li>Changed test files need a neighboring or negative case.</li>
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

export function parseTestQualityArgs(argv: string[]): {
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
  const { htmlPath, json, root } = parseTestQualityArgs(process.argv.slice(2))
  const report = await runTestQualityCheck(root)

  if (htmlPath) {
    const outputPath = path.resolve(root, htmlPath)
    await writeFile(outputPath, renderTestQualityHtml(report), 'utf8')
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderTestQualityText(report)}\n`)
  }

  process.exit(report.errorCount > 0 ? 1 : 0)
}
