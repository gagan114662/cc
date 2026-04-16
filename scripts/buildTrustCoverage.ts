import path from 'node:path'
import type { BuildTrustPolicy } from 'src/services/buildTrust/types.js'

export type ChangedLineSet = Map<string, Set<number>>

export type CoverageLineStatus = {
  filePath: string
  line: number
  critical: boolean
  covered: boolean
}

export type BuildTrustCoverageReport = {
  mode: 'changed_lines' | 'full_repo_fallback'
  baseRef: string | null
  status: 'passed' | 'failed'
  summary: string
  changedExecutableLines: number
  changedCoveredLines: number
  changedLineCoveragePct: number
  criticalExecutableLines: number
  criticalCoveredLines: number
  criticalLineCoveragePct: number
  uncoveredRanges: Array<{
    filePath: string
    critical: boolean
    ranges: string[]
  }>
  nonExecutableFiles: string[]
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '::double-star::')
    .replaceAll('*', '[^/]*')
    .replaceAll('::double-star::', '.*')
  return new RegExp(`^${escaped}$`)
}

export function parseLcov(content: string): Map<string, Map<number, number>> {
  const coverage = new Map<string, Map<number, number>>()
  let currentFile: string | null = null

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('SF:')) {
      currentFile = path.normalize(line.slice(3))
      coverage.set(currentFile, new Map())
      continue
    }
    if (!currentFile || !line.startsWith('DA:')) {
      continue
    }
    const [lineNumberRaw, hitsRaw] = line.slice(3).split(',', 2)
    const lineNumber = Number(lineNumberRaw)
    const hits = Number(hitsRaw)
    if (Number.isNaN(lineNumber) || Number.isNaN(hits)) {
      continue
    }
    coverage.get(currentFile)?.set(lineNumber, hits)
  }

  return coverage
}

export function parseUnifiedDiffChangedLines(diffText: string): ChangedLineSet {
  const changed = new Map<string, Set<number>>()
  let currentFile: string | null = null

  for (const rawLine of diffText.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('+++ b/')) {
      currentFile = path.normalize(line.slice('+++ b/'.length))
      changed.set(currentFile, changed.get(currentFile) ?? new Set())
      continue
    }
    if (!currentFile || !line.startsWith('@@')) {
      continue
    }
    const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!match) continue
    const start = Number(match[1] ?? '0')
    const count = Number(match[2] ?? '1')
    const fileLines = changed.get(currentFile) ?? new Set<number>()
    for (let index = 0; index < count; index += 1) {
      fileLines.add(start + index)
    }
    changed.set(currentFile, fileLines)
  }

  return changed
}

export function mergeChangedLineSets(...sets: ChangedLineSet[]): ChangedLineSet {
  const merged: ChangedLineSet = new Map()

  for (const changedLines of sets) {
    for (const [filePath, lines] of changedLines.entries()) {
      const existing = merged.get(filePath) ?? new Set<number>()
      for (const line of lines) {
        existing.add(line)
      }
      merged.set(filePath, existing)
    }
  }

  return merged
}

function compressRanges(lines: number[]): string[] {
  if (lines.length === 0) return []
  const sorted = [...lines].sort((left, right) => left - right)
  const ranges: string[] = []
  let start = sorted[0]!
  let previous = sorted[0]!

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!
    if (current === previous + 1) {
      previous = current
      continue
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`)
    start = current
    previous = current
  }

  ranges.push(start === previous ? `${start}` : `${start}-${previous}`)
  return ranges
}

export function evaluateCoverageAgainstChanges(
  coverage: Map<string, Map<number, number>>,
  changedLines: ChangedLineSet,
  policy: BuildTrustPolicy,
  mode: 'changed_lines' | 'full_repo_fallback',
  baseRef: string | null,
): BuildTrustCoverageReport {
  const criticalMatchers = policy.criticalGlobs.map(glob => globToRegExp(glob))
  const uncoveredByFile = new Map<string, { lines: number[]; critical: boolean }>()
  const nonExecutableFiles: string[] = []
  let changedExecutableLines = 0
  let changedCoveredLines = 0
  let criticalExecutableLines = 0
  let criticalCoveredLines = 0

  for (const [rawFilePath, lineSet] of changedLines.entries()) {
    const normalizedRelative = path.normalize(rawFilePath)
    const critical = criticalMatchers.some(match => match.test(normalizedRelative))
    const coverageEntry =
      coverage.get(normalizedRelative) ??
      coverage.get(path.resolve(normalizedRelative))
    const executableLines: CoverageLineStatus[] = []

    for (const lineNumber of [...lineSet].sort((left, right) => left - right)) {
      const hits = coverageEntry?.get(lineNumber)
      if (hits === undefined) {
        continue
      }
      executableLines.push({
        filePath: normalizedRelative,
        line: lineNumber,
        critical,
        covered: hits > 0,
      })
    }

    if (executableLines.length === 0) {
      nonExecutableFiles.push(normalizedRelative)
      continue
    }

    for (const line of executableLines) {
      changedExecutableLines += 1
      if (line.covered) {
        changedCoveredLines += 1
      } else {
        const existing = uncoveredByFile.get(line.filePath) ?? {
          lines: [],
          critical,
        }
        existing.lines.push(line.line)
        uncoveredByFile.set(line.filePath, existing)
      }
      if (!line.critical) continue
      criticalExecutableLines += 1
      if (line.covered) {
        criticalCoveredLines += 1
      }
    }
  }

  const changedLineCoveragePct =
    changedExecutableLines === 0
      ? 100
      : (changedCoveredLines / changedExecutableLines) * 100
  const criticalLineCoveragePct =
    criticalExecutableLines === 0
      ? 100
      : (criticalCoveredLines / criticalExecutableLines) * 100

  const uncoveredRanges = [...uncoveredByFile.entries()]
    .map(([filePath, value]) => ({
      filePath,
      critical: value.critical,
      ranges: compressRanges(value.lines),
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath))

  const passed =
    changedLineCoveragePct >= policy.thresholds.minChangedLineCoveragePct &&
    criticalLineCoveragePct >= policy.thresholds.minCriticalChangedLineCoveragePct

  const summary =
    mode === 'full_repo_fallback'
      ? 'Base ref was unavailable; using informational full-repo fallback.'
      : `Compared coverage against changed lines from ${baseRef ?? '(unknown base)'}.`

  return {
    mode,
    baseRef,
    status: passed ? 'passed' : 'failed',
    summary,
    changedExecutableLines,
    changedCoveredLines,
    changedLineCoveragePct,
    criticalExecutableLines,
    criticalCoveredLines,
    criticalLineCoveragePct,
    uncoveredRanges,
    nonExecutableFiles: nonExecutableFiles.sort(),
  }
}
