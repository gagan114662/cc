# Repository Routing Instructions

This repository is flat. The repo root is the active code root.

## Required workflow

1. Read `ARCHITECTURE.md` first.
2. Run `bun run repo:bootstrap` for the standard orientation pass.
3. Use `bun run repo:facts` for counts and hotspots.

## HTML report workflow

- Write new HTML reports and decks as direct children of the repo root.
- Include `id="overview"` in new HTML reports.
- Validate with `bun run report:check ./file.html`.
- Preview with `bun run report:open ./file.html`.

## Test and PR bumpers

- Use `bun run test:repo` before claiming a code change is complete.
- Use `bun run test:test-quality` to catch suspicious lazy-test patterns.
- Prefer tests that prove behavior changes, not tests that copy the answer from fixtures or compute the expected value with the same logic under test.
- Use `bun run test:quality:proof` when you need a human-readable HTML proof artifact.
- Use `bun run conductor:doctor` before trying to add the repo to Conductor.

## Avoid these mistakes

- Do not treat `archive/launcher-root/` as active source.
- Do not let generated or recovery artifacts skew analysis.
- Do not use screenshot tooling as the first verification path for local HTML.
