#!/usr/bin/env bash
# Rows for install.sh: the harness question and what each answer wires (home
# links, hook merges, per-tool settings), the offer to install a missing tool,
# the Claude Code version floor, the upgrades from v6 and v7 (what they left
# behind is removed only when it is still ours), the AGENTS.md block merge,
# decisions/README.md seeding, and tests left out of the install. Each row
# installs into a fresh temp target, with a HOME of its own, laid out the way
# the row needs.
#
# Tools are stubbed on PATH ($STUB first, then only /usr/bin:/bin), and HOME is a
# temp dir, so nothing real is detected or installed: `curl` is a stub that logs
# the URL it was asked for. jq must be installed (the hook merge needs it). The v6 SPEC template and the v7 installer come from
# this repo's v6.0.0 and v7.0.0 tags, so run it from a clone that has its tags.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STUB="$TMP/stub"
mkdir -p "$STUB" "$TMP/home"
export HOME="$TMP/home"
# The running bash's own folder too: scripts that call `bash` by name must find it
# where it is (/usr/local/bin in a container), not only in /bin.
BASH_DIR="$(dirname "$BASH")"
export PATH="$STUB:$BASH_DIR:/usr/bin:/bin"
CURL_LOG="$TMP/curl.log"
: >"$CURL_LOG"
# A curl that installs nothing: it logs the URL and hands the shell a no-op.
# shellcheck disable=SC2016  # the $-expressions belong to the stub
printf '#!/bin/sh\nfor a in "$@"; do case "$a" in http*) echo "$a" >>"%s" ;; esac; done\necho "echo stub-installed"\n' "$CURL_LOG" >"$STUB/curl"
chmod +x "$STUB/curl"
# gh: logs every `repo create` it is asked for, and is logged in only while
# $TMP/gh-authed exists.
GH_LOG="$TMP/gh.log"
: >"$GH_LOG"
# shellcheck disable=SC2016  # the $-expressions belong to the stub
printf '#!/bin/sh
case "$1 $2" in
  "auth status") [ -e "%s" ] ;;
  "repo create") echo "$*" >>"%s" ;;
  *) exit 1 ;;
esac
' "$TMP/gh-authed" "$GH_LOG" >"$STUB/gh"
chmod +x "$STUB/gh"
# A git identity for the first commit the installer makes in a new workbench.
export GIT_AUTHOR_NAME="Pat Doe" GIT_AUTHOR_EMAIL="pat@example.com" GIT_COMMITTER_NAME="Pat Doe" GIT_COMMITTER_EMAIL="pat@example.com"
# stub_claude <version> — a claude that reports that version.
stub_claude() { printf '#!/bin/sh\necho "%s (Claude Code)"\n' "$1" >"$STUB/claude"; chmod +x "$STUB/claude"; }

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1" >&2; }

# The v6 SPEC template and a v7 checkout come from the tags. A run with no
# repository around it (a container) can hand them in instead:
#   CONTEXTIUM_V6_SPEC_LEAN=<file>  CONTEXTIUM_V7_SRC=<extracted v7.0.0 tree>
V6_LEAN="$TMP/v6-spec-lean.md"
if [ -n "${CONTEXTIUM_V6_SPEC_LEAN:-}" ]; then
  cp "$CONTEXTIUM_V6_SPEC_LEAN" "$V6_LEAN"
elif ! git -C "$HERE" show v6.0.0:templates/agents/templates/spec-lean.md >"$V6_LEAN" 2>/dev/null; then
  echo "FAIL: cannot read v6.0.0:templates/agents/templates/spec-lean.md — run from a clone with its tags" >&2
  exit 1
fi

n=0
# v6target — a target with a v6 layer's leftovers. Sets T.
v6target() {
  n=$((n + 1))
  T="$TMP/t$n"
  export HOME="$TMP/h$n"
  mkdir -p "$HOME"
  mkdir -p "$T/.agents/templates" "$T/.claude"
  cp "$V6_LEAN" "$T/.agents/templates/spec-lean.md"
  ln -s ../.agents/templates "$T/.claude/templates"
}
install() { "$BASH" "$HERE/install.sh" "$T" --yes --no-integrations >"$TMP/out" 2>&1; }

# ── the v6 SPEC template ─────────────────────────────────────────────────
v6target
install || bad "install into a v6 target exited non-zero: $(tail -5 "$TMP/out")"
if [[ ! -e "$T/.agents/templates" ]]; then ok; else bad "an untouched v6 spec-lean.md is removed with its folder"; fi
if [[ ! -e "$T/.claude/templates" && ! -L "$T/.claude/templates" ]]; then ok; else bad "our .claude/templates link is removed"; fi

v6target
echo "My own section." >>"$T/.agents/templates/spec-lean.md"
install || bad "install over an edited spec-lean.md exited non-zero"
if [[ ! -e "$T/.agents/templates/spec-lean.md" ]]; then ok; else bad "an edited spec-lean.md is moved out of the way"; fi
if grep -q "My own section." "$T/.agents/templates/spec-lean.md.pre-v7" 2>/dev/null; then ok; else bad "the edited copy is kept as spec-lean.md.pre-v7"; fi
if grep -q "spec-lean.md.pre-v7" "$TMP/out"; then ok; else bad "the install says where the edited copy went"; fi

v6target
echo "An earlier rescue." >"$T/.agents/templates/spec-lean.md.pre-v7"
echo "A later edit." >>"$T/.agents/templates/spec-lean.md"
install || bad "install over a second edited spec-lean.md exited non-zero"
if [[ "$(cat "$T/.agents/templates/spec-lean.md.pre-v7")" == "An earlier rescue." ]]; then ok; else bad "an existing spec-lean.md.pre-v7 is never overwritten"; fi
if grep -q "A later edit." "$T/.agents/templates/spec-lean.md.pre-v7.2" 2>/dev/null; then ok; else bad "the second rescue takes the next free name, spec-lean.md.pre-v7.2"; fi
if grep -q "spec-lean.md.pre-v7.2" "$TMP/out"; then ok; else bad "the install names the file it actually wrote"; fi

v6target
rm "$T/.claude/templates"
ln -s ../my-templates "$T/.claude/templates"
install || bad "install with a user's own .claude/templates link exited non-zero"
if [[ "$(readlink "$T/.claude/templates")" == "../my-templates" ]]; then ok; else bad "a .claude/templates link that is not ours is left alone"; fi

# ── decisions/README.md ──────────────────────────────────────────────────
v6target
mkdir -p "$T/decisions"
printf -- '---\nstatus: proposed\ndate: 2026-01-10\ndecision-makers: Pat Doe\n---\n# x\n' >"$T/decisions/0001-x.md"
install || bad "install with a decisions/ lacking its README exited non-zero"
if grep -q "^# Decision records" "$T/decisions/README.md" 2>/dev/null; then ok; else bad "a missing decisions/README.md is seeded into an existing folder"; fi
if [[ -f "$T/decisions/0001-x.md" ]]; then ok; else bad "the user's record is untouched"; fi

