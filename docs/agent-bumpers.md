# Agent Bumpers

This repo now treats tests as guardrails for AI changes, not as optional cleanup after the fact.

## What Runs

- `bun run test:repo`
  Runs the repo test suite plus the AI test-quality bumper.
- `bun run verify:local`
  Runs the local hard gate: dependency preflight, typecheck, lint, build, AST test-quality analysis, deterministic replay, changed-line coverage, mutation sensitivity on changed source files, and risk-triggered suites.
- `bun run verify:ci`
  Runs the CI hard gate and writes `build-trust-proof.html`.
- `bun run verify:release`
  Runs the strict release superset of the CI gate, including `smoke:employee`.
- `bun run test:test-quality`
  Fails on suspicious lazy-test patterns such as aliased self-assertions, circular expected values, snapshot-only assertions, single-case overfitting, and fixture answer leakage.
- `bun run test:quality:proof`
  Deprecated compatibility alias that now writes a full trust proof to `test-quality-proof.html`.
- `build-trust-artifacts/*`
  Generated review media from the trust gate: PNG screenshots for quick scanning plus a terminal replay `.cast` artifact.
- `bun run conductor:doctor`
  Checks whether the repo is ready for Conductor. Conductor requires a real GitHub-backed `origin` remote.

## Writing Better AI Tests

Good agent-written tests in this repo should follow these rules:

- Prove behavior, not implementation details.
- In every changed test file, add a file-level `// test-intent: ...` comment that states the user-visible rule the file is proving.
- In every changed test file, add a file-level `// test-spec: specs/feature.md#section-id` comment that points at the feature spec the tests are protecting.
- Add the smallest failing test that reproduces the bug before the fix.
- Add one neighboring or negative case so the agent cannot overfit to a single example.
- Changed feature logic should fail under simple adversarial edits; if a flipped boolean or boundary still passes, the trust gate blocks the build.
- Never compute `expected` values by calling the same logic the test is supposed to validate.
- Never copy the answer straight from fixtures, prompts, or inputs into the assertion.
- Prefer invariants, round trips, and failure-before-success tests when possible.

## GitHub Workflow

Use GitHub as the coordination layer:

1. Open or link an issue for each task.
2. Give each agent a narrow issue or PR scope.
3. Let CI run the bumpers:
   - dependency preflight
   - build trust gate
   - HTML proof artifact upload
4. Review the proof artifact before merging.
   Also review the generated PNG screenshots and terminal replay when you want faster validation than reading raw logs.
5. Keep PRs small enough that one agent can own the full verification loop.

## Conductor Workflow

Conductor treats agent work like a team of developers, but it needs a syncable repo:

- The repo must have a real `origin` remote that points to GitHub.
- A local-only remote such as `gb-local -> .` is not enough.

Typical setup:

```bash
cd "/Users/gaganarora/Desktop/my projects/cc"
bun run conductor:doctor
git remote add origin <github-url>
bun run conductor:doctor
```

After that, Conductor can create workspaces from the default branch and run multiple Claude Code agents in parallel.

## Local Development

This repo is already a fast local Bun CLI project, so Docker Compose and Tilt are not required today. The fast loop here is:

```bash
bun install
bun run repo:bootstrap
bun run verify:local
bun run dev
```

If the repo later grows stateful local dependencies, then adding `docker-compose.yml` and a `Tiltfile` becomes worthwhile. Right now, faking containers would slow the loop down instead of speeding it up.
