#!/usr/bin/env bash
# Boundary rows for project-rules.sh: each tool's output from Agent Skills
# frontmatter (a plain description, a quoted one, a folded one), the nested
# rules, the stale-command prune, and the links Claude Code and Codex get.
# Fixtures are a throwaway target; the script runs as a subprocess.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/project-rules.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1" >&2; }
has() { if grep -qF -- "$3" "$2" 2>/dev/null; then ok; else bad "$1 — $2 lacks: $3"; fi; }
hasnt() { if grep -qF -- "$3" "$2" 2>/dev/null; then bad "$1 — $2 should not contain: $3"; else ok; fi; }

T="$TMP/target"
mkdir -p "$T/.agents/rules/meta" "$T/.agents/skills/alpha" "$T/.agents/skills/beta" "$T/.agents/reviewers"
printf '# AGENTS.md\n\nThe working agreement.\n' >"$T/.agents/AGENTS.md"
printf -- '---\npaths: null\n---\n\n# Voice\n\n## voice\nBe plain. [2026-01-01]\n' >"$T/.agents/rules/voice.md"
printf -- '---\npaths: null\n---\n\n# Meta\n\n## nested-rule\nNested. [2026-01-01]\n' >"$T/.agents/rules/meta/nested.md"
cat >"$T/.agents/skills/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: Does one thing. Use when the user says "wrap up: now". Takes [x].
allowed-tools: Bash Read
metadata:
  peers: ".agents/skills/alpha/scripts/a.sh"
---

# alpha

Body with a regex \d+ and a backslash.
EOF
cat >"$T/.agents/skills/beta/SKILL.md" <<'EOF'
---
name: beta
description: >
  Folded over
  two lines.
---

# beta
EOF

run() { bash "$SCRIPT" "$@" >"$TMP/out" 2>&1; }

# ── gemini ───────────────────────────────────────────────────────────────
mkdir -p "$T/.gemini/commands"
# shellcheck disable=SC2016  # the backticks are file content, not an expansion
printf 'description = "x"\nprompt = """\n```yaml\n# skill definition\n```\n"""\n' >"$T/.gemini/commands/gone.toml"
printf 'description = "mine"\nprompt = "my own command"\n' >"$T/.gemini/commands/mine.toml"
run gemini "$T" || bad "gemini run exited non-zero: $(cat "$TMP/out")"
has "gemini instructions carry AGENTS.md" "$T/GEMINI.md" "The working agreement."
has "gemini instructions carry a nested rule" "$T/GEMINI.md" "## nested-rule"
has "gemini description, quotes escaped" "$T/.gemini/commands/alpha.toml" 'description = "Does one thing. Use when the user says \"wrap up: now\". Takes [x]."'
has "gemini prompt fences the frontmatter" "$T/.gemini/commands/alpha.toml" "# skill definition"
has "gemini prompt keeps metadata.peers" "$T/.gemini/commands/alpha.toml" 'peers: ".agents/skills/alpha/scripts/a.sh"'
has "gemini prompt is a literal string, backslashes intact" "$T/.gemini/commands/alpha.toml" 'regex \d+'
has "a folded description is one line" "$T/.gemini/commands/beta.toml" 'description = "Folded over two lines."'
if [[ ! -e "$T/.gemini/commands/gone.toml" ]]; then ok; else bad "a generated command for a deleted skill is pruned"; fi
if [[ -e "$T/.gemini/commands/mine.toml" ]]; then ok; else bad "a hand-written command is left alone"; fi

# ── copilot ──────────────────────────────────────────────────────────────
run copilot "$T" || bad "copilot run exited non-zero: $(cat "$TMP/out")"
has "copilot instructions" "$T/.github/copilot-instructions.md" "## voice"
has "copilot prompt description is quoted YAML" "$T/.github/prompts/alpha.prompt.md" 'description: "Does one thing. Use when the user says \"wrap up: now\". Takes [x]."'
has "copilot prompt carries the body" "$T/.github/prompts/alpha.prompt.md" "# alpha"

# ── cursor ───────────────────────────────────────────────────────────────
run cursor "$T" || bad "cursor run exited non-zero: $(cat "$TMP/out")"
has "cursor rules always apply" "$T/.cursor/rules/contextium.mdc" "alwaysApply: true"
if [[ -L "$T/.cursor/commands/alpha.md" && "$(readlink "$T/.cursor/commands/alpha.md")" == "../../.agents/skills/alpha/SKILL.md" ]]; then ok; else bad "cursor command is a link to the SKILL.md"; fi

# ── claude and codex: links only, no template folder ─────────────────────
run claude "$T" || bad "claude run exited non-zero: $(cat "$TMP/out")"
for l in skills rules agents; do
  if [[ -L "$T/.claude/$l" ]]; then ok; else bad ".claude/$l is a link"; fi
done
if [[ ! -e "$T/.claude/templates" && ! -L "$T/.claude/templates" ]]; then ok; else bad "no .claude/templates link is made"; fi
run codex "$T" || bad "codex run exited non-zero"
if [[ "$(readlink "$T/.codex/skills")" == "../.agents/skills" ]]; then ok; else bad ".codex/skills links to .agents/skills"; fi

# ── errors ───────────────────────────────────────────────────────────────
if run nope "$T"; then bad "an unknown tool is refused"; else ok; fi
hasnt "the refusal names no tool it wrote" "$TMP/out" "[projector] wrote"
if run gemini "$TMP/empty"; then bad "a target without .agents/ is refused"; else ok; fi
has "…and says what is missing" "$TMP/out" "AGENTS.md"

echo "project-rules.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
