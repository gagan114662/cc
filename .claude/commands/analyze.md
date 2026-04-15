---
name: analyze
description: Deep technical analysis of this codebase → HTML slide deck or report. Use for architecture reviews, technical presentations, and codebase walkthroughs.
---

## Procedure (follow exactly)

**Step 1 — Orient (1 Read call)**
Read `ARCHITECTURE.md`. This gives you the full directory map, key dependencies, startup sequence, and architectural patterns. You do NOT need to run `find`, `ls`, or `cat package.json` — all that information is already there.

**Step 2 — Scope agreement (1 question)**
Before any further exploration, ask:
> "I'll cover all major subsystems (~20 slides) for a technical audience. Want me to adjust scope or focus on specific areas?"

Wait for the user's answer. Default if no response: all subsystems, technical audience, ~20 slides.

**Step 3 — Targeted exploration**
Use only `Glob` and `Read` tools. Read the specific files relevant to the agreed scope. Maximum 8–10 targeted file reads. Do NOT `ls` parent directories.

**Step 4 — Save research**
Write all findings to `research-findings.md` before touching the output HTML file. This protects the context window for the writing phase.

**Step 5 — Write the deck**
Before writing `analysis-deck.html` (or any output file):
- Check if it already exists: `ls analysis-deck.html`
- If **yes**: `Read` at least 1 line first, then `Write`
- If **no**: `Write` directly

**Step 6 — Deliver**
Open the file in browser: `open analysis-deck.html`

---

## Tool Rules (mandatory for this command)
- `Glob` not `find`/`ls` for file discovery
- `Read` not `cat`/`head` for file contents
- `Grep` not `grep`/`rg` for content search
- Never explore `/my projects/` or any parent directory
