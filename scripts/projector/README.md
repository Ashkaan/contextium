# projector

Wires each supported tool to the one canonical copy of the layer, which lives in
the installed project's `.agents/` directory. Nothing is duplicated: a tool that
reads the same file format gets a symlink into `.agents/`, and only the two whose
format genuinely differs get a generated file.

The installer calls this once per tool you select, after it has written
`.agents/`.

## Source of truth

Everything is read from the target project's `.agents/`, not from this repo — so
what a tool sees is exactly what is on disk, including any edits you made after
installing.

| Source | Contents |
|---|---|
| `.agents/AGENTS.md` | the working agreement (the Loop, SPEC, memory, working style), already personalized |
| `.agents/rules/*.md` | the principle rules |
| `.agents/skills/*/SKILL.md` | the Loop and its reviewers — these ARE the commands |

## Output

| Tool | Instructions file | Commands |
|---|---|---|
| claude | `.claude/CLAUDE.md` (imports `.agents/AGENTS.md`) | `.claude/skills` → `.agents/skills` (symlink) |
| codex | `AGENTS.md` → `.agents/AGENTS.md` (symlink) | `.codex/skills` → `.agents/skills` (symlink) |
| cursor | `.cursor/rules/contextium.mdc` (generated) | `.cursor/commands/<name>.md` → each `SKILL.md` (symlink) |
| gemini | `GEMINI.md` (generated) | `.gemini/commands/<name>.toml` (generated) |
| copilot | `.github/copilot-instructions.md` (generated) | `.github/prompts/<name>.prompt.md` (generated) |

Claude Code additionally gets `.claude/rules` and `.claude/agents` symlinked into
`.agents/`, so every path a skill cites resolves under either name.

The generated command files carry the whole `SKILL.md`, its frontmatter fenced as
a YAML block rather than dropped, so Gemini and Copilot run the same procedure
the symlinked tools do. The command's own description is the skill's
`description:`, read from the Agent Skills frontmatter.

## Usage

```bash
bash scripts/projector/project-rules.sh <tool> <target_dir>   # wire one tool
bash scripts/projector/project-rules.sh --list                # list tools + their targets
```

Re-runnable: symlinks are recreated and generated files rewritten every time. A
real directory found where a symlink belongs — the shape an upgrade from the
older copy-everything layout leaves behind — is moved aside as `<name>.pre-agents`
rather than deleted, because it may hold skills you wrote yourself.
