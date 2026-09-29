#!/usr/bin/env bash
# Rows for install-legacy-projection.sh: for every path the v6/v7 projector
# wrote, the regenerated file is byte for byte what that projector wrote from
# the same layer (checked against v7.0.0's own projector when the tag is here);
# a path it never wrote, or a command for a skill the snapshot lacks, has
# nothing to compare against (exit 1).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/install-legacy-projection.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1" >&2; }

# A layer with the shapes the projector handled: an H1 to drop, a nested rule,
# a folded description, a description needing escapes, a body holding ''' (the
# TOML fallback) and one that does not.
A="$TMP/wb/.agents"
mkdir -p "$A/rules/meta" "$A/skills/plain" "$A/skills/quoted"
printf '# Working agreement\n\nBe brief.\n' >"$A/AGENTS.md"
printf '# Voice\n\nPlain words.\n' >"$A/rules/voice.md"
printf '# Nested\n\nA nested rule.\n' >"$A/rules/meta/nested.md"
printf '# Rules\n\nnot a rule\n' >"$A/rules/README.md"
printf -- '---\nname: plain\ndescription: >\n  Does one thing,\n  folded.\n---\n\n# plain\n\nRun it.\n' >"$A/skills/plain/SKILL.md"
printf -- "---\nname: quoted\ndescription: Says \"close\" and a \\\\ path.\n---\n\n# quoted\n\nA body with ''' in it.\n" >"$A/skills/quoted/SKILL.md"

gen() { bash "$SUT" "$A" "$1"; }

want_body='<!-- Generated from .agents/AGENTS.md + .agents/rules/*.md. Do not edit by hand; edit the source in .agents/ and re-run the installer. -->


Be brief.

# Principles

These are the always-on rules, identical in every tool.


A nested rule.


Plain words.
'
if [[ "$(gen GEMINI.md; echo x)" == "${want_body}"$'\n'x ]]; then ok; else bad "GEMINI.md: $(gen GEMINI.md | od -c | head -5)"; fi
if [[ "$(gen .github/copilot-instructions.md)" == "$(gen GEMINI.md)" ]]; then ok; else bad "copilot-instructions.md is GEMINI.md's body"; fi
if [[ "$(gen .cursor/rules/contextium.mdc | head -4)" == $'---\ndescription: Contextium methodology and principles\nalwaysApply: true\n---' ]]; then ok; else bad "the Cursor rule opens with its .mdc frontmatter"; fi
if [[ "$(gen .gemini/commands/plain.toml | head -3)" == $'description = "Does one thing, folded."\nprompt = \'\'\'\n```yaml' ]]; then ok; else bad "a TOML command: $(gen .gemini/commands/plain.toml | head -3)"; fi
if [[ "$(gen .gemini/commands/quoted.toml)" == *'prompt = """'* ]]; then ok; else bad "a body holding ''' falls back to a basic string"; fi
if [[ "$(gen .github/prompts/quoted.prompt.md | sed -n 2p)" == 'description: "Says \"close\" and a \\ path."' ]]; then ok; else bad "a prompt's description is YAML-escaped: $(gen .github/prompts/quoted.prompt.md | sed -n 2p)"; fi

gen .gemini/commands/nosuch.toml >/dev/null 2>&1
if [[ $? -eq 1 ]]; then ok; else bad "a command for a skill the snapshot lacks exits 1"; fi
gen README.md >/dev/null 2>&1
if [[ $? -eq 1 ]]; then ok; else bad "a path the projector never wrote exits 1"; fi

# Against the projector itself, where the v7.0.0 tag is here.
if git -C "$HERE" show v7.0.0:scripts/projector/project-rules.sh >"$TMP/project-rules.sh" 2>/dev/null; then
  for tool in gemini copilot cursor; do
    bash "$TMP/project-rules.sh" "$tool" "$TMP/wb" >/dev/null 2>&1 || bad "v7's projector ran for $tool"
  done
  for rel in GEMINI.md .github/copilot-instructions.md .cursor/rules/contextium.mdc \
    .gemini/commands/plain.toml .gemini/commands/quoted.toml \
    .github/prompts/plain.prompt.md .github/prompts/quoted.prompt.md; do
    if gen "$rel" | cmp -s - "$TMP/wb/$rel"; then ok; else bad "byte for byte what v7 wrote: $rel"; fi
  done
else
  echo "note: no v7.0.0 tag here, so the rows against v7's own projector were skipped" >&2
fi

echo "install-legacy-projection.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
