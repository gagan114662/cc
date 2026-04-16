# CC Repo Entry Guide

This repository is now flat: the repo root is the real code root.

## Start Here

1. Read `ARCHITECTURE.md`.
2. Run `bun run repo:bootstrap` for the quick orientation pass.
3. Run `bun run repo:facts` for filtered counts, dominant directories, and largest source files.
4. Write HTML deep dives and reports as direct children of the repo root.
5. Validate and preview HTML with:
   - `bun run report:check ./your-report.html`
   - `bun run report:open ./your-report.html`
6. When strict deterministic workflow is enabled, the repo adapter lives at `deterministic-harness.adapter.json`.
7. The unattended autoresearch controller is configured by `autoresearch.config.json`, seeded from `autoresearch.seed-corpus.json` and `autoresearch.seed-challenge-set.json`, and persists runtime state under `$CODEX_HOME/autoresearch/`.
8. Honeycomb and Splitter observability guidance lives in `docs/autoresearch-observability.md`.
9. `bun run smoke:honeycomb` emits a real Honeycomb smoke event using local-only telemetry settings from `.claude/settings.local.json`.
10. Real Claude Code session outcomes are recorded through `.claude/hooks/autoresearchSessionObservation.ts`, and `bun run autoresearch:status` summarizes whether mistake tags are shrinking across recent sessions.
11. `bun run honeycomb:verify` checks Honeycomb with a configuration key, and `bun run honeycomb:proof` writes `honeycomb-autoresearch-proof.html` as a front-end proof report.
12. `bun run test:repo` keeps the fast bumper loop, `bun run verify:local`/`verify:ci`/`verify:release` enforce the build-trust harness, changed test files must carry file-level `// test-intent: ...` and `// test-spec: specs/feature.md#section-id` statements, changed source files must kill simple mutation trials, review media is written under `build-trust-artifacts/` as PNG screenshots plus a terminal replay `.cast`, `bun run test:quality:proof` remains as a compatibility alias, and `bun run conductor:doctor` explains whether the repo is ready for Conductor workspaces.

## Instruction Precedence

- `ARCHITECTURE.md` is the canonical pre-read.
- `CLAUDE.md` contains repo-specific workflow and verification rules.
- `AGENTS.md` is the model-agnostic operating summary.
- `project-context.json` is the machine-readable routing file.
- `deterministic-harness.adapter.json` is the machine-readable strict-workflow adapter for the deterministic harness.
- `autoresearch.config.json` is the machine-readable unattended-improvement controller config for benchmark admission, teacher QA, and rollout governance.
- `docs/agent-bumpers.md` is the repo’s playbook for AI-written tests, GitHub PR bumpers, and Conductor setup.
- `.github/copilot-instructions.md` mirrors the same workflow for tools that inspect GitHub-style repo guidance.
- `.claude/settings.json` keeps the HTML report workflow strict for Claude sessions, enables both the deterministic harness and autoresearch dogfood modes, and records `SessionEnd` and `StopFailure` observations for Claude Code sessions.

## HTML Artifact Conventions

- Existing reference artifacts in this directory:
  - `session-transcript.html`
  - `session-review.html`
  - `session-retrospective.html`
- New generated outputs should use unique names like `*-deck.html` or `*-report.html`.
- Every new HTML report should expose a stable `id="overview"` landing section so local previews can deep-link to a predictable starting point.

## Historical Notes

- `archive/launcher-root/` contains launcher-era artifacts kept only for reference.
- Treat the repo root as the active source tree for discovery, metrics, and edits.

## Why This Exists

Fresh sessions were losing time by treating an old nested directory as the code root, running noisy inventory commands, and verifying local HTML through screenshots instead of the direct `file:///...#overview` URL. The docs and scripts here make the correct path obvious from the first minute.
