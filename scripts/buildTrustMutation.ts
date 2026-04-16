#!/usr/bin/env bun

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import type {
  BuildTrustPolicy,
  BuildTrustProfileName,
} from 'src/services/buildTrust/types.js'
import type { BuildTrustCommandResult } from './buildTrustReport.js'
import type { ChangedLineSet } from './buildTrustCoverage.js'

export type BuildTrustMutationCandidate = {
  filePath: string
  line: number
  start: number
  end: number
  original: string
  replacement: string
  description: string
}

export type BuildTrustMutationTrial = {
  filePath: string
  line: number
  description: string
  original: string
  replacement: string
  status: 'killed' | 'survived'
  command: string
}

export type BuildTrustMutationReport = {
  status: 'passed' | 'failed' | 'skipped'
  summary: string
  changedSourceFileCount: number
  candidateCount: number
  executedTrialCount: number
  survivingTrialCount: number
  trials: BuildTrustMutationTrial[]
}

type BuildTrustMutationInput = {
  repoRoot: string
  profile: BuildTrustProfileName
  policy: BuildTrustPolicy
  changedFiles: string[]
  changedLines: ChangedLineSet
}

type MutationCommandRunner = (
  label: string,
  command: string,
  cwd: string,
) => Promise<BuildTrustCommandResult>

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/
const SOURCE_FILE_RE = /(?:^|\/)[^/]+\.[cm]?[jt]sx?$/
const MUTATION_OPERATOR_REPLACEMENTS = new Map<ts.SyntaxKind, {
  replacement: string
  description: string
}>([
  [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    {
      replacement: '!==',
      description: 'invert strict equality',
    },
  ],
  [
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    {
      replacement: '===',
      description: 'invert strict inequality',
    },
  ],
  [
    ts.SyntaxKind.GreaterThanToken,
    {
      replacement: '>=',
      description: 'widen greater-than boundary',
    },
  ],
  [
    ts.SyntaxKind.GreaterThanEqualsToken,
    {
      replacement: '>',
      description: 'tighten greater-than-equals boundary',
    },
  ],
  [
    ts.SyntaxKind.LessThanToken,
    {
      replacement: '<=',
      description: 'widen less-than boundary',
    },
  ],
  [
    ts.SyntaxKind.LessThanEqualsToken,
    {
      replacement: '<',
      description: 'tighten less-than-equals boundary',
    },
  ],
])

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function isCandidateSourceFile(filePath: string): boolean {
  return (
    SOURCE_FILE_RE.test(filePath) &&
    !TEST_FILE_RE.test(filePath) &&
    !filePath.endsWith('.d.ts') &&
    !filePath.startsWith('test/') &&
    !filePath.startsWith('tests/') &&
    !filePath.startsWith('e2e/') &&
    !filePath.startsWith('dist/') &&
    !filePath.startsWith('coverage/')
  )
}

function parseSourceFile(filePath: string, source: string): ts.SourceFile {
  const scriptKind = filePath.endsWith('x')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind)
}

function lineNumberAt(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1
}

function makeCandidate(
  sourceFile: ts.SourceFile,
  filePath: string,
  node: ts.Node,
  replacement: string,
  description: string,
): BuildTrustMutationCandidate {
  return {
    filePath,
    line: lineNumberAt(sourceFile, node.getStart(sourceFile)),
    start: node.getStart(sourceFile),
    end: node.getEnd(),
    original: node.getText(sourceFile),
    replacement,
    description,
  }
}

