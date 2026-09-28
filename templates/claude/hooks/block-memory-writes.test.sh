#!/usr/bin/env bash
# Rows for block-memory-writes.sh: a write outside the memory directory passes,
# one inside it is refused (exit 2) with a route — and project content is
# routed by what it is: project status to the README front matter, outstanding
# work to a ROADMAP.md row.
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/block-memory-writes.sh"
MEM="/home/u/.claude/projects/x/memory/note.md"
pass=0
fail=0

# route <case> <file_path> <content> <want-rc> <needle-or-empty>
route() {
  local out rc
  out="$(jq -n --arg p "$2" --arg c "$3" '{tool_input: {file_path: $p, content: $c}}' | bash "$HOOK" 2>&1)"
  rc=$?
  if [[ "$rc" != "$4" ]]; then
    fail=$((fail + 1)); echo "FAIL: $1 — expected rc=$4, got rc=$rc: $out" >&2
  elif [[ -n "$5" && "$out" != *"$5"* ]]; then
    fail=$((fail + 1)); echo "FAIL: $1 — output lacks '$5': $out" >&2
  else
    pass=$((pass + 1))
  fi
}

route "a write outside the memory directory passes" "/repo/notes.md" "status: active" 0 ""
route "project status goes to the README front matter" "$MEM" "status: blocked, blocked-on: vendor reply" 2 \
  "ROUTE: projects/<domain>/<date>_<slug>/README.md"
route "monitoring-until goes to the README front matter" "$MEM" "monitoring-until: 2026-02-01" 2 \
  "ROUTE: projects/<domain>/<date>_<slug>/README.md"
route "next steps go to a ROADMAP.md row" "$MEM" "next steps: add retries to checkout" 2 \
  "ROUTE: projects/<domain>/<date>_<slug>/ROADMAP.md"
route "work in progress goes to a ROADMAP.md row" "$MEM" "retry work is in progress" 2 \
  "ROUTE: projects/<domain>/<date>_<slug>/ROADMAP.md"

echo "block-memory-writes.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
