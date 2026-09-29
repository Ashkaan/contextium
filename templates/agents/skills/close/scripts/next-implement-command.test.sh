#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures hold literal backticks and $ in single quotes
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
  local dir="$TMP/projects/web/$1"
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
d="$(mkproj "2026-05-05_checkout-flow" active)"
: >"$d/guest-checkout.spec.md"
: >"$d/saved-cards.spec.md"
: >"$d/saved-cards-report.md" # this one IS reported
check "slug-not-spec-name" "/implement checkout-flow" "$("$GEN" "$d")"

# 2. No pending SPEC + active → /project <slug>.
d="$(mkproj "2026-01-01_done-specs" active)"
: >"$d/foo.spec.md"
: >"$d/foo-report.md"
check "active-no-pending-spec" "/project done-specs" "$("$GEN" "$d")"

# 3. Sharded → one /implement <slug> <shard> per pending shard, sorted.
d="$(mkproj "2026-02-02_big-migration" active)"
printf '## Shard Status\n| Shard | SPEC | Report | State |\n' >>"$d/README.md"
: >"$d/token-refresher.spec.md"
: >"$d/email-sender.spec.md"
: >"$d/foundation.spec.md"
: >"$d/foundation-report.md" # reported — excluded
expected=$'/implement big-migration email-sender\n/implement big-migration token-refresher'
check "sharded-per-shard" "$expected" "$("$GEN" "$d")"

# 4. completed → says so, quoting the project's own ## Outcome first line.
d="$(mkproj "2026-03-03_finished" completed)"
: >"$d/x.spec.md"
printf '\n## Outcome\n\n- Every order confirmation now arrives within a minute.\n' >>"$d/README.md"
check "completed-outcome" \
  "# finished — project complete: Every order confirmation now arrives within a minute." \
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

# ── The shard-table State column ────────────────────────────────────────────
# The report-presence heuristic reads a part-done shard as finished, which is
# how a close offered three `planned` shards while the one in motion had eight
# reports written.
mkshards() {
  # mkshards <folder> <status> <shard:state> ...
  local dir="$TMP/projects/ai/$1" status="$2"; shift 2
  mkdir -p "$dir"
  { echo "---"; echo "status: $status"; echo "---"; echo "# project"; } >"$dir/README.md"
  printf '## Shard Status\n\n| Shard | SPEC | Report | State |\n|---|---|---|---|\n' >>"$dir/README.md"
  local row shard state
  for row in "$@"; do
    shard="${row%%:*}"; state="${row##*:}"
    printf '| %s | `%s.spec.md` | — | %s |\n' "$shard" "$shard" "$state" >>"$dir/README.md"
  done
  printf '%s' "$dir"
}

# An in-flight shard is the work in motion and comes first, ALONE — even when
# it has reports and the planned ones do not.
d="$(mkshards "2026-09-04_data-move" active export-out:in-flight archive-repo:planned log-split:planned)"
: >"$d/export-out.spec.md"; : >"$d/export-out-report.md"
: >"$d/archive-repo.spec.md"; : >"$d/log-split.spec.md"
check "in-flight-shard-wins" "/implement data-move export-out" "$("$GEN" "$d")"

# Two in flight (parallel tabs) → both, sorted.
d="$(mkshards "2026-03-03_two-open" active alpha:in-flight beta:in-flight gamma:planned)"
expected=$'/implement two-open alpha\n/implement two-open beta'
check "two-in-flight" "$expected" "$("$GEN" "$d")"

# Nothing in flight → the planned ones.
d="$(mkshards "2026-04-04_nothing-open" active alpha:closed beta:planned)"
check "planned-when-nothing-in-flight" "/implement nothing-open beta" "$("$GEN" "$d")"

# A blocked shard is named alongside whatever is next.
d="$(mkshards "2026-05-05_one-blocked" active alpha:in-flight beta:blocked)"
expected=$'/implement one-blocked alpha\n# one-blocked beta is blocked — see its row in ## Shard Status'
check "blocked-named-alongside" "$expected" "$("$GEN" "$d")"

# Blocked and nothing else open → the block IS the answer, no command.
d="$(mkshards "2026-06-06_only-blocked" active alpha:closed beta:blocked)"
check "blocked-only" "# only-blocked beta is blocked — see its row in ## Shard Status" "$("$GEN" "$d")"

# Every shard done → the project needs its next phase decided, even though
# `status:` is still active.
d="$(mkshards "2026-07-07_all-done" active alpha:closed beta:reported)"
check "all-shards-done" "/project all-done" "$("$GEN" "$d")"

# A table with a header and NO rows keeps the old behaviour — that is what
# test 3 above covers and this asserts the fallback is deliberate.
d="$(mkproj "2026-08-08_header-only" active)"
printf '## Shard Status\n| Shard | SPEC | Report | State |\n' >>"$d/README.md"
: >"$d/alpha.spec.md"
check "header-only-falls-back" "/implement header-only alpha" "$("$GEN" "$d")"