export function collectMutationCandidates(
  filePath: string,
  source: string,
  changedLines: Set<number>,
): BuildTrustMutationCandidate[] {
  if (changedLines.size === 0) {
    return []
  }

  const sourceFile = parseSourceFile(filePath, source)
  const candidates: BuildTrustMutationCandidate[] = []

  const addCandidate = (candidate: BuildTrustMutationCandidate): void => {
    candidates.push(candidate)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const line = lineNumberAt(sourceFile, node.operatorToken.getStart(sourceFile))
      if (changedLines.has(line)) {
        const mutation = MUTATION_OPERATOR_REPLACEMENTS.get(node.operatorToken.kind)
        if (mutation) {
          addCandidate(
            makeCandidate(
              sourceFile,
              filePath,
              node.operatorToken,
              mutation.replacement,
              mutation.description,
            ),
          )
        }
      }
    }

    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      if (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) {
        ts.forEachChild(node, visit)
        return
      }
      const line = lineNumberAt(sourceFile, node.getStart(sourceFile))
      if (changedLines.has(line)) {
        addCandidate(
          makeCandidate(
            sourceFile,
            filePath,
            node,
            node.kind === ts.SyntaxKind.TrueKeyword ? 'false' : 'true',
            'flip boolean literal',
          ),
        )
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return candidates.sort((left, right) => left.line - right.line || left.start - right.start)
}

function selectMutationCandidates(
  candidatesByFile: Map<string, BuildTrustMutationCandidate[]>,
  maxTrialsPerRun: number,
): BuildTrustMutationCandidate[] {
  const queues = [...candidatesByFile.entries()]
    .map(([filePath, candidates]) => [filePath, [...candidates]] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  const selected: BuildTrustMutationCandidate[] = []

  while (selected.length < maxTrialsPerRun) {
    let progressed = false
    for (const [, queue] of queues) {
      const next = queue.shift()
      if (!next) {
        continue
      }
      selected.push(next)
      progressed = true
      if (selected.length >= maxTrialsPerRun) {
        break
      }
    }
    if (!progressed) {
      break
    }
  }

  return selected
}

export function getMutationTestCommand(
  policy: BuildTrustPolicy,
  changedFiles: string[],
): string {
  const changedTestFiles = changedFiles
    .map(normalizePath)
    .filter(filePath => TEST_FILE_RE.test(filePath))
    .sort()

  if (changedTestFiles.length > 0) {
    return `bun test ${changedTestFiles.map(quoteShellArg).join(' ')}`
  }

  return policy.mutationRules?.testCommand ?? 'bun test ./test'
}

export async function runBuildTrustMutation(
  input: BuildTrustMutationInput,
  commandRunner: MutationCommandRunner,
): Promise<BuildTrustMutationReport> {
  const mutationRules = input.policy.mutationRules ?? {
    enabled: true,
    maxTrialsPerRun: 6,
    testCommand: 'bun test ./test',
  }
  if (!mutationRules.enabled) {
    return {
      status: 'skipped',
      summary: 'Mutation sensitivity is disabled by policy.',
      changedSourceFileCount: 0,
      candidateCount: 0,
      executedTrialCount: 0,
      survivingTrialCount: 0,
      trials: [],
    }
  }

  const changedSourceFiles = input.changedFiles
    .map(normalizePath)
    .filter(isCandidateSourceFile)
    .filter(filePath => input.changedLines.has(filePath))
    .sort()

  if (changedSourceFiles.length === 0) {
    return {
      status: 'skipped',
      summary: 'No changed source files were eligible for mutation sensitivity checks.',
      changedSourceFileCount: 0,
      candidateCount: 0,
      executedTrialCount: 0,
      survivingTrialCount: 0,
      trials: [],
    }
  }

  const candidatesByFile = new Map<string, BuildTrustMutationCandidate[]>()
  for (const filePath of changedSourceFiles) {
    const source = await readFile(path.join(input.repoRoot, filePath), 'utf8').catch(
      () => null,
    )
    if (source === null) {
      continue
    }
    const changedLines = input.changedLines.get(filePath) ?? new Set<number>()
    const candidates = collectMutationCandidates(filePath, source, changedLines)
    if (candidates.length > 0) {
      candidatesByFile.set(filePath, candidates)
    }
  }

  const candidateCount = [...candidatesByFile.values()].reduce(
    (total, candidates) => total + candidates.length,
    0,
  )
  if (candidateCount === 0) {
    return {
      status: 'skipped',
      summary: 'No simple boolean or boundary mutations were available on the changed source lines.',
      changedSourceFileCount: changedSourceFiles.length,
      candidateCount: 0,
      executedTrialCount: 0,
      survivingTrialCount: 0,
      trials: [],
    }
  }

  const selectedCandidates = selectMutationCandidates(
    candidatesByFile,
    mutationRules.maxTrialsPerRun,
  )
  const trials: BuildTrustMutationTrial[] = []
  const command = getMutationTestCommand(input.policy, input.changedFiles)

  for (let index = 0; index < selectedCandidates.length; index += 1) {
    const candidate = selectedCandidates[index]!
    const absolutePath = path.join(input.repoRoot, candidate.filePath)
    const originalSource = await readFile(absolutePath, 'utf8')
    const mutatedSource =
      originalSource.slice(0, candidate.start) +
      candidate.replacement +
      originalSource.slice(candidate.end)

    try {
      await writeFile(absolutePath, mutatedSource, 'utf8')
      const result = await commandRunner(
        `mutation-${index + 1}`,
        command,
        input.repoRoot,
      )
      trials.push({
        filePath: candidate.filePath,
        line: candidate.line,
        description: candidate.description,
        original: candidate.original,
        replacement: candidate.replacement,
        status: result.status === 'failed' ? 'killed' : 'survived',
        command,
      })
    } finally {
      await writeFile(absolutePath, originalSource, 'utf8')
    }
  }

  const survivingTrialCount = trials.filter(trial => trial.status === 'survived').length
  const maxSurvivors = input.policy.thresholds.maxSurvivingMutations ?? 0

  return {
    status: survivingTrialCount > maxSurvivors ? 'failed' : 'passed',
    summary:
      survivingTrialCount > maxSurvivors
        ? `${survivingTrialCount} mutation trials survived; changed tests did not detect the adversarial edits.`
        : `All ${trials.length} mutation trials were killed by the current tests.`,
    changedSourceFileCount: changedSourceFiles.length,
    candidateCount,
    executedTrialCount: trials.length,
    survivingTrialCount,
    trials,
  }
}
