# Repo Workflow

This repository is flat. The repo root is the code root for discovery, analysis, and edits.

## Required first steps — ORIENTATION GATE (mandatory, no exceptions)

**You MUST complete all three steps before issuing any Glob, Grep, or broad file search:**

1. Read `ARCHITECTURE.md` — required before any broad discovery or technical deep dive.
2. Run `bun run repo:bootstrap` — required orientation pass, not optional.
3. Run `bun run repo:facts` — required for counts, hotspots, and LOC before ad-hoc inventory.

Skipping any of these steps and going straight to Glob/Grep/find is a policy violation. If you have not completed the orientation gate, stop and do it now.

## Claim-checker — session review policy (mandatory, no exceptions)

**Every claim in a session review or transcript analysis MUST cite a specific tool result as evidence:**

- No "I believe", "it seems", "likely", "probably", or "appears to" — these are unsupported claims.
- If you did not see it in a tool output (Read, Grep, Bash, etc.), you cannot assert it happened.
- Qualifiers like "the agent may have..." without citing a tool result are policy violations.
- Unverified claims that slip through will be flagged as `unsupported_claim_rate > 0` and reject the review.

## Artifact verifier — output validation policy (mandatory, no exceptions)

**Before marking any artifact (HTML report, file, output) as valid or complete:**

1. Run `bun run report:check ./artifact.html` — confirms the file exists and structure is valid.
2. Run `bun run report:open ./artifact.html` — confirms it opens and renders correctly.

Claiming a file was written without running both checks is a verifier bypass (`verifier_bypass_rate > 0`). If the check fails, do not claim success — fix the artifact first.

## Test bumper policy — code changes and bug fixes (mandatory, no exceptions)

**Before claiming a code change is done, the agent must add or update tests that prove the behavior change:**

1. Add the smallest failing test that reproduces the bug or missing behavior.
2. Add at least one neighboring or negative case so the change cannot overfit to a single example.
3. Never compute `expected` values by calling the same logic the test is supposed to verify.
4. Never copy answers directly from fixtures, prompts, or arranged input into the assertion.
5. Run `bun run test:repo`.
6. Run `bun run test:quality:proof` when preparing a shareable proof artifact.

If a test only proves that literals equal themselves, aliases `expected = actual`, or repeats the fixture text in the assertion, it is not a valid bumper.

## Transcript-review reasoning scaffold (required before any session summary)

**Before writing a session review or summary, explicitly work through these three steps:**

1. **What was attempted** — list each goal or sub-task the agent tried.
2. **Evidence for each outcome** — for each attempt, cite the specific tool result that confirms success, failure, or ambiguity.
3. **What is unresolved** — list anything the agent did not verify or that remains uncertain.

Only after completing this scaffold should you write the summary. Skipping the scaffold produces summaries with ungrounded claims.

## Learning-analysis reasoning scaffold (required before regression or comparison analysis)

**When comparing what was learned across sessions or identifying whether mistakes are new or repeated:**

1. **Before state** — cite specific evidence of the behavior or mistake in the prior session.
2. **After state** — cite specific evidence of the behavior in the current session.
3. **What changed** — identify the specific behavior that differs, with evidence for both states.
4. **Causation check** — distinguish: did the behavior change because of a specific fix, or did surface presentation change while root cause persists?

Claiming learning without before/after evidence is a false-learning claim (`false_learning_claim` failure tag).

## Tool budget policy — cost discipline (mandatory)

**Prefer targeted reads over broad searches at all times:**

- After completing the orientation gate, limit Glob/Grep to specific subdirectories — not repo root.
- Read files directly when you know the path; do not Grep for content you could Read.
- Do not repeat tool calls that already returned the needed information.
- Redundant Glob/Grep calls after orientation inflate `token_cost_delta_pct` and `runtime_delta_pct`.
- If a search returns more than needed, narrow the scope — do not just ignore the noise.

## Instruction precedence

- `ARCHITECTURE.md` is the canonical pre-read for technical deep dives, reports, and deck work.
- `README.md`, `AGENTS.md`, and `project-context.json` should all agree with this root-based workflow.
- `archive/launcher-root/` is reference-only and should not be treated as the live source tree.

## Search and output rules

- Broad search from the repo root is valid.
- Prefer `bun run repo:facts` before ad-hoc inventory when you need counts or hotspot summaries.
- HTML reports and decks should be written as direct children of the repo root and validated there with:
  - `bun run report:check ./your-report.html`
  - `bun run report:open ./your-report.html`
- New HTML reports should include `id="overview"`.
- Prefer the direct `file:///...#overview` preview flow over screenshot tooling for the first verification pass.