echo "# Our own decision rules" >"$T/decisions/README.md"
install || bad "re-install exited non-zero"
if [[ "$(cat "$T/decisions/README.md")" == "# Our own decision rules" ]]; then ok; else bad "an existing decisions/README.md is never overwritten"; fi

# ── v8: the harness question and what each answer wires ──────────────────
# fresh <args...> — install into a new empty target with a HOME of its own.
# Sets T and H; output in $TMP/out.
fresh() {
  n=$((n + 1))
  T="$TMP/t$n"
  H="$TMP/h$n"
  mkdir -p "$T" "$H"
  export HOME="$H"
  git -C "$T" init -q
  "$BASH" "$HERE/install.sh" "$T" --yes --no-integrations "$@" >"$TMP/out" 2>&1
}
is() { if [[ "$2" == "$3" ]]; then ok; else bad "$1 — want [$3] got [$2]"; fi; }
has_out() { if grep -qF -- "$2" "$TMP/out"; then ok; else bad "$1 — output lacks: $2"; fi; }
lacks_out() { if grep -qF -- "$2" "$TMP/out"; then bad "$1 — output should not contain: $2"; else ok; fi; }
gone() { if [[ ! -e "$T/$2" && ! -L "$T/$2" ]]; then ok; else bad "$1 — $2 is still there"; fi; }
there() { if [[ -e "$T/$2" || -L "$T/$2" ]]; then ok; else bad "$1 — $2 is missing"; fi; }
guards_in() { jq -r '[.hooks.PreToolUse[]?.hooks[]?.command | select(startswith(": contextium;"))] | length' "$1" 2>/dev/null; }

fresh || bad "default install exited non-zero: $(tail -5 "$TMP/out")"
is "no answer means T3 Code running Claude Code" "$(cat "$T/.agents/harness")" "harness=t3
agent=claude
tools=t3 claude"
is "the home .agents/skills links to the workbench" "$(readlink "$H/.agents/skills")" "$T/.agents/skills"
is "the home .claude/skills links to the home .agents/skills" "$(readlink "$H/.claude/skills")" "$H/.agents/skills"
is "the home .claude/agents links to the workbench's agents" "$(readlink "$H/.claude/agents")" "$T/.agents/agents"
is "the home .claude/output-styles links to the workbench's, where /author writes them" "$(readlink "$H/.claude/output-styles")" "$T/.agents/output-styles"
if [[ -d "$T/.agents/output-styles" ]]; then ok; else bad "…which exists"; fi
if git -C "$T" rev-parse -q --verify HEAD >/dev/null; then bad "an existing git repo gets no commit from the installer"; else ok; fi
has_out "with no origin, it says land.sh will refuse" "land.sh will refuse"
is "the guards are merged into ~/.claude/settings.json" "$(guards_in "$H/.claude/settings.json")" "3"
if grep -qF "$T/.agents/hooks/check-shared-checkout-write.sh" "$H/.claude/settings.json"; then ok; else bad "…naming this workbench's hook path"; fi
gone "no in-repo .claude/" .claude
gone "no .githooks/" .githooks
gone "Antigravity's manifest ships only when Antigravity is picked" .agents/hooks.json
gone "…and Gemini CLI's settings only when Gemini CLI is" .agents/gemini-settings.json
if [[ ! -e "$H/.claude/settings.json.pre-contextium" ]]; then ok; else bad "no backup of a Claude settings file that did not exist before the install"; fi
if grep -q "__WORKBENCH__" "$T/.agents/hooks/claude-hooks.json" || ! grep -qF "$T/.agents/hooks/" "$T/.agents/hooks/claude-hooks.json"; then bad "the hook manifest is rendered in place, naming the workbench"; else ok; fi
gone "…and there is no second rendered copy" .agents/codex-hooks.json
if [[ ! -e "$H/.grok" ]]; then ok; else bad "Grok Build, not picked, gets no ~/.grok"; fi
lacks_out "…and the check at the end finds nothing wrong" "not right yet"
for f in .agents/checks/check-skills.sh .agents/checks/check-decision-records.sh .agents/checks/check-standards-refs.sh .agents/checks/check-secrets.sh .agents/checks/check-harness-config-links.sh .agents/hooks/check-host-infra-safety.sh .agents/hooks/check-shared-checkout-write.sh; do
  there "the layer carries $f" "$f"
done
is "no test or fixture is installed" "$(find "$T/.agents" \( -name '*.test.*' -o -name tests -o -name fixtures -o -name evals \) | head -3)" ""
gone "no rules folder" .agents/rules
for f in GEMINI.md .gemini .codex .cursor .github; do gone "no generated copy for another tool" "$f"; done
is "AGENTS.md is the link" "$(readlink "$T/AGENTS.md")" ".agents/AGENTS.md"
is "five Contextium blocks" "$(grep -c '^<!-- contextium:[a-z-]* -->$' "$T/.agents/AGENTS.md")" "5"
if grep -qxF ".claude/worktrees/" "$T/.gitignore" && grep -qxF ".gemini/worktrees/" "$T/.gitignore"; then ok; else bad ".gitignore keeps both worktree roots out"; fi
has_out "the links and manifests are checked at the end" "links verified"
if grep -q "^## Manifest" "$T/integrations/README.md" 2>/dev/null; then ok; else bad "integrations/README.md carries the manifest schema the check enforces"; fi
there "the integration-manifest check land.sh runs is installed" .agents/checks/check-integration-manifest.sh
has_out "a missing T3 Code gets its install command" "curl -fsSL https://t3.codes/install.sh | sh"
is "…but --yes installs nothing" "$(cat "$CURL_LOG")" ""

"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations >"$TMP/out" 2>&1
is "a re-run adds no second copy of the .gitignore lines" "$(grep -cxF ".claude/worktrees/" "$T/.gitignore")" "1"
is "…and no second copy of the guards" "$(guards_in "$H/.claude/settings.json")" "3"

# Claude Code settings of the user's own: kept, merged into, backed up once.
n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H/.claude"; export HOME="$H"
jq -n '{theme: "dark", hooks: {PreToolUse: [{matcher: "Bash", hooks: [{type: "command", command: "bash ~/mine.sh"}]}], Stop: [{hooks: [{type: "command", command: "echo done"}]}]}}' >"$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$TMP/mine.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
is "the user's settings keys stay" "$(jq -r .theme "$H/.claude/settings.json")" "dark"
is "…and their own PreToolUse hook" "$(jq -r '[.hooks.PreToolUse[].hooks[].command | select(. == "bash ~/mine.sh")] | length' "$H/.claude/settings.json")" "1"
is "…and their Stop hook" "$(jq -r '.hooks.Stop[0].hooks[0].command' "$H/.claude/settings.json")" "echo done"
is "…with the guards added" "$(guards_in "$H/.claude/settings.json")" "3"
if cmp -s "$H/.claude/settings.json.pre-contextium" "$TMP/mine.json"; then ok; else bad "the first merge keeps the original beside it"; fi

