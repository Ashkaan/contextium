#!/usr/bin/env bash
# Boundary rows for check-harness-config-links.sh: every link correct, a link
# replaced by a plain file, a dangling link, a real directory, a home that does
# not exist, --fix, and NEGATIVE manifest fixtures.
#
# Hermetic — a fresh `mktemp -d` per case, with HARNESS_LINKS_HOME and
# HARNESS_LINKS_REPO standing in for the real ones, so nothing here reads or
# writes a live profile.
#
# The negative fixtures are the point of the suite, not an extra. A gate that
# only ever sees a correct tree proves nothing: the two failures worth catching
# are a manifest whose scripts are all present behind a matcher that never fires
# them, and a Codex manifest that quietly grew a second top-level key, which
# makes Codex ignore the whole file in silence.

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-harness-config-links.sh"
[[ -f "$SCRIPT" ]] || { echo "FAIL: gate not found at $SCRIPT" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

check() {             # <label> <want-rc> <got-rc>
  if [[ "$2" == "$3" ]]; then
    pass=$((pass + 1)); echo "ok: $1"
  else
    fail=$((fail + 1)); echo "FAIL: $1 — wanted rc=$2, got rc=$3" >&2
  fi
}

says() {              # <label> <needle> <output>
  if printf '%s' "$3" | grep -qF -- "$2"; then
    pass=$((pass + 1)); echo "ok: $1"
  else
    fail=$((fail + 1))
    echo "FAIL: $1 — output never mentions '$2'" >&2
    printf '%s\n' "$3" | sed 's/^/      /' >&2
  fi
}

# The gate matches a handler by the SCRIPT its command names, so the fixture
# carries the bare path.
INFRA_CMD='bash .agents/hooks/check-host-infra-safety.sh'
WRITE_CMD='bash .agents/hooks/check-shared-checkout-write.sh'

claude_manifest() {   # <file> [write-matcher]
  jq -n --arg i "$INFRA_CMD" --arg w "$WRITE_CMD" \
    --arg m "${2:-Edit|Write|MultiEdit|NotebookEdit|apply_patch|write|search_replace}" '{hooks: {PreToolUse: [
      {matcher: "Bash|run_terminal_command", hooks: [{type: "command", command: $i}, {type: "command", command: $w}]},
      {matcher: $m, hooks: [{type: "command", command: $w}]}]}}' >"$1"
}

# A complete, correct sandbox. Every later case starts here and breaks ONE
# thing, so a failure names the break rather than the scaffolding.
mkfix() {             # prints the sandbox root
  # mktemp, not a counter: this runs inside a command substitution, so a
  # counter incremented here would never reach the parent shell.
  local root h r
  root="$(mktemp -d "$TMP/caseXXXXXX")"
  h="$root/home"; r="$root/repo"
  mkdir -p "$h/.claude" "$h/.agents" "$h/.codex" "$h/.gemini/config" "$h/.grok/hooks" \
    "$r/.agents/skills/close" "$r/.agents/agents" "$r/.agents/hooks" "$r/.gemini" \
    "$r/.agents/output-styles"
  claude_manifest "$h/.claude/settings.json"
  claude_manifest "$r/.agents/hooks/claude-hooks.json"
  jq -n --arg i "$INFRA_CMD" --arg w "$WRITE_CMD" '{context: {fileName: ["AGENTS.md"]}, hooks: {BeforeTool: [
      {matcher: "run_shell_command", hooks: [{type: "command", command: $i}, {type: "command", command: $w}]},
      {matcher: "write_file|replace", hooks: [{type: "command", command: $w}]}]}}' >"$r/.agents/gemini-settings.json"
  ln -s ../.agents/gemini-settings.json "$r/.gemini/settings.json"
  jq -n --arg k "$r" '{($k): "TRUST_FOLDER"}' >"$h/.gemini/trustedFolders.json"
  ln -s "$r/.agents/hooks/claude-hooks.json" "$h/.grok/hooks/contextium.json"
  jq -n --arg i "bash hooks/check-host-infra-safety.sh" --arg w "bash hooks/check-shared-checkout-write.sh" '{
    "host-infra-safety": {PreToolUse: [{matcher: "run_command", hooks: [{type: "command", command: $i}]}]},
    "shared-checkout-write": {PreToolUse: [{matcher: "run_command|write_to_file|replace_file_content", hooks: [{type: "command", command: $w}]}]}}' \
    >"$r/.agents/hooks.json"
  ln -s "$r/.agents/hooks/claude-hooks.json" "$h/.codex/hooks.json"
  ln -s "$r/.agents/skills" "$h/.agents/skills"
  ln -s "$r/.agents/agents" "$h/.claude/agents"
  ln -s "$r/.agents/output-styles" "$h/.claude/output-styles"
  ln -s "$h/.agents/skills" "$h/.claude/skills"
  ln -s "$h/.agents/skills" "$h/.gemini/config/skills"
  printf '%s\n' "$root"
}

