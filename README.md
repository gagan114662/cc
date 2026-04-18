# CC

CC is a Bun/TypeScript rebuild of the Claude Code CLI for power users and internal teams. It combines interactive coding, MCP and plugin integrations, multi-agent workflows, Conductor workspace readiness checks, and autoresearch guardrails in one terminal product.

## What It Offers

- Interactive coding sessions with print, resume, plan, and agent workflows.
- Team-oriented execution via employee and engineering-lead commands.
- MCP, plugin, and skill loading for local and remote tool integrations.
- Conductor readiness diagnostics for workspace setup and release flow.
- Autoresearch, telemetry, and test-quality checks that keep changes honest.

## Quickstart

1. Run `bun install`.
2. Run `bun run repo:bootstrap` for a short orientation pass.
3. Run `bun run build` to produce `dist/cli.js`.
4. Run `bun ./entrypoints/cli.tsx --help` for the top-level CLI surface.
5. Run `bun run conductor:doctor --repo .` to verify the repo is ready for Conductor workspaces.

Optional native and browser integrations are loaded lazily, so basic startup and `--help` work even when those packages are not installed locally.

## Hosted Harness Quickstart

To run the hosted harness control plane locally instead of the filesystem fallback:

1. Run `./bin/setup_harness_control_plane`.
2. Run `source ./.claude/harness.control-plane.env`.
3. Run `bun ./entrypoints/cli.tsx harness status --json`.

When hosted mode is active, the status payload will report `"controlPlane": { "kind": "postgres-redis" }`.

More detail lives in `docs/harness-control-plane.md`.

For a shared always-on runner setup, use `./bin/setup_shared_harness_control_plane` with real shared Postgres and Redis URLs, then start workers with `./bin/start_shared_harness_daemon`.

For a managed always-on Mac runner, install the launchd workers with `./bin/install_shared_harness_launch_agents`. If you also want Honeycomb export, create `.claude/harness.observability.env` with either `./bin/setup_harness_observability` or `./bin/setup_harness_observability_from_chrome`.

## Repo Entry Guide

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
12. `bun run test:repo` turns tests into agent bumpers, `bun run test:quality:proof` writes `test-quality-proof.html`, and `bun run conductor:doctor` explains whether the repo is ready for Conductor workspaces.

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
