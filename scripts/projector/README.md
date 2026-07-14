# projector

Projects the Contextium methodology, rules, and Loop commands into each supported
tool's native config from one portable source, so they never drift.

The installer calls this for every non-Claude tool you select. Claude Code is not
handled here (the installer copies `templates/claude/` into a real `.claude/`
directly).

## Source of truth

| Source | Contents |
|---|---|
| `templates/methodology.md` | the portable working agreement (the Loop, SPEC, memory, working style) |
| `templates/claude/rules/*.md` | the principle rules, shared verbatim with the Claude layer |
| `templates/commands/*.md` | the Loop commands, frontmatter `name` + `description` then the body |

## Output

| Tool | Instructions file | Commands |
|---|---|---|
| gemini | `GEMINI.md` | `.gemini/commands/<name>.toml` |
| codex | `AGENTS.md` | `.codex/skills/<name>/SKILL.md` |
| cursor | `.cursor/rules/contextium.mdc` | `.cursor/commands/<name>.md` |
| copilot | `.github/copilot-instructions.md` | `.github/prompts/<name>.prompt.md` |

## Usage

```bash
bash scripts/projector/project-rules.sh <tool> <target_dir>   # write one tool's files
bash scripts/projector/project-rules.sh --list                # list tools + their targets
```

Re-runnable: regenerates from the current source every time. Edit a source file,
re-run, and every tool's config updates in lockstep.
