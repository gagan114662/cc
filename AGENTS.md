# Agent Operating Guide

Use this file to route into the correct workflow quickly.

## Canonical roots

- Code root: repo root
- Pre-read document: `ARCHITECTURE.md`
- Repo-specific instructions: `CLAUDE.md`

## Required operating rules

- Treat the repo root as the analysis root.
- Read `ARCHITECTURE.md` before broad exploration, hotspot analysis, or HTML deck/report work.
- Prefer `bun run repo:facts` over hand-rolled shell inventory for counts, hotspots, and LOC.
- Use direct local HTML preview, not screenshot-first verification.
- Treat `archive/launcher-root/` as historical context, not active source.

## HTML report rules

- Write new reports and decks as direct children of the repo root.
- Use unique names like `topic-deck.html` or `topic-report.html`.
- Include an `id="overview"` landing section.
- Validate with `bun run report:check ./your-file.html`.
- Preview with `bun run report:open ./your-file.html`.

## Existing reference artifacts

- `session-transcript.html`
- `session-review.html`
- `session-retrospective.html`

Read those before overwriting anything with the same name.
