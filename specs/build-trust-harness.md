# Build Trust Harness

## overview
The build-trust harness exists to block builds that are reproducible but not trustworthy. It treats environment integrity, test quality, changed-line coverage, deterministic replay, and mutation sensitivity as separate gates.

## preflight-integrity
Dependency and runtime verification must fail fast when Bun, the lockfile, or required direct dependencies are missing or unresolved.

## changed-line-coverage
Changed executable lines must meet the configured coverage thresholds, and uncovered changed ranges must be reported explicitly.

## trust-runner
Local verification must include committed and uncommitted worktree changes, classify failures by category, and emit a proof artifact with a stable overview anchor.

## proof-report
The proof artifact must surface blocking causes, command results, coverage gaps, mutation survivors, and risk-triggered suites in reviewer-readable form.
The proof artifact should support browser-side triage with stable filters so a reviewer can narrow findings by search, category, and severity without scanning the full page manually.

## mutation-sensitivity
Changed source code must fail under simple adversarial edits such as flipped booleans or comparison-boundary mutations. Surviving mutants block trust.

## test-quality-bumpers
Changed test files must declare both their intent and the feature spec they protect, and they must avoid circular or trivial assertions.