# A user hook of their own, in the file the installer merges and never writes.
jq -n '{hooks: {PreToolUse: [{matcher: "Bash", hooks: [{type: "command", command: "bash ~/audit.sh"}]}], PostToolUse: [{matcher: "Write", hooks: [{type: "command", command: "bash ~/after.sh"}]}]}}' >"$T/.agents/user-hooks.json"
cp "$T/.agents/user-hooks.json" "$TMP/user-hooks.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
is "a user hook reaches Claude Code's settings" "$(jq -r '[.hooks.PreToolUse[].hooks[].command | select(. == ": contextium; bash ~/audit.sh")] | length' "$H/.claude/settings.json")" "1"
is "…and the workbench manifest Codex and Grok Build link to" "$(jq -r '[.hooks.PreToolUse[].hooks[].command | select(. == ": contextium; bash ~/audit.sh")] | length' "$T/.agents/hooks/claude-hooks.json")" "1"
if cmp -s "$T/.agents/user-hooks.json" "$TMP/user-hooks.json"; then ok; else bad "the user's hook file is never rewritten"; fi
after_in() { jq -r '[.hooks.PostToolUse[]?.hooks[]?.command | select(. == ": contextium; bash ~/after.sh")] | length' "$1" 2>/dev/null; }
is "a user hook on another event (PostToolUse) reaches the workbench manifest" "$(after_in "$T/.agents/hooks/claude-hooks.json")" "1"
is "…and Claude Code's settings" "$(after_in "$H/.claude/settings.json")" "1"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
is "…once, after a re-run" "$(after_in "$H/.claude/settings.json")" "1"
printf '{"hooks": ' >"$T/.agents/user-hooks.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
has_out "a user-hooks.json that is not JSON is said" "user-hooks.json is not valid JSON"
is "…and the last good manifest keeps their hook" "$(jq -r '[.hooks.PreToolUse[].hooks[].command | select(. == ": contextium; bash ~/audit.sh")] | length' "$T/.agents/hooks/claude-hooks.json")" "1"
is "…and so do Claude Code's settings" "$(jq -r '[.hooks.PreToolUse[].hooks[].command | select(. == ": contextium; bash ~/audit.sh")] | length' "$H/.claude/settings.json")" "1"
if grep -q "__WORKBENCH__" "$T/.agents/hooks/claude-hooks.json"; then bad "…rendered, not the raw template"; else ok; fi

# ── a re-run refreshes only what Contextium ships ────────────────────────
fresh --harness claude
mkdir -p "$T/.agents/skills/mine"
echo "# mine" >"$T/.agents/skills/mine/SKILL.md"
for d in agents hooks checks generators output-styles; do echo "mine" >"$T/.agents/$d/mine.md"; done
echo "stray" >"$T/.agents/skills/close/stray.md"
echo "edited" >>"$T/.agents/skills/close/SKILL.md"
# Two skills an earlier release shipped and this one does not, recorded as shipped.
for x in retired retired-edited; do
  mkdir -p "$T/.agents/skills/$x"
  echo "old" >"$T/.agents/skills/$x/SKILL.md"
  printf '%s\t%s\n' ".agents/skills/$x/SKILL.md" "$(cksum <"$T/.agents/skills/$x/SKILL.md" | awk '{print $1, $2}')" >>"$T/.agents/skills/.contextium-manifest"
done
echo "mine" >>"$T/.agents/skills/retired-edited/SKILL.md"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
there "a skill the user added survives a re-run" .agents/skills/mine/SKILL.md
for d in agents hooks checks generators output-styles; do there "…and a file of theirs in .agents/$d/" ".agents/$d/mine.md"; done
gone "a shipped skill is replaced whole" .agents/skills/close/stray.md
if cmp -s "$T/.agents/skills/close/SKILL.md" "$HERE/templates/agents/skills/close/SKILL.md"; then ok; else bad "…its edited file put back"; fi
gone "a skill an earlier release shipped, unchanged, is removed" .agents/skills/retired
there "…one the user changed stays" .agents/skills/retired-edited/SKILL.md
has_out "…and is named" "kept .agents/skills/retired-edited"
if grep -qF ".agents/skills/close/SKILL.md	" "$T/.agents/skills/.contextium-manifest"; then ok; else bad "the manifest records what this release shipped"; fi
if grep -qF "retired" "$T/.agents/skills/.contextium-manifest"; then bad "…and no longer what it does not"; else ok; fi
if grep -qxF ".agents/hooks/claude-hooks.json	$(cksum <"$T/.agents/hooks/claude-hooks.json" | awk '{print $1, $2}')" "$T/.agents/hooks/.contextium-manifest"; then ok; else bad "…the hook manifest as rendered"; fi

# ── git and an origin ────────────────────────────────────────────────────
touch "$TMP/gh-authed"
n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H"; export HOME="$H"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations >"$TMP/out" 2>&1
is "a target that is not a git repo is made one, on main" "$(git -C "$T" symbolic-ref --short HEAD 2>/dev/null)" "main"
is "…with the installed tree as its first commit" "$(git -C "$T" rev-list --count HEAD 2>/dev/null)" "1"
is "…leaving nothing out" "$(git -C "$T" status --porcelain 2>/dev/null)" ""
has_out "…and, with no origin, it says land.sh will refuse" "land.sh will refuse"
is "--yes never creates a remote, even with gh logged in" "$(cat "$GH_LOG")" ""

n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H"; export HOME="$H"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true \
  env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
  "$BASH" "$HERE/install.sh" "$T" --yes --no-integrations >"$TMP/out" 2>&1
is "with no git identity the install still finishes" "$?" "0"
if git -C "$T" rev-parse -q --verify HEAD >/dev/null; then bad "…without a commit"; else ok; fi
has_out "…and says how to make the first commit" "git config --global user.email"

# A real folder where a home link goes: moved aside, never deleted.
n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H/.claude/skills/mine"; export HOME="$H"
echo keep >"$H/.claude/skills/mine/SKILL.md"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
is "a real ~/.claude/skills is moved aside" "$(cat "$H/.claude/skills.pre-link/mine/SKILL.md" 2>/dev/null)" "keep"
is "…the link takes its place" "$(readlink "$H/.claude/skills")" "$H/.agents/skills"
has_out "…and it is said" "moved your $H/.claude/skills aside"

fresh --harness codex
is "Codex" "$(cat "$T/.agents/harness")" "harness=codex
agent=codex
tools=codex"
is "the home .codex/hooks.json links to the workbench's manifest" "$(readlink "$H/.codex/hooks.json")" "$T/.agents/hooks/claude-hooks.json"
is "…which carries only hooks and a description (Codex drops anything more)" "$(jq -r 'keys | join(",")' "$T/.agents/hooks/claude-hooks.json")" "description,hooks"
lacks_out "…and the check at the end finds nothing wrong" "not right yet"
has_out "…and the one-time hook trust is said" "hook-trust prompt"
gone "no .codex in the workbench" .codex

