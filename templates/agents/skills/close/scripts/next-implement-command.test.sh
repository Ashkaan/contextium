#!/usr/bin/env bash
# next-implement-command.test.sh — covers the slug-not-SPEC-name guarantee + the
# status/shard branches. Run: bash next-implement-command.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GEN="$SCRIPT_DIR/next-implement-command.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name"
    echo "  expected: [$expected]"
    echo "  actual:   [$actual]"
  fi
}

mkproj() {
  # mkproj <folder-name> <status> [blocked-on]
  local dir="$TMP/projects/example/$1"
  mkdir -p "$dir"
  {
    echo "---"
    echo "status: $2"
    [[ -n "${3:-}" ]] && echo "blocked-on: $3"
    echo "---"
    echo "# project"
  } >"$dir/README.md"
  printf '%s' "$dir"
}

# 1. THE BUG: un-reported sub-SPEC → bare project slug, NOT the SPEC basename.
d="$(mkproj "2026-05-05_direct-hire-recruiting" active)"
: >"$d/sourced-through-form.spec.md"
: >"$d/score-rebalance-interview-cards.spec.md"
: >"$d/score-rebalance-interview-cards-report.md" # this one IS reported
check "slug-not-spec-name" "/implement direct-hire-recruiting" "$("$GEN" "$d")"

# 2. No pending SPEC + active → /project <slug>.
d="$(mkproj "2026-01-01_done-specs" active)"
: >"$d/foo.spec.md"
: >"$d/foo-report.md"
check "active-no-pending-spec" "/project done-specs" "$("$GEN" "$d")"

# 3. Sharded → one /implement <slug> <shard> per pending shard, sorted.
d="$(mkproj "2026-02-02_big-migration" active)"
printf '## Shard Status\n| Shard | SPEC | Report | State |\n' >>"$d/README.md"
: >"$d/oauth-refresher.spec.md"
: >"$d/send-email.spec.md"
: >"$d/foundation.spec.md"
: >"$d/foundation-report.md" # reported — excluded
expected=$'/implement big-migration oauth-refresher\n/implement big-migration send-email'
check "sharded-per-shard" "$expected" "$("$GEN" "$d")"

# 4. completed → says so, quoting the project's own ## Outcome first line.
d="$(mkproj "2026-03-03_finished" completed)"
: >"$d/x.spec.md"
printf '\n## Outcome\n\n- Every recruiter monitor now reports what actually happened.\n' >>"$d/README.md"
check "completed-outcome" \
  "# finished — project complete: Every recruiter monitor now reports what actually happened." \
  "$("$GEN" "$d")"

# 4b. completed with no ## Outcome → still says complete, names the gap.
d="$(mkproj "2026-03-04_finished-bare" completed)"
check "completed-no-outcome" \
  "# finished-bare — project complete (no ## Outcome section written)" \
  "$("$GEN" "$d")"

# 5. blocked → comment with blocked-on, no command.
d="$(mkproj "2026-04-04_waiting" blocked "vendor API access")"
check "blocked-comment" "# waiting is blocked — waiting on: vendor API access" "$("$GEN" "$d")"

# 6. monitor with a reason on monitoring-until → date AND what is being watched.
d="$(mkproj "2026-05-05_observe" monitor)"
printf 'monitoring-until: 2026-08-15 — first scheduled run must post a non-empty digest\n' >>"$d/README.md"
check "monitor-with-reason" \
  "# observe — work complete, monitoring until 2026-08-15: first scheduled run must post a non-empty digest" \
  "$("$GEN" "$d")"

# 6b. monitor with a bare date → date only, still says the build finished.
d="$(mkproj "2026-05-06_observe-bare" monitor)"
printf 'monitoring-until: 2026-08-20\n' >>"$d/README.md"
check "monitor-bare-date" \
  "# observe-bare — work complete, monitoring until 2026-08-20 (no command — passive observation)" \
  "$("$GEN" "$d")"

# 6c. monitor with no monitoring-until → names the missing field, never silent.
d="$(mkproj "2026-05-07_observe-nodate" monitor)"
check "monitor-no-date" \
  "# observe-nodate — work complete, monitor window open (monitoring-until not set)" \
  "$("$GEN" "$d")"

echo "── next-implement-command: $pass passed, $fail failed ──"
[[ "$fail" -eq 0 ]]