run() {               # <root> [args] — sets OUT and RC
  OUT="$(HARNESS_LINKS_HOME="$1/home" HARNESS_LINKS_REPO="$1/repo" bash "$SCRIPT" "${@:2}" 2>&1)"
  RC=$?
}

# ── Links ─────────────────────────────────────────────────────────────────
F="$(mkfix)"; run "$F"
check "a correct tree passes" 0 "$RC"
says "…and counts what it checked" "OK — 8 links verified, 5 manifests carry the required hooks" "$OUT"

F="$(mkfix)"; rm "$F/home/.claude/skills"; echo '# copy' >"$F/home/.claude/skills"; run "$F"
check "a link replaced by a plain file" 1 "$RC"
says "…is named as a regular file" "is a regular file, not a symlink" "$OUT"

F="$(mkfix)"; rm "$F/home/.agents/skills"; ln -s "$F/repo/nowhere" "$F/home/.agents/skills"; run "$F"
check "a link pointing somewhere else" 1 "$RC"
says "…names where it points" "points at $F/repo/nowhere" "$OUT"

F="$(mkfix)"; rm -r "$F/repo/.agents/agents"; run "$F"
check "a dangling link" 1 "$RC"
says "…is named dangling" "DANGLING" "$OUT"

# A wired Gemini CLI that does not trust the workbench loads none of it.
F="$(mkfix)"; echo '{}' >"$F/home/.gemini/trustedFolders.json"; run "$F"
check "Gemini CLI not trusting the workbench is not ready" 1 "$RC"
says "…and says so" "does not trust" "$OUT"
F="$(mkfix)"; jq -n --arg k "$F/repo" '{($k): "DO_NOT_TRUST"}' >"$F/home/.gemini/trustedFolders.json"; run "$F"
check "an entry that says anything but TRUST_FOLDER is not trust" 1 "$RC"
says "…and says so" "does not trust" "$OUT"
F="$(mkfix)"; rm "$F/home/.gemini/config/skills"; run "$F"
check "a missing link" 1 "$RC"
says "…is named missing" "is missing" "$OUT"

F="$(mkfix)"; rm "$F/home/.claude/skills"; mkdir "$F/home/.claude/skills"; run "$F"
check "a real directory at a link path" 1 "$RC"
says "…is named a real directory" "is a real directory" "$OUT"

F="$(mkfix)"; rm -r "$F/home/.gemini"; run "$F"
check "a home that does not exist is not drift" 0 "$RC"
says "…and is counted as skipped" "(1 skipped: no such home)" "$OUT"

# ── --fix ─────────────────────────────────────────────────────────────────
F="$(mkfix)"; rm "$F/home/.claude/skills"; echo '# machine-written' >"$F/home/.claude/skills"; run "$F" --fix
check "--fix relinks a clobbered link" 0 "$RC"
says "…keeping the displaced file" "kept the displaced file at $F/home/.claude/skills.pre-link" "$OUT"
check "…whose content survives" 0 "$(grep -q machine-written "$F/home/.claude/skills.pre-link"; echo $?)"
check "…and the link is right afterwards" 0 "$(run "$F"; echo "$RC")"

F="$(mkfix)"; echo first >"$F/home/.claude/skills.pre-link"; rm "$F/home/.claude/skills"; echo second >"$F/home/.claude/skills"; run "$F" --fix
check "a second --fix never overwrites an earlier .pre-link" 0 "$(grep -q first "$F/home/.claude/skills.pre-link"; echo $?)"

F="$(mkfix)"; rm "$F/home/.agents/skills"; ln -s "$F/repo/wrong" "$F/home/.agents/skills"; run "$F" --fix
check "--fix repoints a link that points elsewhere" 0 "$RC"
says "…to the workbench" "$F/repo/.agents/skills" "$(readlink "$F/home/.agents/skills")"

F="$(mkfix)"; rm "$F/home/.claude/skills"; mkdir "$F/home/.claude/skills"; run "$F" --fix
check "--fix refuses a real directory" 1 "$RC"
says "…and says to move it aside" "it is a real directory" "$OUT"

F="$(mkfix)"; rm -r "$F/repo/.agents/agents"; rm "$F/home/.claude/agents"; run "$F" --fix
check "--fix refuses a target that does not exist" 1 "$RC"
says "…and says why" "its target does not exist" "$OUT"

# ── Manifests (negative fixtures) ─────────────────────────────────────────
F="$(mkfix)"; claude_manifest "$F/home/.claude/settings.json" "Edit|MultiEdit"; run "$F"
check "a Claude manifest whose matcher misses Write" 1 "$RC"
says "…names the tool" "does not route Write to check-shared-checkout-write.sh" "$OUT"

F="$(mkfix)"; jq 'del(.hooks.PreToolUse[0].hooks[0])' "$F/repo/.agents/hooks/claude-hooks.json" >"$F/x" && mv "$F/x" "$F/repo/.agents/hooks/claude-hooks.json"; run "$F"
check "the workbench manifest lost the infra guard" 1 "$RC"
says "…and Codex, which links to it, is named" "Codex manifest does not route Bash to check-host-infra-safety.sh" "$OUT"