# Upgrading from the layout that rendered a separate .agents/codex-hooks.json:
# the stale copy goes and a Codex link to it follows the manifest, even on a
# run that did not pick Codex (a link left dangling runs no guard at all).
cp "$T/.agents/hooks/claude-hooks.json" "$T/.agents/codex-hooks.json"
rm "$H/.codex/hooks.json"; ln -s "$T/.agents/codex-hooks.json" "$H/.codex/hooks.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
gone "the old rendered Codex manifest is removed" .agents/codex-hooks.json
is "…and Codex's link follows the manifest" "$(readlink "$H/.codex/hooks.json")" "$T/.agents/hooks/claude-hooks.json"

# Claude Code installed but not among the tools: it is not wired (a tool is
# wired only while tools= names it, so a --drop-tool sticks), and the check at
# the end does not ask for its links or guards.
n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H/.claude"; export HOME="$H"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness codex >"$TMP/out" 2>&1
if [[ ! -e "$H/.claude/settings.json" && ! -L "$H/.claude/skills" ]]; then ok; else bad "an installed Claude Code not among the tools is left alone"; fi
lacks_out "…and the check at the end finds nothing wrong" "not right yet"
has_out "…and the install says it is ready" "ready in"

# A check that fails at the end is not a ready install.
n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H/.claude"; export HOME="$H"
printf '{not json' >"$H/.claude/settings.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
has_out "settings that are not JSON fail the check at the end" "not right yet"
lacks_out "…and the install does not call itself ready" "ready in"
has_out "…but says it installed, and what to fix" "installed in"