# ── ROADMAP.md projects ─────────────────────────────────────────────
RM_HDR='| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|'
mkroadmap() { # mkroadmap <dir> <rows...>
  local d="$1"; shift
  { printf '# Roadmap: t\n\n%s\n' "$RM_HDR"; local r; for r in "$@"; do printf '%s\n' "$r"; done; } >"$d/ROADMAP.md"
}
spec() { mkdir -p "$1/specs/$2"; printf '%s\n' "${3:-# spec}" >"$1/specs/$2/spec.md"; }

d="$(mkproj "2026-09-01_rm-empty" active)"; mkroadmap "$d"
check "rm-header-only" "/project rm-empty" "$("$GEN" "$d")"

d="$(mkproj "2026-09-02_rm-plan" active)"; mkroadmap "$d" '| R1 | a | i | s | — | planned | — |'
check "rm-row-needs-planning" "/project rm-plan" "$("$GEN" "$d")"

d="$(mkproj "2026-09-03_rm-impl" active)"; mkroadmap "$d" '| R1 | a | i | s | — | planned | `specs/001-a/` |'
spec "$d" 001-a
check "rm-row-with-spec" "/implement rm-impl r1" "$("$GEN" "$d")"
printf -- '---\nspec: 001-a\nspec-status: complete\n---\n' >"$d/specs/001-a/report.md"
check "rm-complete-awaiting-done" "# rm-impl R1's spec is complete — run /close to flip the row to done" "$("$GEN" "$d")"

# Several ready rows: one /implement per row with a pending spec, plus ONE
# /project for every row that needs planning; blocked rows named, in that order.
d="$(mkproj "2026-09-04_rm-par" active)"
mkroadmap "$d" \
  '| R1 | a | i | s | — | done | — |' \
  '| R2 | b | i | s | R1 | planned | `specs/002-b/` |' \
  '| R3 | c | i | s | R1 | planned | `specs/003-c/` |' \
  '| R4 | d | i | s | — | planned | — |' \
  '| R5 | e | i | s | — | planned | — |' \
  '| R6 | f | i | s | — | blocked: vendor reply | — |' \
  '| R7 | g | i | s | R6 | planned | `specs/007-g/` |'
spec "$d" 002-b; spec "$d" 003-c; spec "$d" 007-g
check "rm-parallel-set" "/implement rm-par r2
/implement rm-par r3
/project rm-par
# rm-par R6 is blocked: vendor reply" "$("$GEN" "$d")"

# An open clarification sends the row to planning instead of /implement.
d="$(mkproj "2026-09-05_rm-clar" active)"
mkroadmap "$d" '| R1 | a | i | s | — | planned | `specs/001-a/` |' '| R2 | b | i | s | — | planned | `specs/002-b/` |'
spec "$d" 001-a '[NEEDS CLARIFICATION: which store?]'; spec "$d" 002-b
check "rm-clarification-routes-to-project" "/implement rm-clar r2
/project rm-clar" "$("$GEN" "$d")"

# in-progress before planned
d="$(mkproj "2026-09-06_rm-order" active)"
mkroadmap "$d" '| R1 | a | i | s | — | planned | `specs/001-a/` |' '| R2 | b | i | s | — | in-progress | `specs/002-b/` |'
spec "$d" 001-a; spec "$d" 002-b
check "rm-in-progress-first" "/implement rm-order r2
/implement rm-order r1" "$("$GEN" "$d")"

# A legacy loose spec no row points at prints first; one a row points at is that row.
d="$(mkproj "2026-09-07_rm-mixed" active)"
mkroadmap "$d" '| R1 | a | i | s | — | planned | `a.spec.md` → `a-report.md` |'
: >"$d/a.spec.md"; : >"$d/loose.spec.md"
check "rm-legacy-loose-first" "/implement rm-mixed
/implement rm-mixed r1" "$("$GEN" "$d")"

# Status outside the vocabulary, and only blocked rows left
d="$(mkproj "2026-09-08_rm-blk" active)"
mkroadmap "$d" '| R1 | a | i | s | — | done | — |' '| R16 | f | i | s | — | waiting on the vendor | — |'
check "rm-unknown-status-named" "# rm-blk R16 has a Status outside the vocabulary: waiting on the vendor" "$("$GEN" "$d" 2>/dev/null)"

# Malformed: only the comment, exit 0
d="$(mkproj "2026-09-09_rm-bad" active)"
printf '# Roadmap: t\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n' >"$d/ROADMAP.md"; : >"$d/x.spec.md"
check "rm-malformed" "# rm-bad ROADMAP.md is malformed: no table under \`# Roadmap\` with ID and Status columns" "$("$GEN" "$d")"

# ROADMAP beats a legacy shard table
d="$(mkshards "2026-09-10_rm-shards" active alpha:planned)"
mkroadmap "$d" '| R1 | a | i | s | — | planned | — |'
check "rm-beats-shard-table" "/project rm-shards" "$("$GEN" "$d")"

# monitor still wins over rows
d="$(mkproj "2026-09-11_rm-mon" monitor)"; mkroadmap "$d" '| R1 | a | i | s | — | planned | — |'
check "rm-status-first" "# rm-mon — work complete, monitor window open (monitoring-until not set)" "$("$GEN" "$d")"

echo "── next-implement-command: $pass passed, $fail failed ──"
[[ "$fail" -eq 0 ]]

