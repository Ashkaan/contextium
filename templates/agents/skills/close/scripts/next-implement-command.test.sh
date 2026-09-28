#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures are literal markdown; backticks are not expansions
# next-implement-command.test.sh — the slug-not-spec-name guarantee, the status
# branches, and one command per ready ROADMAP.md row.
# Run: bash next-implement-command.test.sh

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

# ── Loose *.spec.md projects ─────────────────────────────────────────────

# An un-reported spec → the bare project slug, NOT the spec's name.
d="$(mkproj "2026-05-05_checkout-flow" active)"
: >"$d/guest-checkout.spec.md"
: >"$d/saved-cards.spec.md"
: >"$d/saved-cards-report.md" # this one IS reported
check "slug-not-spec-name" "/implement checkout-flow" "$("$GEN" "$d")"
check "trailing-slash-same" "/implement checkout-flow" "$("$GEN" "$d/")"

# A partial report still owes work, and says so.
d="$(mkproj "2026-05-06_partial" active)"
: >"$d/a.spec.md"
printf '**SPEC**: `a.spec.md`\n**Status**: PARTIAL\n' >"$d/a-report.md"
check "partial-named" "/implement partial
# partial a is reported but not claimed complete — see its report Status line" "$("$GEN" "$d")"

# No pending spec + active → /project <slug>.
d="$(mkproj "2026-01-01_done-specs" active)"
: >"$d/foo.spec.md"
: >"$d/foo-report.md"
check "active-no-pending-spec" "/project done-specs" "$("$GEN" "$d")"

# No spec at all + active → /project <slug>.
d="$(mkproj "2026-01-02_empty" active)"
check "active-no-spec" "/project empty" "$("$GEN" "$d")"

# ── Status branches ──────────────────────────────────────────────────────

d="$(mkproj "2026-03-03_finished" completed)"
: >"$d/x.spec.md"
printf '\n## Outcome\n\n- Every order confirmation now arrives within a minute.\n' >>"$d/README.md"
check "completed-outcome" \
  "# finished — project complete: Every order confirmation now arrives within a minute." \
  "$("$GEN" "$d")"

d="$(mkproj "2026-03-04_finished-bare" completed)"
check "completed-no-outcome" \
  "# finished-bare — project complete (no ## Outcome section written)" \
  "$("$GEN" "$d")"

d="$(mkproj "2026-04-04_waiting" blocked "vendor API access")"
check "blocked-comment" "# waiting is blocked — waiting on: vendor API access" "$("$GEN" "$d")"

d="$(mkproj "2026-04-05_waiting-bare" blocked)"
check "blocked-no-reason" "# waiting-bare is blocked — waiting on: (blocked-on not set)" "$("$GEN" "$d")"

d="$(mkproj "2026-05-05_observe" monitor)"
printf 'monitoring-until: 2026-08-15 — first scheduled run must post a non-empty digest\n' >>"$d/README.md"
check "monitor-with-reason" \
  "# observe — work complete, monitoring until 2026-08-15: first scheduled run must post a non-empty digest" \
  "$("$GEN" "$d")"

d="$(mkproj "2026-05-06_observe-bare" monitor)"
printf 'monitoring-until: 2026-08-20\n' >>"$d/README.md"
check "monitor-bare-date" \
  "# observe-bare — work complete, monitoring until 2026-08-20 (no command — passive observation)" \
  "$("$GEN" "$d")"

d="$(mkproj "2026-05-07_observe-nodate" monitor)"
check "monitor-no-date" \
  "# observe-nodate — work complete, monitor window open (monitoring-until not set)" \
  "$("$GEN" "$d")"

# ── ROADMAP.md projects ──────────────────────────────────────────────────
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

# A Sub-spec that is not on disk needs planning.
d="$(mkproj "2026-09-03_rm-missing" active)"; mkroadmap "$d" '| R1 | a | i | s | — | planned | `specs/001-a/` |'
check "rm-subspec-missing" "/project rm-missing" "$("$GEN" "$d")"

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

# A loose spec no row points at prints first; one a row points at is that row.
d="$(mkproj "2026-09-07_rm-mixed" active)"
mkroadmap "$d" '| R1 | a | i | s | — | planned | `a.spec.md` → `a-report.md` |'
: >"$d/a.spec.md"; : >"$d/loose.spec.md"
check "rm-loose-first" "/implement rm-mixed
/implement rm-mixed r1" "$("$GEN" "$d")"

# Status outside the vocabulary, and only such rows left
d="$(mkproj "2026-09-08_rm-blk" active)"
mkroadmap "$d" '| R1 | a | i | s | — | done | — |' '| R16 | f | i | s | — | waiting on the vendor | — |'
check "rm-unknown-status-named" "# rm-blk R16 has a Status outside the vocabulary: waiting on the vendor" "$("$GEN" "$d" 2>/dev/null)"

# Malformed: only the comment, exit 0
d="$(mkproj "2026-09-09_rm-bad" active)"
printf '# Roadmap: t\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n' >"$d/ROADMAP.md"; : >"$d/x.spec.md"
check "rm-malformed" "# rm-bad ROADMAP.md is malformed: no table under \`# Roadmap\` with ID and Status columns" "$("$GEN" "$d")"

# monitor still wins over rows
d="$(mkproj "2026-09-11_rm-mon" monitor)"; mkroadmap "$d" '| R1 | a | i | s | — | planned | — |'
check "rm-status-first" "# rm-mon — work complete, monitor window open (monitoring-until not set)" "$("$GEN" "$d")"

# Usage
set +e
"$GEN" >/dev/null 2>&1; rc=$?
"$GEN" "$TMP/nope" >/dev/null 2>&1; rc2=$?
set -e
check "no-arg-exit2" "2" "$rc"
check "missing-folder-exit2" "2" "$rc2"

echo "── next-implement-command: $pass passed, $fail failed ──"
[[ "$fail" -eq 0 ]]
