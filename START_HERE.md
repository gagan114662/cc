# Start Here

If you are a coding agent starting in `/Users/gaganarora/Desktop/my projects/cc`, you are already at the code root.

## First steps

1. Read `ARCHITECTURE.md`.
2. Run `bun run repo:bootstrap`.
3. Use `bun run repo:facts` before ad-hoc inventory.

## Important rules

- Broad search belongs at the repo root.
- New HTML reports and decks belong directly in the repo root.
- New HTML reports should include `id="overview"`.
- Validate with `bun run report:check ./your-report.html`.
- Preview with `bun run report:open ./your-report.html`.
- Historical launcher-only artifacts live in `archive/launcher-root/`.

## Why this exists

Prior agent sessions lost time by treating a nested folder as the real code root, miscounting generated artifacts, and verifying local HTML with screenshots instead of the direct `file:///...#overview` path.