F="$(mkfix)"; jq '. + {skillOverrides: {}}' "$F/repo/.agents/hooks/claude-hooks.json" >"$F/x" && mv "$F/x" "$F/repo/.agents/hooks/claude-hooks.json"; run "$F"
check "a Codex manifest with an extra top-level key" 1 "$RC"
says "…is refused for what Codex does with it" "carries top-level key(s) besides hooks: skillOverrides" "$OUT"

F="$(mkfix)"; jq 'del(.["shared-checkout-write"])' "$F/repo/.agents/hooks.json" >"$F/x" && mv "$F/x" "$F/repo/.agents/hooks.json"; run "$F"
check "an Antigravity manifest without the write guard" 1 "$RC"
says "…names a tool it no longer guards" "Antigravity manifest does not route write_to_file" "$OUT"

# With a tools= record, a tool it does not name is not wired here: its links
# and guards are not asked for. One it names still is.
F="$(mkfix)"; printf 'harness=codex\nagent=codex\ntools=codex grok\n' >"$F/repo/.agents/harness"
rm "$F/home/.claude/skills" "$F/home/.claude/agents" "$F/home/.claude/output-styles" "$F/home/.gemini/config/skills"
printf '{}\n' >"$F/home/.claude/settings.json"; run "$F"
check "tools= without claude or antigravity: their links and guards are not asked for" 0 "$RC"
F="$(mkfix)"; printf 'harness=claude\nagent=claude\ntools=claude\n' >"$F/repo/.agents/harness"
rm "$F/home/.claude/agents"; run "$F"
check "tools= naming claude still asks for its links" 1 "$RC"

# A tool tools= does not name: a kept (customized) manifest or a foreign link
# of it is not checked, since the installer no longer wires that tool.
F="$(mkfix)"; printf 'harness=claude\nagent=claude\ntools=claude codex gemini\n' >"$F/repo/.agents/harness"
echo '{"mine": true}' >"$F/repo/.agents/hooks.json"
rm "$F/home/.gemini/config/skills" "$F/home/.grok/hooks/contextium.json"; ln -s "$F/repo/elsewhere.json" "$F/home/.grok/hooks/contextium.json"
run "$F"
check "a dropped Antigravity's kept manifest and a foreign Grok link are not asked about" 0 "$RC"

F="$(mkfix)"; rm "$F/repo/.agents/hooks.json"; run "$F"
check "no Antigravity manifest is a workbench that does not use Antigravity, not drift" 0 "$RC"

F="$(mkfix)"; claude_manifest "$F/repo/.agents/hooks/claude-hooks.json" "Edit|Write|MultiEdit|NotebookEdit|apply_patch"; run "$F"
check "the workbench manifest without Grok's write tools" 1 "$RC"
says "…names Grok's tool" "Grok Build manifest does not route write to check-shared-checkout-write.sh" "$OUT"

F="$(mkfix)"; jq 'del(.hooks.BeforeTool[1])' "$F/repo/.agents/gemini-settings.json" >"$F/x" && mv "$F/x" "$F/repo/.agents/gemini-settings.json"; run "$F"
check "a Gemini settings file without the write guard" 1 "$RC"
says "…names the tool" "Gemini CLI manifest does not route write_file to check-shared-checkout-write.sh" "$OUT"

F="$(mkfix)"; rm "$F/home/.grok/hooks/contextium.json"; run "$F"
check "a harness that was not wired has no link, and that is not drift" 0 "$RC"

F="$(mkfix)"; rm "$F/home/.claude/output-styles"; mkdir "$F/home/.claude/output-styles"; run "$F"
check "a real ~/.claude/output-styles where the link goes" 1 "$RC"
says "…is named" "output-styles is a real directory" "$OUT"

F="$(mkfix)"; rm "$F/home/.grok/hooks/contextium.json"; ln -s "$F/repo/elsewhere.json" "$F/home/.grok/hooks/contextium.json"; run "$F"
check "a Grok hooks link that points elsewhere" 1 "$RC"
says "…is named" "contextium.json points at $F/repo/elsewhere.json" "$OUT"

F="$(mkfix)"; rm "$F/repo/.gemini/settings.json"; echo '{}' >"$F/repo/.gemini/settings.json"; run "$F"
check "a real .gemini/settings.json where the link goes" 1 "$RC"
says "…is named a regular file" ".gemini/settings.json is a regular file" "$OUT"

F="$(mkfix)"; printf '{not json' >"$F/home/.claude/settings.json"; run "$F"
check "an unreadable manifest" 1 "$RC"
says "…says so" "is not readable JSON" "$OUT"

F="$(mkfix)"; rm -r "$F/home/.codex"; run "$F"
check "no ~/.codex means no Codex manifest to check" 0 "$RC"

run "$(mkfix)" --bogus
check "an unknown flag" 1 "$RC"

echo ""
if [[ "$fail" -gt 0 ]]; then
  echo "FAIL — $fail of $((pass + fail)) assertions failed"
  exit 1
fi
echo "PASS — $pass assertions, 0 failed"
