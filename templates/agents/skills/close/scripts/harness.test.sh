#!/usr/bin/env bash
# shellcheck disable=SC2016  # the sourced snippet expands in the child shell
# harness.test.sh — peer of harness.sh: the recorded harness, its override,
# the worktree root and branch per harness, and the session id.
# Run: bash harness.test.sh
set -uo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
is() { if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; echo "  expected: [$3]"; echo "  actual:   [$2]"; fi; }
h() { env -u CONTEXTIUM_HARNESS -u CONTEXTIUM_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID HOME=/home/u "$@" bash -c 'source "$0"; eval "$1"' "$LIB" "$CMD"; }
R="$TMP/shop"; mkdir -p "$R/.agents"

CMD="harness_name $R";              is "nothing recorded: default" "$(h)" "default"
printf 'agent=claude-code\n' >"$R/.agents/harness"
CMD="harness_name $R";              is "a record with no harness= key: default" "$(h)" "default"
printf 'harness=claude\nagent=claude-code\n' >"$R/.agents/harness"
CMD="harness_name $R";              is "the installer's record: the harness= line of .agents/harness" "$(h)" "claude"
printf 'agent=x\n harness = gemini \n' >"$R/.agents/harness"
CMD="harness_name $R";              is "…in any order, spaces around =" "$(h)" "gemini"
CMD="harness_name $R";              is "CONTEXTIUM_HARNESS overrides it" "$(h CONTEXTIUM_HARNESS=codex)" "codex"

root() { CMD="harness_worktree_root $R"; h CONTEXTIUM_HARNESS="$1" CODEX_HOME="${2:-}"; }
is "claude: in the repo, where claude -w puts them" "$(root claude)" "$R/.claude/worktrees"
is "gemini: in the repo" "$(root gemini)" "$R/.gemini/worktrees"
is "grok: under ~/.grok, per repo" "$(root grok)" "/home/u/.grok/worktrees/shop"
is "codex: under CODEX_HOME" "$(root codex /opt/cx)" "/opt/cx/worktrees"
is "t3 local mode: beside the repo" "$(root t3)" "$TMP/shop.worktrees"
is "cursor: beside the repo" "$(root cursor)" "$TMP/shop.worktrees"
is "unknown: beside the repo" "$(root something-new)" "$TMP/shop.worktrees"
CMD="harness_worktree_root $R/"; is "a trailing slash reads the same" "$(h CONTEXTIUM_HARNESS=vscode)" "$TMP/shop.worktrees"

CMD="harness_worktree_branch s1 $R"; is "claude names branches worktree-<name>" "$(h CONTEXTIUM_HARNESS=claude)" "worktree-s1"
CMD="harness_worktree_branch s1 $R"; is "others get session/<name>" "$(h CONTEXTIUM_HARNESS=codex)" "session/s1"

CMD='harness_session_id';           is "no session id: empty" "$(h)" ""
CMD='harness_session_id';           is "CONTEXTIUM_SESSION wins" "$(h CONTEXTIUM_SESSION=mine CLAUDE_CODE_SESSION_ID=theirs)" "mine"
CMD='harness_session_id';           is "Claude Code's id is used" "$(h CLAUDE_CODE_SESSION_ID=2e53-aa)" "2e53-aa"
CMD='harness_session_id';           is "unsafe characters become dashes" "$(h CONTEXTIUM_SESSION='a b/c:d')" "a-b-c-d"
CMD='harness_session_id';           is "…and it is cut to 64" "$(h CONTEXTIUM_SESSION="$(printf 'x%.0s' $(seq 1 80))" | tr -d '\n' | wc -c | tr -d ' ')" "64"

echo "harness.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
