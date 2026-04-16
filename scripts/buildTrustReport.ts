import type { BuildTrustProfileName } from 'src/services/buildTrust/types.js'
import type { BuildTrustCoverageReport } from './buildTrustCoverage.js'
import type { BuildTrustMediaArtifact } from './buildTrustMediaArtifacts.js'
import type { BuildTrustMutationReport } from './buildTrustMutation.js'
import type { BuildTrustPreflightReport } from './buildTrustPreflight.js'

export type BuildTrustCommandResult = {
  label: string
  command: string
  status: 'passed' | 'failed' | 'skipped'
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
}

export type BuildTrustStabilityRun = {
  seed: number
  status: 'passed' | 'failed'
  junitPath: string | null
  failingTests: string[]
}

export type BuildTrustRiskSuite = {
  label: string
  status: 'passed' | 'failed' | 'skipped'
  reason: string
}

export type BuildTrustRunnerReport = {
  repoRoot: string
  profile: BuildTrustProfileName
  verdict:
    | 'trusted'
    | 'blocked_environment'
    | 'blocked_quality'
    | 'blocked_flakiness'
    | 'blocked_coverage'
    | 'blocked_verification'
  generatedAt: string
  baseRef: string | null
  changedFiles: string[]
  preflight: BuildTrustPreflightReport
  commandResults: BuildTrustCommandResult[]
  qualityReport: {
    errorCount: number
    warningCount: number
    findings: Array<{
      filePath: string
      line: number
      ruleId: string
      severity: string
      message: string
      snippet: string
    }>
  }
  stabilityRuns: BuildTrustStabilityRun[]
  coverage: BuildTrustCoverageReport | null
  mutation: BuildTrustMutationReport | null
  mediaArtifacts: BuildTrustMediaArtifact[]
  riskSuites: BuildTrustRiskSuite[]
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

type ReviewConsoleItem = {
  category: 'command' | 'quality' | 'coverage' | 'mutation' | 'suite'
  severity: 'critical' | 'warning' | 'info'
  title: string
  summary: string
  detail: string
  targetId: string
  searchText: string
}

function severityFromQualityFinding(
  severity: string,
): ReviewConsoleItem['severity'] {
  if (severity === 'error') {
    return 'critical'
  }
  if (severity === 'warning') {
    return 'warning'
  }
  return 'info'
}

function buildReviewConsoleItems(report: BuildTrustRunnerReport): ReviewConsoleItem[] {
  const items: ReviewConsoleItem[] = []

  for (const result of report.commandResults) {
    if (result.status !== 'failed') {
      continue
    }
    items.push({
      category: 'command',
      severity: 'critical',
      title: result.label,
      summary: result.command,
      detail: `Exit ${result.exitCode ?? 'n/a'} after ${result.durationMs}ms`,
      targetId: 'command-results',
      searchText: `${result.label} ${result.command} ${result.stdout} ${result.stderr}`,
    })
  }

  for (const finding of report.qualityReport.findings) {
    items.push({
      category: 'quality',
      severity: severityFromQualityFinding(finding.severity),
      title: finding.ruleId,
      summary: finding.message,
      detail: `${finding.filePath}:${finding.line}`,
      targetId: 'test-quality-findings',
      searchText: `${finding.ruleId} ${finding.message} ${finding.filePath} ${finding.snippet}`,
    })
  }

  for (const range of report.coverage?.uncoveredRanges ?? []) {
    items.push({
      category: 'coverage',
      severity: range.critical ? 'critical' : 'warning',
      title: range.filePath,
      summary: `Uncovered changed lines: ${range.ranges.join(', ')}`,
      detail: range.critical ? 'Critical file' : 'Changed file',
      targetId: 'changed-code-coverage',
      searchText: `${range.filePath} ${range.ranges.join(' ')} ${
        range.critical ? 'critical' : 'changed'
      }`,
    })
  }

  for (const trial of report.mutation?.trials ?? []) {
    items.push({
      category: 'mutation',
      severity: trial.status === 'survived' ? 'critical' : 'info',
      title: `${trial.filePath}:${trial.line}`,
      summary: `${trial.description} (${trial.original} -> ${trial.replacement})`,
      detail:
        trial.status === 'survived'
          ? 'Mutant survived the test suite'
          : 'Mutant was killed by the test suite',
      targetId: 'mutation-sensitivity',
      searchText: `${trial.filePath} ${trial.description} ${trial.original} ${trial.replacement} ${trial.status}`,
    })
  }

  for (const suite of report.riskSuites) {
    if (suite.status === 'passed') {
      continue
    }
    items.push({
      category: 'suite',
      severity: suite.status === 'failed' ? 'critical' : 'warning',
      title: suite.label,
      summary: suite.reason,
      detail: suite.status === 'failed' ? 'Risk suite failed' : 'Risk suite skipped',
      targetId: 'risk-triggered-suites',
      searchText: `${suite.label} ${suite.reason} ${suite.status}`,
    })
  }

  return items
}

export function renderBuildTrustHtml(report: BuildTrustRunnerReport): string {
  const reviewItems = buildReviewConsoleItems(report)
  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'review-console', label: 'Review Console' },
    { id: 'environment-integrity', label: 'Environment' },
    { id: 'command-results', label: 'Commands' },
    { id: 'test-quality-findings', label: 'Test Quality' },
    { id: 'stability-matrix', label: 'Stability' },
    { id: 'changed-code-coverage', label: 'Coverage' },
    { id: 'mutation-sensitivity', label: 'Mutation' },
    { id: 'review-media', label: 'Review Media' },
    { id: 'risk-triggered-suites', label: 'Risk Suites' },
    { id: 'final-verdict', label: 'Verdict' },
  ] as const
  const commandMarkup = report.commandResults
    .map(
      result => `
        <article class="panel ${result.status}">
          <h3>${escapeHtml(result.label)}</h3>
          <p><strong>${escapeHtml(result.status.toUpperCase())}</strong> ${escapeHtml(
            result.command,
          )}</p>
          <p>Exit code: ${escapeHtml(String(result.exitCode ?? 'n/a'))} · Duration: ${escapeHtml(
            `${result.durationMs}ms`,
          )}</p>
          ${
            result.stdout
              ? `<pre><code>${escapeHtml(result.stdout.slice(0, 1200))}</code></pre>`
              : ''
          }
          ${
            result.stderr
              ? `<pre><code>${escapeHtml(result.stderr.slice(0, 1200))}</code></pre>`
              : ''
          }
        </article>`,
    )
    .join('\n')

  const qualityMarkup =
    report.qualityReport.findings.length === 0
      ? '<p>No suspicious test-quality shortcuts detected.</p>'
      : report.qualityReport.findings
          .map(
            finding => `
              <article class="panel ${escapeHtml(finding.severity)}">
                <h3>${escapeHtml(`${finding.severity.toUpperCase()} ${finding.ruleId}`)}</h3>
                <p><strong>${escapeHtml(`${finding.filePath}:${finding.line}`)}</strong></p>
                <p>${escapeHtml(finding.message)}</p>
                <pre><code>${escapeHtml(finding.snippet)}</code></pre>
              </article>`,
          )
          .join('\n')

  const stabilityMarkup = report.stabilityRuns
    .map(
      run => `
        <article class="panel ${run.status}">
          <h3>Seed ${run.seed}</h3>
          <p>${escapeHtml(run.status.toUpperCase())}</p>
          <p>JUnit: ${escapeHtml(run.junitPath ?? '(none)')}</p>
          ${
            run.failingTests.length > 0
              ? `<p>Failing tests: ${escapeHtml(run.failingTests.join(', '))}</p>`
              : '<p>No failing tests.</p>'
          }
        </article>`,
    )
    .join('\n')

  const coverageMarkup = report.coverage
    ? `
      <article class="panel ${report.coverage.status}">
        <h3>${escapeHtml(report.coverage.status.toUpperCase())}</h3>
        <p>${escapeHtml(report.coverage.summary)}</p>
        <p>Changed-line coverage: ${escapeHtml(report.coverage.changedLineCoveragePct.toFixed(2))}%</p>
        <p>Critical changed-line coverage: ${escapeHtml(report.coverage.criticalLineCoveragePct.toFixed(2))}%</p>
        ${
          report.coverage.uncoveredRanges.length > 0
            ? `<ul>${report.coverage.uncoveredRanges
                .map(
                  item =>
                    `<li>${escapeHtml(item.filePath)} ${escapeHtml(
                      item.ranges.join(', '),
                    )}${item.critical ? ' (critical)' : ''}</li>`,
                )
                .join('')}</ul>`
            : '<p>No uncovered changed executable lines.</p>'
        }
        ${
          report.coverage.nonExecutableFiles.length > 0
            ? `<p>Non-executable changes: ${escapeHtml(
                report.coverage.nonExecutableFiles.join(', '),
              )}</p>`
            : ''
        }
      </article>`
    : '<p>No coverage report generated.</p>'

  const mutationMarkup = report.mutation
    ? `
      <article class="panel ${report.mutation.status}">
        <h3>${escapeHtml(report.mutation.status.toUpperCase())}</h3>
        <p>${escapeHtml(report.mutation.summary)}</p>
        <p>Changed source files: ${escapeHtml(String(report.mutation.changedSourceFileCount))}</p>
        <p>Candidates: ${escapeHtml(String(report.mutation.candidateCount))} · Executed: ${escapeHtml(
            String(report.mutation.executedTrialCount),
          )} · Survived: ${escapeHtml(String(report.mutation.survivingTrialCount))}</p>
        ${
          report.mutation.trials.length > 0
            ? `<ul>${report.mutation.trials
                .map(
                  trial =>
                    `<li>${escapeHtml(
                      `${trial.status.toUpperCase()} ${trial.filePath}:${trial.line} ${trial.description} (${trial.original} -> ${trial.replacement})`,
                    )}</li>`,
                )
                .join('')}</ul>`
            : '<p>No mutation trials were executed.</p>'
        }
      </article>`
    : '<p>No mutation sensitivity report generated.</p>'

  const riskSuiteMarkup =
    report.riskSuites.length === 0
      ? '<p>No risk-triggered suites were evaluated.</p>'
      : `<ul>${report.riskSuites
          .map(
            suite =>
              `<li>${escapeHtml(`${suite.label}: ${suite.status} — ${suite.reason}`)}</li>`,
          )
          .join('')}</ul>`

  const mediaArtifactMarkup =
    report.mediaArtifacts.length === 0
      ? '<p>No review media artifacts were generated.</p>'
      : `<div class="media-grid">${report.mediaArtifacts
          .map(artifact => {
            const href = escapeHtml(artifact.filePath)
            if (artifact.kind === 'screenshot') {
              return `<article class="panel">
                <h3>${escapeHtml(artifact.label)}</h3>
                <p>${escapeHtml(artifact.description)}</p>
                <p><a href="${href}">${href}</a></p>
                <img src="${href}" alt="${escapeHtml(artifact.label)}" loading="lazy" />
              </article>`
            }
            return `<article class="panel">
              <h3>${escapeHtml(artifact.label)}</h3>
              <p>${escapeHtml(artifact.description)}</p>
              <p><a href="${href}">${href}</a></p>
            </article>`
          })
          .join('')}</div>`

  const preflightFailures = report.preflight.checks.filter(
    check => check.status === 'failed',
  )
  const reviewItemsMarkup =
    reviewItems.length === 0
      ? ''
      : reviewItems
          .map(
            item => `
              <article
                class="panel review-item severity-${escapeHtml(item.severity)}"
                data-review-item
                data-review-category="${escapeHtml(item.category)}"
                data-review-severity="${escapeHtml(item.severity)}"
                data-review-search="${escapeHtml(item.searchText.toLowerCase())}"
              >
                <p class="review-kicker">${escapeHtml(
                  `${item.category.toUpperCase()} · ${item.severity.toUpperCase()}`,
                )}</p>
                <h3>${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.summary)}</p>
                <p class="meta">${escapeHtml(item.detail)}</p>
                <p><a href="#${escapeHtml(item.targetId)}">Inspect section</a></p>
              </article>`,
          )
          .join('\n')
  const reviewItemsJson = JSON.stringify(reviewItems).replaceAll('<', '\\u003c')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Build Trust Proof</title>
    <style>
      :root {
        --bg: #f6f6ef;
        --panel: #fffdf8;
        --ink: #171717;
        --muted: #57534e;
        --passed: #166534;
        --failed: #991b1b;
        --skipped: #92400e;
        --border: #ddd6c5;
      }
      body {
        margin: 0;
        background: radial-gradient(circle at top, #fff8df, var(--bg) 40%);
        color: var(--ink);
        font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
      }
      main {
        max-width: 1220px;
        margin: 0 auto;
        padding: 48px 20px 80px;
        display: grid;
        grid-template-columns: 220px minmax(0, 1fr);
        gap: 18px;
      }
      section, .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 20px 24px;
        box-shadow: 0 18px 40px rgba(23, 23, 23, 0.06);
      }
      section + section, .panel + .panel {
        margin-top: 18px;
      }
      .passed h3, .passed strong { color: var(--passed); }
      .failed h3, .failed strong { color: var(--failed); }
      .skipped h3, .skipped strong { color: var(--skipped); }
      pre {
        overflow-x: auto;
        padding: 14px;
        background: #f7f1e3;
        border-radius: 12px;
        border: 1px solid var(--border);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
      }
      .stat {
        padding: 16px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: #fff8ee;
      }
      .meta { color: var(--muted); }
      ul { padding-left: 20px; }
      .media-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 14px;
      }
      .proof-nav {
        position: sticky;
        top: 24px;
        align-self: start;
        background: rgba(255, 253, 248, 0.92);
        backdrop-filter: blur(8px);
      }
      .proof-nav ul {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .proof-nav li + li {
        margin-top: 8px;
      }
      .proof-nav a {
        color: var(--ink);
        text-decoration: none;
        display: block;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid transparent;
      }
      .proof-nav a:hover,
      .proof-nav a[aria-current="true"] {
        border-color: var(--border);
        background: #fff4df;
      }
      .proof-content {
        min-width: 0;
      }
      .review-shell {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 16px;
      }
      .review-toolbar {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        align-items: end;
      }
      .review-toolbar label {
        display: grid;
        gap: 6px;
        font-size: 0.95rem;
      }
      .review-toolbar input,
      .review-toolbar select,
      .review-toolbar button {
        font: inherit;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: #fffaf2;
        padding: 10px 12px;
        color: var(--ink);
      }
      .review-toolbar button[aria-pressed="true"] {
        background: #2f2416;
        color: #fff8ee;
      }
      .review-summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
      }
      .review-list {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
      }
      .review-item {
        margin-top: 0;
      }
      .review-item[hidden] {
        display: none;
      }
      .review-kicker {
        letter-spacing: 0.08em;
        font-size: 0.74rem;
        color: var(--muted);
      }
      .severity-critical h3 {
        color: var(--failed);
      }
      .severity-warning h3 {
        color: var(--skipped);
      }
      .review-empty {
        display: none;
      }
      .review-empty[data-visible="true"] {
        display: block;
      }
      img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: #f7f1e3;
      }
      @media (max-width: 920px) {
        main {
          grid-template-columns: 1fr;
        }
        .proof-nav {
          position: static;
        }
        .review-toolbar {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <nav class="proof-nav panel" aria-label="Proof sections">
        <h2>Navigate</h2>
        <ul>
          ${sections
            .map(
              section =>
                `<li><a href="#${escapeHtml(section.id)}" data-proof-nav="${escapeHtml(
                  section.id,
                )}">${escapeHtml(section.label)}</a></li>`,
            )
            .join('')}
        </ul>
      </nav>
      <div class="proof-content">
      <section id="overview">
        <p class="meta">Generated ${escapeHtml(report.generatedAt)}</p>
        <h1>Build Trust Proof</h1>
        <p><strong>${escapeHtml(report.verdict)}</strong></p>
        <div class="grid">
          <div class="stat"><div class="meta">Profile</div><div>${escapeHtml(report.profile)}</div></div>
          <div class="stat"><div class="meta">Base Ref</div><div>${escapeHtml(report.baseRef ?? '(none)')}</div></div>
          <div class="stat"><div class="meta">Changed Files</div><div>${escapeHtml(String(report.changedFiles.length))}</div></div>
          <div class="stat"><div class="meta">Quality Findings</div><div>${escapeHtml(
            String(report.qualityReport.findings.length),
          )}</div></div>
          <div class="stat"><div class="meta">Mutation Survivors</div><div>${escapeHtml(
            String(report.mutation?.survivingTrialCount ?? 0),
          )}</div></div>
        </div>
      </section>
      <section id="review-console">
        <p class="meta">Browser review feature</p>
        <h2>Review Console</h2>
        <p>Filter actionable findings across commands, test quality, changed-line coverage, mutation sensitivity, and risk suites without manually scanning the whole proof.</p>
        <div class="review-shell">
          <div class="review-summary">
            <div class="stat"><div class="meta">Visible items</div><div data-review-visible-count>${escapeHtml(
              String(reviewItems.length),
            )}</div></div>
            <div class="stat"><div class="meta">Critical visible</div><div data-review-critical-count>${escapeHtml(
              String(reviewItems.filter(item => item.severity === 'critical').length),
            )}</div></div>
            <div class="stat"><div class="meta">Categories</div><div data-review-category-count>${escapeHtml(
              String(new Set(reviewItems.map(item => item.category)).size),
            )}</div></div>
          </div>
          <div class="panel">
            <div class="review-toolbar">
              <label>
                Search
                <input id="review-search" type="search" placeholder="file, rule, or command" />
              </label>
              <label>
                Category
                <select id="review-category">
                  <option value="all">All categories</option>
                  <option value="command">Commands</option>
                  <option value="quality">Test quality</option>
                  <option value="coverage">Coverage</option>
                  <option value="mutation">Mutation</option>
                  <option value="suite">Risk suites</option>
                </select>
              </label>
              <label>
                Severity
                <select id="review-severity">
                  <option value="all">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </select>
              </label>
              <button type="button" id="review-blockers-only" aria-pressed="false">Blockers only</button>
            </div>
          </div>
          ${
            reviewItems.length === 0
              ? '<p class="review-empty" data-visible="true">No actionable items were generated for this proof.</p>'
              : `<p class="review-empty" id="review-empty">No review items match the current filters.</p>
                 <div class="review-list">${reviewItemsMarkup}</div>`
          }
        </div>
      </section>
      <section id="environment-integrity">
        <h2>Environment Integrity</h2>
        <p>${escapeHtml(report.preflight.status.toUpperCase())}</p>
        ${
          preflightFailures.length === 0
            ? '<p>No preflight failures detected.</p>'
            : `<ul>${preflightFailures
                .map(check => `<li>${escapeHtml(`${check.name}: ${check.detail}`)}</li>`)
                .join('')}</ul>`
        }
      </section>
      <section id="command-results">
        <h2>Command Results</h2>
        ${commandMarkup || '<p>No commands were run.</p>'}
      </section>
      <section id="test-quality-findings">
        <h2>Test Quality Findings</h2>
        ${qualityMarkup}
      </section>
      <section id="stability-matrix">
        <h2>Stability Matrix</h2>
        ${stabilityMarkup || '<p>No stability runs were recorded.</p>'}
      </section>
      <section id="changed-code-coverage">
        <h2>Changed-Code Coverage</h2>
        ${coverageMarkup}
      </section>
      <section id="mutation-sensitivity">
        <h2>Mutation Sensitivity</h2>
        ${mutationMarkup}
      </section>
      <section id="review-media">
        <h2>Review Media</h2>
        ${mediaArtifactMarkup}
      </section>
      <section id="risk-triggered-suites">
        <h2>Risk-Triggered Suites</h2>
        ${riskSuiteMarkup}
      </section>
      <section id="final-verdict">
        <h2>Final Verdict</h2>
        <p>${escapeHtml(report.verdict)}</p>
      </section>
      </div>
      <script>
        const reviewItems = ${reviewItemsJson};
        const searchInput = document.querySelector('#review-search');
        const categorySelect = document.querySelector('#review-category');
        const severitySelect = document.querySelector('#review-severity');
        const blockersButton = document.querySelector('#review-blockers-only');
        const reviewNodes = [...document.querySelectorAll('[data-review-item]')];
        const visibleCountNode = document.querySelector('[data-review-visible-count]');
        const criticalCountNode = document.querySelector('[data-review-critical-count]');
        const categoryCountNode = document.querySelector('[data-review-category-count]');
        const emptyState = document.querySelector('#review-empty');
        const reviewState = {
          query: '',
          category: 'all',
          severity: 'all',
          blockersOnly: false,
        };
        const params = new URLSearchParams(location.search);
        if (searchInput) searchInput.value = params.get('reviewQuery') ?? '';
        if (categorySelect) categorySelect.value = params.get('reviewCategory') ?? 'all';
        if (severitySelect) severitySelect.value = params.get('reviewSeverity') ?? 'all';
        if (params.get('reviewBlockers') === '1') {
          reviewState.blockersOnly = true;
        }
        const syncReviewFromInputs = () => {
          reviewState.query = (searchInput?.value ?? '').trim().toLowerCase();
          reviewState.category = categorySelect?.value ?? 'all';
          reviewState.severity = severitySelect?.value ?? 'all';
          blockersButton?.setAttribute('aria-pressed', reviewState.blockersOnly ? 'true' : 'false');
        };
        const persistReviewState = () => {
          const next = new URLSearchParams(location.search);
          reviewState.query ? next.set('reviewQuery', reviewState.query) : next.delete('reviewQuery');
          reviewState.category !== 'all'
            ? next.set('reviewCategory', reviewState.category)
            : next.delete('reviewCategory');
          reviewState.severity !== 'all'
            ? next.set('reviewSeverity', reviewState.severity)
            : next.delete('reviewSeverity');
          reviewState.blockersOnly
            ? next.set('reviewBlockers', '1')
            : next.delete('reviewBlockers');
          const query = next.toString();
          history.replaceState(null, '', query ? \`\${location.pathname}?\${query}\${location.hash}\` : \`\${location.pathname}\${location.hash}\`);
        };
        const applyReviewFilters = () => {
          const visibleItems = [];
          for (const node of reviewNodes) {
            const category = node.getAttribute('data-review-category') ?? '';
            const severity = node.getAttribute('data-review-severity') ?? '';
            const search = node.getAttribute('data-review-search') ?? '';
            const matchesQuery = reviewState.query === '' || search.includes(reviewState.query);
            const matchesCategory = reviewState.category === 'all' || category === reviewState.category;
            const matchesSeverity = reviewState.severity === 'all' || severity === reviewState.severity;
            const matchesBlockers = !reviewState.blockersOnly || severity === 'critical';
            const visible = matchesQuery && matchesCategory && matchesSeverity && matchesBlockers;
            node.hidden = !visible;
            if (visible) {
              visibleItems.push({ category, severity });
            }
          }
          if (visibleCountNode) visibleCountNode.textContent = String(visibleItems.length);
          if (criticalCountNode) {
            criticalCountNode.textContent = String(visibleItems.filter(item => item.severity === 'critical').length);
          }
          if (categoryCountNode) {
            categoryCountNode.textContent = String(new Set(visibleItems.map(item => item.category)).size);
          }
          if (emptyState) {
            emptyState.setAttribute('data-visible', visibleItems.length === 0 ? 'true' : 'false');
          }
          persistReviewState();
        };
        syncReviewFromInputs();
        applyReviewFilters();
        searchInput?.addEventListener('input', () => {
          syncReviewFromInputs();
          applyReviewFilters();
        });
        categorySelect?.addEventListener('change', () => {
          syncReviewFromInputs();
          applyReviewFilters();
        });
        severitySelect?.addEventListener('change', () => {
          syncReviewFromInputs();
          applyReviewFilters();
        });
        blockersButton?.addEventListener('click', () => {
          reviewState.blockersOnly = !reviewState.blockersOnly;
          syncReviewFromInputs();
          applyReviewFilters();
        });
        const sections = [...document.querySelectorAll('section[id]')];
        const links = [...document.querySelectorAll('[data-proof-nav]')];
        const setActive = id => {
          for (const link of links) {
            link.setAttribute('aria-current', link.getAttribute('data-proof-nav') === id ? 'true' : 'false');
          }
        };
        const observer = new IntersectionObserver(entries => {
          const visible = entries
            .filter(entry => entry.isIntersecting)
            .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
          if (visible?.target?.id) {
            setActive(visible.target.id);
          }
        }, { rootMargin: '-30% 0px -55% 0px', threshold: [0.15, 0.4, 0.7] });
        for (const section of sections) observer.observe(section);
        setActive(location.hash ? location.hash.slice(1) : 'overview');
      </script>
    </main>
  </body>
</html>`
}
