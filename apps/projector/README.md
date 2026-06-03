---
name: Projector
description: >-
  Projects the Contextium methodology into per-tool instruction files (AGENTS.md,
  Cursor, Gemini, Copilot, Windsurf, Cline, Aider) from one source, so they never drift.
category: system
runtime: Manual
---

# apps/projector

Contextium's AI layer (skills, agents, hooks) is built on Claude Code primitives. The *methodology* —
the Loop, the principles, the memory model, the enforcement — is portable to any agent. This app
projects that methodology into the instruction file each tool reads, from a single source.

## Source of truth

- `.claude/templates/methodology.md` — the portable, tool-agnostic working agreement.
- `.claude/rules/*.md` — the 8 principle rules.

Both are assembled into one body and written into each tool's expected file. Edit the source, re-run,
and every tool file updates in lockstep. Nothing is hand-maintained per tool, so nothing drifts.

## Usage

```bash
bash apps/projector/project-rules.sh            # AGENTS.md (the cross-tool default)
bash apps/projector/project-rules.sh all        # every supported tool
bash apps/projector/project-rules.sh cursor gemini
bash apps/projector/project-rules.sh --list     # tools + their target files
```

| Tool | File it reads |
|---|---|
| AGENTS.md (Codex, Cursor, Gemini, Jules, others) | `AGENTS.md` |
| Cursor | `.cursor/rules/contextium.mdc` |
| Gemini CLI | `GEMINI.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Windsurf | `.windsurfrules` |
| Cline | `.clinerules` |
| Aider | `CONVENTIONS.md` |

`AGENTS.md` is committed at the repo root because it is the emerging cross-tool standard and many agents
read it by default. The other files are generated on demand (the installer offers to generate the ones
for tools you use), so the repo root stays uncluttered.

## What ports and what doesn't

| Layer | Other tools get |
|---|---|
| Principles + the Loop + memory model | Full fidelity, via the generated instruction file. |
| Commit-subject + secret-scan enforcement | Full fidelity, via the git hooks in `.githooks/` (tool-agnostic). |
| Skills (`/project` `/implement` `/close`) + review agents | The Loop as a documented procedure. The one-keystroke skills and auto-dispatched sub-reviewers are Claude Code's bonus; other tools run the same steps conversationally. |

This is honest parity: the methodology and enforcement travel everywhere; the turnkey ergonomics are
Claude Code's extra.