# Without jq: linking needs none, so Codex still gets its hooks file.
NOJQ="$TMP/nojq"
mkdir -p "$NOJQ"
for f in /usr/bin/* /bin/*; do case "${f##*/}" in jq) ;; *) [ -e "$NOJQ/${f##*/}" ] || ln -s "$f" "$NOJQ/${f##*/}" ;; esac; done
ln -sf "$BASH" "$NOJQ/bash"   # the running bash, wherever it lives; BASH_DIR may be /usr/bin, which has jq
n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H"; export HOME="$H"
PATH="$STUB:$NOJQ" "$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness codex >"$TMP/out" 2>&1
is "without jq, Codex's hooks file is still linked" "$(readlink "$H/.codex/hooks.json")" "$T/.agents/hooks/claude-hooks.json"
has_out "…and the missing jq is said" "jq is not installed"

n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H/.codex"; export HOME="$H"
jq -n '{hooks: {PreToolUse: [{matcher: "shell", hooks: [{type: "command", command: "bash ~/codex-mine.sh"}]}]}}' >"$H/.codex/hooks.json"
mkdir -p "$T/.agents"
jq -n '{hooks: {Stop: [{hooks: [{type: "command", command: "bash ~/stop.sh"}]}]}}' >"$T/.agents/user-hooks.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness codex >"$TMP/out" 2>&1
if [[ ! -L "$H/.codex/hooks.json" ]]; then ok; else bad "a Codex hooks file of the user's is not replaced by a link"; fi
is "…their hook stays" "$(jq -r '[.hooks.PreToolUse[].hooks[].command | select(. == "bash ~/codex-mine.sh")] | length' "$H/.codex/hooks.json")" "1"
is "…and the guards are merged in" "$(guards_in "$H/.codex/hooks.json")" "3"
is "…with a user hook on another event (Stop)" "$(jq -r '[.hooks.Stop[]?.hooks[]?.command | select(. == ": contextium; bash ~/stop.sh")] | length' "$H/.codex/hooks.json")" "1"

fresh --harness gemini
is "Gemini CLI's settings are a link to the workbench's" "$(readlink "$T/.gemini/settings.json")" "../.agents/gemini-settings.json"
is "…which point it at AGENTS.md" "$(jq -c .context.fileName "$T/.gemini/settings.json")" '["AGENTS.md"]'
is "…and carry the guards under BeforeTool" "$(jq -r '[.hooks.BeforeTool[]?.hooks[]?.command | select(startswith(": contextium;"))] | length' "$T/.gemini/settings.json")" "3"
if grep -q "__WORKBENCH__" "$T/.agents/gemini-settings.json" || ! grep -qF "$T/.agents/hooks/" "$T/.agents/gemini-settings.json"; then bad "…rendered with the workbench's path"; else ok; fi
is "…and its agent is gemini" "$(sed -n 's/^agent=//p' "$T/.agents/harness")" "gemini"
lacks_out "…and the check at the end finds nothing wrong" "not right yet"

jq -n --arg w "bash ~/gem-mine.sh" '{ui: {theme: "mine"}, context: {fileName: ["GEMINI.md"]}, hooks: {BeforeTool: [{matcher: "run_shell_command", hooks: [{type: "command", command: $w}]}]}}' >"$T/.gemini/settings.json.real"
rm "$T/.gemini/settings.json"; mv "$T/.gemini/settings.json.real" "$T/.gemini/settings.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness gemini >"$TMP/out" 2>&1
is "a .gemini/settings.json of the user's becomes .agents/user-gemini-settings.json" "$(jq -r .ui.theme "$T/.agents/user-gemini-settings.json" 2>/dev/null)" "mine"
is "…the link takes its place" "$(readlink "$T/.gemini/settings.json")" "../.agents/gemini-settings.json"
is "…and their settings stay active, merged into what it links to" "$(jq -r .ui.theme "$T/.gemini/settings.json")" "mine"
is "…their context file beside AGENTS.md" "$(jq -c .context.fileName "$T/.gemini/settings.json")" '["AGENTS.md","GEMINI.md"]'
is "…their hook beside the guards" "$(jq -r '[.hooks.BeforeTool[].hooks[].command] | map(select(. == "bash ~/gem-mine.sh" or startswith(": contextium;"))) | length' "$T/.gemini/settings.json")" "4"
has_out "…and where they live now is said" "user-gemini-settings.json"
cp "$T/.agents/user-gemini-settings.json" "$TMP/gem-user.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness gemini >"$TMP/out" 2>&1
if cmp -s "$T/.agents/user-gemini-settings.json" "$TMP/gem-user.json"; then ok; else bad "a re-run never rewrites user-gemini-settings.json"; fi
is "…and merges it again, once" "$(jq -r '[.hooks.BeforeTool[].hooks[].command | select(. == "bash ~/gem-mine.sh")] | length' "$T/.gemini/settings.json")" "1"
printf '{"ui": ' >"$T/.agents/user-gemini-settings.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness gemini >"$TMP/out" 2>&1
has_out "a user-gemini-settings.json that is not JSON is said" "user-gemini-settings.json is not valid JSON"
is "…and the last good settings stay in force" "$(jq -r .ui.theme "$T/.gemini/settings.json")" "mine"
rm "$T/.agents/user-gemini-settings.json"

printf '{"context":{"fileName":["AGENTS.md"]}}\n' >"$T/.gemini/settings.json.real"
rm -f "$T/.gemini/settings.json"; mv "$T/.gemini/settings.json.real" "$T/.gemini/settings.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness gemini >"$TMP/out" 2>&1
is "the one-line settings an earlier v8 wrote are replaced by the link" "$(readlink "$T/.gemini/settings.json")" "../.agents/gemini-settings.json"
gone "…with nothing kept of them" .agents/user-gemini-settings.json

fresh --harness grok
is "Grok Build's hooks link to the workbench manifest" "$(readlink "$H/.grok/hooks/contextium.json")" "$T/.agents/hooks/claude-hooks.json"
is "…which routes Grok's own tool names" "$(jq -r '[.hooks.PreToolUse[] | select(.matcher | test("run_terminal_command")) | .hooks[]] | length' "$H/.grok/hooks/contextium.json")" "2"
lacks_out "…and the check at the end finds nothing wrong" "not right yet"

fresh --harness antigravity
is "Antigravity reads the skills through ~/.gemini/config/skills" "$(readlink "$H/.gemini/config/skills")" "$H/.agents/skills"
there "…and its manifest is in the workbench" .agents/hooks.json
lacks_out "…and the check at the end finds nothing wrong" "not right yet"
# Every tool the workbench has wired stays wired: a re-run adds to the set in
# .agents/harness (tools=), and a tool leaves only with --drop-tool.
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
there "a re-run for another tool keeps Antigravity's manifest" .agents/hooks.json
is "…and records both tools" "$(sed -n 's/^tools=//p' "$T/.agents/harness")" "antigravity claude"
lacks_out "…and the check at the end finds nothing wrong" "not right yet"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool antigravity >"$TMP/out" 2>&1
gone "--drop-tool antigravity removes its untouched manifest" .agents/hooks.json
is "…and it leaves the record" "$(sed -n 's/^tools=//p' "$T/.agents/harness")" "claude"
lacks_out "…and the check at the end finds nothing wrong" "not right yet"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness antigravity >"$TMP/out" 2>&1
echo '{"mine": true}' >"$T/.agents/hooks.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool antigravity >"$TMP/out" 2>&1
there "…but keeps one the user changed" .agents/hooks.json
has_out "…and says so" "kept .agents/hooks.json"

fresh --harness gemini
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
there "a re-run for another tool keeps Gemini CLI's settings" .agents/gemini-settings.json
is "…and the .gemini/settings.json link to them" "$(readlink "$T/.gemini/settings.json")" "../.agents/gemini-settings.json"
lacks_out "…and the check at the end finds nothing wrong" "not right yet"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool gemini >"$TMP/out" 2>&1
gone "--drop-tool gemini removes its untouched settings" .agents/gemini-settings.json
gone "…and the .gemini/settings.json link to them" .gemini/settings.json
lacks_out "…and the check at the end finds nothing wrong" "not right yet"

# ── --drop-tool undoes that tool's home wiring, and only what is ours ────
fresh --harness claude
jq '. + {theme: "dark"}' "$H/.claude/settings.json" >"$TMP/s.json" && cp "$TMP/s.json" "$H/.claude/settings.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness codex --drop-tool claude >"$TMP/out" 2>&1
is "--drop-tool claude strips the guards merged into ~/.claude/settings.json" "$(guards_in "$H/.claude/settings.json")" "0"
is "…keeping the rest of the file" "$(jq -r .theme "$H/.claude/settings.json")" "dark"
for l in skills agents output-styles; do
  if [[ ! -e "$H/.claude/$l" && ! -L "$H/.claude/$l" ]]; then ok; else bad "…and removes the ~/.claude/$l link into this workbench"; fi
done
is "…and leaves the record" "$(sed -n 's/^tools=//p' "$T/.agents/harness")" "codex"
lacks_out "…and the check at the end finds nothing wrong" "not right yet"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness codex >"$TMP/out" 2>&1
is "a dropped tool stays dropped on the next run" "$(guards_in "$H/.claude/settings.json")" "0"

fresh --harness grok
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool grok >"$TMP/out" 2>&1
if [[ ! -L "$H/.grok/hooks/contextium.json" ]]; then ok; else bad "--drop-tool grok removes our ~/.grok/hooks/contextium.json"; fi
fresh --harness grok
rm "$H/.grok/hooks/contextium.json"; ln -s "$TMP/elsewhere.json" "$H/.grok/hooks/contextium.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool grok >"$TMP/out" 2>&1
is "…but not a link that points somewhere else" "$(readlink "$H/.grok/hooks/contextium.json")" "$TMP/elsewhere.json"

fresh --harness codex
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool codex >"$TMP/out" 2>&1
if [[ ! -e "$H/.codex/hooks.json" && ! -L "$H/.codex/hooks.json" ]]; then ok; else bad "--drop-tool codex removes our ~/.codex/hooks.json link"; fi
n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H/.codex"; export HOME="$H"
jq -n '{hooks: {PreToolUse: [{matcher: "shell", hooks: [{type: "command", command: "bash ~/codex-mine.sh"}]}]}}' >"$H/.codex/hooks.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness codex >"$TMP/out" 2>&1
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool codex >"$TMP/out" 2>&1
is "…and strips the guards merged into a Codex hooks file of the user's" "$(guards_in "$H/.codex/hooks.json")" "0"
is "…keeping their own hook" "$(jq -r '[.hooks.PreToolUse[].hooks[].command | select(. == "bash ~/codex-mine.sh")] | length' "$H/.codex/hooks.json")" "1"

fresh --harness antigravity
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool antigravity >"$TMP/out" 2>&1
if [[ ! -L "$H/.gemini/config/skills" ]]; then ok; else bad "--drop-tool antigravity removes the ~/.gemini/config/skills link"; fi
lacks_out "…and the check at the end finds nothing wrong" "not right yet"

# A v8 workbench from before tools= was recorded: the set is read off disk.
fresh --harness gemini
sed -i.bak '/^tools=/d' "$T/.agents/harness" && rm -f "$T/.agents/harness.bak"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
there "with no tools= line, the Gemini CLI files on disk count as wired" .agents/gemini-settings.json
is "…and the set is recorded from then on" "$(sed -n 's/^tools=//p' "$T/.agents/harness")" "gemini claude"

# A v8.0.0 workbench shipped both per-harness files for every tool, so their
# presence proves nothing: only a link, or harness=, says a tool was wired.
fresh --harness claude
cp "$HERE/templates/agents/hooks.json" "$T/.agents/hooks.json"
sed "s|__WORKBENCH__|$T|g" "$HERE/templates/agents/gemini-settings.json" >"$T/.agents/gemini-settings.json"
sed -i.bak '/^tools=/d' "$T/.agents/harness" && rm -f "$T/.agents/harness.bak"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
is "with no tools= line, shipped-for-everyone files do not count as wired" "$(sed -n 's/^tools=//p' "$T/.agents/harness")" "claude"
gone "…so the untouched Antigravity manifest goes" .agents/hooks.json
gone "…and the untouched Gemini CLI settings (as rendered for this workbench) go" .agents/gemini-settings.json

# A customized file kept after --drop-tool is the user's from then on.
fresh --harness antigravity
echo '{"mine": true}' >"$T/.agents/hooks.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool antigravity >"$TMP/out" 2>&1
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
is "a kept customized manifest survives the runs after the drop" "$(cat "$T/.agents/hooks.json" 2>/dev/null)" '{"mine": true}'

fresh --harness gemini
jq '. + {ui: {theme: "mine"}}' "$T/.agents/gemini-settings.json" >"$TMP/g.json" && cp "$TMP/g.json" "$T/.agents/gemini-settings.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool gemini >"$TMP/out" 2>&1
there "dropping Gemini CLI keeps customized settings" .agents/gemini-settings.json
if [[ ! -L "$T/.gemini/settings.json" ]]; then ok; else bad "…but takes away the .gemini/settings.json link, so Gemini CLI no longer loads them"; fi

# Codex linked by the layout before .agents/hooks/claude-hooks.json.
fresh --harness codex
cp "$T/.agents/hooks/claude-hooks.json" "$T/.agents/codex-hooks.json"
rm "$H/.codex/hooks.json"; ln -s "$T/.agents/codex-hooks.json" "$H/.codex/hooks.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool codex >"$TMP/out" 2>&1
if [[ ! -e "$H/.codex/hooks.json" && ! -L "$H/.codex/hooks.json" ]]; then ok; else bad "--drop-tool codex removes a link to the older .agents/codex-hooks.json too"; fi

# The harness you drive the workbench with cannot be dropped in the same run.
fresh --harness gemini
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --drop-tool gemini >"$TMP/out" 2>&1
is "dropping the harness itself is refused" "$?" "1"
has_out "…with how to pick another" "--harness"
there "…and nothing is removed" .agents/gemini-settings.json
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool bogus >"$TMP/out" 2>&1
is "an unknown --drop-tool name is refused" "$?" "1"

# Gemini CLI reads .gemini/settings.json (AGENTS.md, the guards) only in a
# trusted folder, so wiring it trusts the workbench — and dropping it takes back
# only the entry the installer added.
n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H/.gemini"; export HOME="$H"
git -C "$T" init -q
echo '{"/somewhere/else": "TRUST_FOLDER"}' >"$H/.gemini/trustedFolders.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness gemini >"$TMP/out" 2>&1
is "wiring Gemini CLI trusts the workbench folder" "$(jq -r --arg k "$T" '.[$k]' "$H/.gemini/trustedFolders.json")" "TRUST_FOLDER"
is "…keeping the folders already trusted" "$(jq -r '.["/somewhere/else"]' "$H/.gemini/trustedFolders.json")" "TRUST_FOLDER"
has_out "the closing message says trust gates AGENTS.md and the guards" "AGENTS.md and the guards"
has_out "…and names the variable headless runs need" "GEMINI_CLI_TRUST_WORKSPACE=true"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool gemini >"$TMP/out" 2>&1
is "--drop-tool gemini takes back the entry the installer added" "$(jq -r --arg k "$T" '.[$k] // "none"' "$H/.gemini/trustedFolders.json")" "none"
is "…and only that one" "$(jq -r '.["/somewhere/else"]' "$H/.gemini/trustedFolders.json")" "TRUST_FOLDER"

n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H/.gemini"; export HOME="$H"
git -C "$T" init -q
jq -n --arg k "$T" '{($k): "TRUST_FOLDER"}' >"$H/.gemini/trustedFolders.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness gemini >"$TMP/out" 2>&1
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude --drop-tool gemini >"$TMP/out" 2>&1
is "a folder the user had trusted before the install stays trusted after the drop" "$(jq -r --arg k "$T" '.[$k]' "$H/.gemini/trustedFolders.json")" "TRUST_FOLDER"

# An entry the user set to something else is left alone — and the install is
# not called ready, because Gemini CLI then loads none of the workbench.
n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H/.gemini"; export HOME="$H"
git -C "$T" init -q
jq -n --arg k "$T" '{($k): "DO_NOT_TRUST"}' >"$H/.gemini/trustedFolders.json"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness gemini >"$TMP/out" 2>&1
is "a user's DO_NOT_TRUST entry is left as it is" "$(jq -r --arg k "$T" '.[$k]' "$H/.gemini/trustedFolders.json")" "DO_NOT_TRUST"
has_out "…the conflict is named" 'not "TRUST_FOLDER"'
has_out "…and the install is not called ready" "not ready"

n=$((n + 1)); T="$TMP/t$n"; H="$TMP/h$n"; mkdir -p "$T" "$H"; export HOME="$H"
git -C "$T" init -q
PATH="$STUB:$NOJQ" "$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness gemini >"$TMP/out" 2>&1
has_out "without jq, the exact trustedFolders.json line is printed" "\"$T\": \"TRUST_FOLDER\""

fresh --harness vscode
is "VS Code's agent is copilot" "$(sed -n 's/^agent=//p' "$T/.agents/harness")" "copilot"
has_out "VS Code has no one-line install, so it says where to get it" "code.visualstudio.com/download"

fresh --harness t3 --agents codex
is "T3 Code running Codex" "$(cat "$T/.agents/harness")" "harness=t3
agent=codex
tools=t3 codex"
if [[ ! -e "$H/.claude" ]]; then ok; else bad "…touches no ~/.claude"; fi
is "…and links Codex's hooks" "$(readlink "$H/.codex/hooks.json")" "$T/.agents/hooks/claude-hooks.json"

fresh --tools "claude gemini"
is "--tools: the first is the harness" "$(sed -n 's/^harness=//p' "$T/.agents/harness")" "claude"
there "…and each named tool is wired" .gemini/settings.json
is "…Claude Code too" "$(readlink "$H/.claude/skills")" "$H/.agents/skills"

fresh --all-tools
is "--all-tools wires Claude Code" "$(guards_in "$H/.claude/settings.json")" "3"
is "--all-tools links Antigravity's skills folder" "$(readlink "$H/.gemini/config/skills" 2>/dev/null)" "$H/.agents/skills"
is "…and Gemini CLI" "$(readlink "$T/.gemini/settings.json")" "../.agents/gemini-settings.json"
is "…and Grok Build" "$(readlink "$H/.grok/hooks/contextium.json")" "$T/.agents/hooks/claude-hooks.json"
is "…and Codex" "$(readlink "$H/.codex/hooks.json")" "$T/.agents/hooks/claude-hooks.json"
there "…and Antigravity" .agents/hooks.json
lacks_out "…and the check at the end finds nothing wrong" "not right yet"

fresh --tools copilot
is "--tools copilot is VS Code" "$(sed -n 's/^harness=//p' "$T/.agents/harness")" "vscode"

fresh --harness bogus
is "an unknown harness is refused" "$?" "1"

n=$((n + 1)); H="$TMP/h$n"; mkdir -p "$H"; export HOME="$H"
"$BASH" "$HERE/install.sh" --yes --no-integrations --harness codex >"$TMP/out" 2>&1
if [[ -f "$H/code/workbench/.agents/AGENTS.md" ]]; then ok; else bad "with no target, the workbench is ~/code/workbench"; fi

# ── installing what is missing ───────────────────────────────────────────
: >"$CURL_LOG"
fresh --harness grok
is "--yes alone never installs" "$(cat "$CURL_LOG")" ""
has_out "…and prints the command" "curl -fsSL https://x.ai/cli/install.sh | bash"
fresh --harness grok --install-missing
is "--install-missing runs the vendor's installer" "$(cat "$CURL_LOG")" "https://x.ai/cli/install.sh"
has_out "…and says the tool is still not on PATH" "not on your PATH yet"

# ── the interview, answered on stdin ─────────────────────────────────────
: >"$CURL_LOG"
n=$((n + 1)); T="$TMP/t$n"; mkdir -p "$T" "$TMP/h$n"; export HOME="$TMP/h$n"
printf '8\ny\nPat Doe\n2\n\nn\n' | CONTEXTIUM_PROMPT_STDIN=1 "$BASH" "$HERE/install.sh" "$T" >"$TMP/out" 2>&1
has_out "the harness is the first question" "Which tool will you drive this repo with?"
is "the eighth tool is Grok Build" "$(sed -n 's/^harness=//p' "$T/.agents/harness")" "grok"
is "a yes to the offer installs it" "$(cat "$CURL_LOG")" "https://x.ai/cli/install.sh"
if grep -q "working agreement for Pat Doe's workbench" "$T/.agents/AGENTS.md"; then ok; else bad "the name answer lands in AGENTS.md"; fi
if grep -q "Act and report on routine work" "$T/.agents/AGENTS.md"; then ok; else bad "the autonomy answer lands in AGENTS.md"; fi
has_out "Grok is told to trust the folder" "grok --trust"

stub_claude 2.1.283
n=$((n + 1)); T="$TMP/t$n"; mkdir -p "$T" "$TMP/h$n"; export HOME="$TMP/h$n"
printf '1\n1 2\nn\nPat\n1\n\nn\n' | CONTEXTIUM_PROMPT_STDIN=1 "$BASH" "$HERE/install.sh" "$T" >"$TMP/out" 2>&1
has_out "T3 Code asks which agent it runs" "Which agent will T3 Code run?"
is "the first agent picked writes the code" "$(cat "$T/.agents/harness")" "harness=t3
agent=claude
tools=t3 claude codex"
is "Claude Code among them is wired" "$(readlink "$HOME/.claude/skills")" "$HOME/.agents/skills"

# origin: asked for on a terminal, a gh repo offered, and --no-integrations
# means no integrations question.
n=$((n + 1)); T="$TMP/t$n"; mkdir -p "$T" "$TMP/h$n"; export HOME="$TMP/h$n"
printf 'git@example.com:pat/wb.git\n' | CONTEXTIUM_PROMPT_STDIN=1 "$BASH" "$HERE/install.sh" "$T" --harness claude --name Pat --autonomy ask --no-integrations >"$TMP/out" 2>&1
lacks_out "--no-integrations asks no integrations question" "Which integration starters"
is "the origin asked for is added" "$(git -C "$T" remote get-url origin 2>/dev/null)" "git@example.com:pat/wb.git"
has_out "…and the first push is said" "git push -u origin main"
lacks_out "…and land.sh is not said to refuse" "land.sh will refuse"
: >"$GH_LOG"
n=$((n + 1)); T="$TMP/t$n"; mkdir -p "$T" "$TMP/h$n"; export HOME="$TMP/h$n"
printf '\ny\n' | CONTEXTIUM_PROMPT_STDIN=1 "$BASH" "$HERE/install.sh" "$T" --harness claude --name Pat --autonomy ask --no-integrations >"$TMP/out" 2>&1
is "a blank origin with gh logged in offers a private repo, and a yes creates it" "$(cat "$GH_LOG")" "repo create t$n --private --source . --push"
: >"$GH_LOG"
n=$((n + 1)); T="$TMP/t$n"; mkdir -p "$T" "$TMP/h$n"; export HOME="$TMP/h$n"
printf '\n\n' | CONTEXTIUM_PROMPT_STDIN=1 "$BASH" "$HERE/install.sh" "$T" --harness claude --name Pat --autonomy ask --no-integrations >"$TMP/out" 2>&1
is "…and the default is no" "$(cat "$GH_LOG")" ""
has_out "…so land.sh is said to refuse" "land.sh will refuse"
rm -f "$TMP/gh-authed"

# A starter picked: its manifest passes the check land.sh runs on it.
fresh --integrations "github todoist"
if (cd "$T" && bash .agents/checks/check-integration-manifest.sh --all >/dev/null 2>&1); then ok; else bad "the installed starters pass the manifest check: $(cd "$T" && bash .agents/checks/check-integration-manifest.sh --all 2>&1 | tail -3)"; fi
if grep -q "^## Manifest" "$T/integrations/README.md" 2>/dev/null; then ok; else bad "…and integrations/README.md is there beside them"; fi

# ── the Claude Code floor ────────────────────────────────────────────────
stub_claude 2.1.270
fresh --harness claude
has_out "an older Claude Code is named, with the floor" "Claude Code 2.1.270 does not read AGENTS.md; 2.1.277 or later does"
stub_claude 2.1.283
fresh --harness claude
lacks_out "a current one is not warned about" "does not read AGENTS.md"
rm -f "$STUB/claude"

# ── the AGENTS.md blocks: replaced, the rest kept ────────────────────────
fresh --harness codex --name "Pat Doe"
A="$T/.agents/AGENTS.md"
TEMPLATE_LOOP="$(awk '/^<!-- contextium:loop -->$/,/^<!-- \/contextium -->$/' "$A")"
awk '{ print } /^## Stack$/ { print ""; print "Postgres 16, deployed with Kamal." }' "$A" >"$A.x" && mv "$A.x" "$A"
sed -e 's/^Three moves, with a deliberate/OLD LOOP TEXT/' "$A" >"$A.x" && mv "$A.x" "$A"
awk '/^<!-- contextium:records -->$/ { skip = 1 } !skip { print } /^<!-- \/contextium -->$/ && skip { skip = 0 }' "$A" >"$A.x" && mv "$A.x" "$A"
printf '\n## Mine\n\n- **Deploy on Fridays.** Ours.\n\n<!-- contextium:retired -->\nold block\n<!-- /contextium -->\n' >>"$A"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations >"$TMP/out" 2>&1
is "a block's content is replaced by the template's" "$(awk '/^<!-- contextium:loop -->$/,/^<!-- \/contextium -->$/' "$A")" "$TEMPLATE_LOOP"
if grep -q "^Postgres 16, deployed with Kamal.$" "$A" && grep -q "^- \*\*Deploy on Fridays.\*\* Ours.$" "$A"; then ok; else bad "text outside the blocks is kept"; fi
if grep -q "^<!-- contextium:retired -->$" "$A"; then bad "a block the template no longer has is dropped"; else ok; fi
is "a block the file lost is appended" "$(grep -c '^<!-- contextium:records -->$' "$A")" "1"
has_out "…and it says the user's text was untouched" "your text untouched"
gone "no backup for a block refresh" .agents/AGENTS.md.bak

printf '\n<!-- contextium:loop -->\nnever closed\n' >>"$A"
cp "$A" "$TMP/before"
"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations >"$TMP/out" 2>&1
if cmp -s "$A" "$TMP/before"; then ok; else bad "an unclosed block leaves the file untouched"; fi
has_out "…and says why" "is never closed"

"$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --force >"$TMP/out" 2>&1
if cmp -s "$A.bak" "$TMP/before" && ! grep -q "never closed" "$A"; then ok; else bad "--force replaces the file and keeps the old one as .bak"; fi

# ── v7 -> v8 ─────────────────────────────────────────────────────────────
V7="$TMP/v7src"
V7_IS_WORKTREE=0
if [ -n "${CONTEXTIUM_V7_SRC:-}" ]; then
  V7="$CONTEXTIUM_V7_SRC"
elif git -C "$HERE" worktree add -q --detach "$V7" v7.0.0 2>/dev/null; then
  V7_IS_WORKTREE=1
else
  V7=""
fi
if [ -n "$V7" ]; then
  # v7target — a fresh v7 install for every tool, its git hooks wired, in a git
  # repo with a HOME of its own. Sets T and HOME.
  v7target() {
    n=$((n + 1)); T="$TMP/t$n"; mkdir -p "$T" "$TMP/h$n"; export HOME="$TMP/h$n"
    git -C "$T" init -q
    "$BASH" "$V7/install.sh" "$T" --yes --no-integrations --hooks --all-tools --name "Pat Doe" >/dev/null 2>&1
  }

  v7target
  there "the v7 install made its generated copies" GEMINI.md
  is "…and wired its git hooks" "$(git -C "$T" config --get core.hooksPath)" ".githooks"
  "$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
  for f in .claude .agents/rules .agents/reviewers .agents/scripts .githooks .codex .cursor GEMINI.md .gemini/commands .github; do
    gone "v7's own $f is removed" "$f"
  done
  is "…and so is its core.hooksPath" "$(git -C "$T" config --get core.hooksPath)" ""
  is "the skills now reach Claude Code through the home link" "$(readlink "$HOME/.claude/skills")" "$HOME/.agents/skills"
  if grep -q "working agreement for Pat Doe's workbench" "$T/.agents/AGENTS.md"; then ok; else bad "an unchanged v7 AGENTS.md is replaced, keeping its name"; fi
  gone "…with nothing to back up" .agents/AGENTS.md.bak
  gone "a test v7 installed beside the generators is removed" .agents/generators/generators.test.ts

  v7target
  printf '\n## Our stack\n\nPostgres.\n' >>"$T/.agents/AGENTS.md"
  printf -- '---\npaths: null\n---\n\n# Ours\n\n## ours\nA rule of ours. [2026-01-01]\n' >"$T/.agents/rules/ours.md"
  echo "One more line of ours." >>"$T/.claude/CLAUDE.md"
  echo "Our own instructions." >"$T/.github/copilot-instructions.md"
  jq '.permissions.allow += ["Bash(make *)"]' "$T/.claude/settings.json" >"$TMP/s.json" && cp "$TMP/s.json" "$T/.claude/settings.json"
  echo "echo ours" >"$T/.githooks/checks/check-ours.sh"
  "$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
  if grep -q "^Postgres.$" "$T/.agents/AGENTS.md" && [[ "$(grep -c '^<!-- contextium:[a-z-]* -->$' "$T/.agents/AGENTS.md")" == 5 ]]; then ok; else bad "an edited v7 AGENTS.md keeps its text and gains the blocks"; fi
  there "…with the original kept" .agents/AGENTS.md.bak
  has_out "…and says what to delete" "Delete the old sections they"
  there "a rule file of the user's stays" .agents/rules/ours.md
  gone "…while v7's own rule files go" .agents/rules/voice.md
  has_out "…and says so" "kept your own rule files: .agents/rules/ours.md"
  there "an edited CLAUDE.md stays" .claude/CLAUDE.md
  has_out "…with the reason it matters" "Claude Code reads it instead of AGENTS.md"
  there "an edited .claude/settings.json stays" .claude/settings.json
  has_out "…with what changed" "the guards now live in ~/.claude/settings.json"
  there "a check of the user's in .githooks/ stays" .githooks/checks/check-ours.sh
  gone "…while v7's own checks go" .githooks/checks/check-secrets.sh
  is "…and core.hooksPath stays while it has a hook to point at" "$(git -C "$T" config --get core.hooksPath)" ".githooks"
  there "a copilot-instructions.md we did not write stays" .github/copilot-instructions.md
  has_out "…and is named" "kept .github/copilot-instructions.md — Contextium did not write it"

  # The generated-file marker is not proof a file is untouched: an edited
  # GEMINI.md or command file still carries it, and the edit is the user's.
  v7target
  echo "A line of ours." >>"$T/GEMINI.md"
  echo "A line of ours." >>"$T/.gemini/commands/project.toml"
  echo "A line of ours." >>"$T/.cursor/rules/contextium.mdc"
  "$BASH" "$HERE/install.sh" "$T" --yes --no-integrations --harness claude >"$TMP/out" 2>&1
  there "an edited generated GEMINI.md stays" GEMINI.md
  has_out "…and is named" "kept GEMINI.md — you edited it"
  there "an edited generated command stays" .gemini/commands/project.toml
  there "an edited generated Cursor rule stays" .cursor/rules/contextium.mdc
  gone "…while an unedited generated command goes" .gemini/commands/close.toml
  gone "…and the unedited copilot-instructions.md" .github/copilot-instructions.md

  [ "$V7_IS_WORKTREE" = 0 ] || git -C "$HERE" worktree remove --force "$V7"
else
  bad "cannot check out v7.0.0 for the upgrade rows — run from a clone with its tags"
fi

echo "install.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
