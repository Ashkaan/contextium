#!/usr/bin/env bash
# shellcheck disable=SC2016 # the backticks in the roadmap rows are markdown, not command substitution
# detect-stage.test.sh — peer of detect-stage.sh. Run: bash detect-stage.test.sh
#
# detect-stage.sh reads project paths relative to the write root, which it
# asks session-write-root.sh for; CONTEXT_WRITE_ROOT points that at a fixture.
# It calls three sibling helpers in close/scripts/ (roadmap.sh, spec-state.sh,
# open-clarifications.sh). They are used as they are, not stubbed, so this suite
# also pins their contract; CONTEXTIUM_CLOSE_SCRIPTS points at another copy.
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/detect-stage.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d "${TMPDIR:-/tmp}/detect-stage-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
tmp="$(cd "$tmp" && pwd -P)"
export CONTEXT_WRITE_ROOT="$tmp"
unset CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID
cd "$tmp" || exit 1

# mk <slug> <status> → creates projects/t/2026-01-01_<slug>, prints the relative path
mk() {
  local rel="projects/t/2026-01-01_$1"
  mkdir -p "$rel"
  printf -- '---\nproject: %s\nstatus: %s\n---\n\n# P\n' "$1" "$2" >"$rel/README.md"
  printf '%s' "$rel"
}
HDR='| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|'
roadmap() { # roadmap <rel> <rows...>
  local rel="$1"; shift
  { printf '# Roadmap: t\n\n%s\n' "$HDR"; local r; for r in "$@"; do printf '%s\n' "$r"; done; } >"$rel/ROADMAP.md"
}
run() { bash "$SUT" "$1" 2>/dev/null; }
field() { run "$1" | sed -n "s/^$2: \{0,1\}//p"; }

# ── Legacy layout ────────────────────────────────────────────────────────
p="$(mk never active)"
t "legacy: no spec is needs-planning" "needs-planning" "$(field "$p" stage)"
t "legacy: no next-row line" "" "$(run "$p" | grep '^next-row' || true)"

p="$(mk pending active)"; : >"$p/a.spec.md"
t "legacy: unreported spec is ready-to-implement" "ready-to-implement" "$(field "$p" stage)"
t "legacy: active-spec is the file" "$p/a.spec.md" "$(field "$p" active-spec)"

p="$(mk reported active)"; : >"$p/a.spec.md"; echo x >"$p/a-report.md"
t "legacy: every spec reported" "all-specs-reported" "$(field "$p" stage)"
t "legacy: exact output shape" "stage: all-specs-reported
status: active
specs: 1
reports: 1
active-spec: " "$(run "$p")"

p="$(mk legacy-plan active)"; : >"$p/a.plan.md"
t "legacy: an unreported *.plan.md is ready-to-implement" "ready-to-implement $p/a.plan.md" "$(field "$p" stage) $(field "$p" active-spec)"

for st in monitor blocked completed; do
  p="$(mk "s-$st" "$st")"
  t "legacy: status $st" "$st" "$(field "$p" stage)"
done

t "missing README is unknown" "unknown" "$(field projects/t/none stage)"
t "missing README status" "missing-readme" "$(field projects/t/none status)"

# ── ROADMAP layout ───────────────────────────────────────────────────────
p="$(mk rm-empty active)"; roadmap "$p"
t "header-only roadmap, no rows, no specs is needs-planning" "needs-planning" "$(field "$p" stage)"
t "header-only roadmap prints an empty next-row" "yes" "$(run "$p" | grep -qx 'next-row: ' && echo yes)"

p="$(mk rm-plan active)"; roadmap "$p" '| R1 | a | i | s | — | planned | — |'
t "row with no spec is needs-planning" "needs-planning" "$(field "$p" stage)"
t "row with no spec names the row" "R1" "$(field "$p" next-row)"

p="$(mk rm-impl active)"; roadmap "$p" '| R1 | a | i | s | — | planned | `specs/001-a/` |'
mkdir -p "$p/specs/001-a"; echo '# spec' >"$p/specs/001-a/spec.md"
t "row with an unreported spec is ready-to-implement" "ready-to-implement" "$(field "$p" stage)"
t "active-spec is the folder's spec.md" "$p/specs/001-a/spec.md" "$(field "$p" active-spec)"
t "next-row is the row" "R1" "$(field "$p" next-row)"
t "folder spec is counted" "1" "$(field "$p" specs)"

printf -- '---\nspec: 001-a\nspec-status: partial\n---\n' >"$p/specs/001-a/report.md"
t "partial report keeps the row ready-to-implement" "ready-to-implement" "$(field "$p" stage)"
t "folder report is counted" "1" "$(field "$p" reports)"

printf -- '---\nspec: 001-a\nspec-status: complete\n---\n' >"$p/specs/001-a/report.md"
t "complete report, row not yet done → ready-to-close" "ready-to-close R1" "$(field "$p" stage) $(field "$p" next-row)"

p="$(mk rm-clar active)"; roadmap "$p" '| R1 | a | i | s | — | planned | `specs/001-a/` |'
mkdir -p "$p/specs/001-a"; printf 'FR-1 [NEEDS CLARIFICATION: which?]\n' >"$p/specs/001-a/spec.md"
t "open clarification routes to planning" "needs-planning" "$(field "$p" stage)"
t "open clarification names the row" "R1" "$(field "$p" next-row)"

p="$(mk rm-order active)"; roadmap "$p" \
  '| R1 | a | i | s | — | planned | `specs/001-a/` |' \
  '| R2 | b | i | s | — | in-progress | `specs/002-b/` |'
mkdir -p "$p/specs/001-a" "$p/specs/002-b"; : >"$p/specs/001-a/spec.md"; : >"$p/specs/002-b/spec.md"
t "in-progress row wins over an earlier planned one" "R2" "$(field "$p" next-row)"

p="$(mk rm-dep active)"; roadmap "$p" \
  '| R1 | a | i | s | — | blocked: vendor reply | — |' \
  '| R2 | b | i | s | R1 | planned | `specs/002-b/` |'
mkdir -p "$p/specs/002-b"; : >"$p/specs/002-b/spec.md"
t "only blocked or dependent rows → all-specs-reported" "all-specs-reported" "$(field "$p" stage)"

p="$(mk rm-legacy active)"; roadmap "$p" \
  '| R1 | a | i | s | — | planned | `specs/001-a/` |' \
  '| R2 | b | i | s | — | planned | `b.spec.md` → `b-report.md` |'
mkdir -p "$p/specs/001-a"; : >"$p/specs/001-a/spec.md"; : >"$p/b.spec.md"
t "legacy loose spec in flight wins active-spec" "$p/b.spec.md" "$(field "$p" active-spec)"
t "legacy loose spec names its row" "R2" "$(field "$p" next-row)"

p="$(mk rm-legrow active)"; roadmap "$p" '| R1 | a | i | s | — | done | `a.spec.md` → `a-report.md` |' '| R2 | b | i | s | R1 | planned | — |'
: >"$p/a.spec.md"; echo x >"$p/a-report.md"
t "legacy-form done row is satisfied; next needs planning" "needs-planning R2" "$(field "$p" stage) $(field "$p" next-row)"

p="$(mk rm-bad active)"; printf '# Roadmap: t\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n' >"$p/ROADMAP.md"
: >"$p/a.spec.md"
t "malformed roadmap is unknown, not the legacy answer" "unknown" "$(field "$p" stage)"
t "malformed roadmap names the problem" "no table under \`# Roadmap\` with ID and Status columns" "$(field "$p" roadmap-error)"

p="$(mk rm-tpl active)"; cp "$(dirname "$SUT")/../references/templates/ROADMAP.md" "$p/ROADMAP.md"
t "unfilled template is unknown" "unknown" "$(field "$p" stage)"

p="$(mk rm-mon monitor)"; roadmap "$p" '| R1 | a | i | s | — | planned | — |'
t "monitor status still overrides the rows" "monitor" "$(field "$p" stage)"

# A finished project keeps naming the spec still owed work, whichever layout it
# is in: the rows only order work on an ACTIVE project.
p="$(mk rm-done completed)"; roadmap "$p" '| R1 | a | i | s | — | in-progress | `specs/001-a/` |'
mkdir -p "$p/specs/001-a"; : >"$p/specs/001-a/spec.md"
t "completed with a roadmap: active-spec is the folder spec owed work" "completed $p/specs/001-a/spec.md" "$(field "$p" stage) $(field "$p" active-spec)"

# A ready row whose Sub-spec is not on disk has no spec to build: plan it.
p="$(mk rm-missing active)"; roadmap "$p" '| R1 | a | i | s | — | planned | `specs/001-gone/` |'
t "row pointing at a missing spec folder is needs-planning" "needs-planning R1" "$(field "$p" stage) $(field "$p" next-row)"

# An unfinished close outranks new work: the row it would flip may unblock others.
p="$(mk rm-close-first active)"; roadmap "$p" \
  '| R1 | a | i | s | — | in-progress | `specs/001-a/` |' \
  '| R2 | b | i | s | — | planned | `specs/002-b/` |'
mkdir -p "$p/specs/001-a" "$p/specs/002-b"; : >"$p/specs/001-a/spec.md"; : >"$p/specs/002-b/spec.md"
printf -- '---\nspec: 001-a\nspec-status: complete\n---\n' >"$p/specs/001-a/report.md"
t "a complete row awaiting close wins over a buildable row" "ready-to-close R1" "$(field "$p" stage) $(field "$p" next-row)"

# Rows that are all done: nothing to plan, nothing to build.
p="$(mk rm-alldone active)"; roadmap "$p" '| R1 | a | i | s | — | done | `specs/001-a/` |'
mkdir -p "$p/specs/001-a"; : >"$p/specs/001-a/spec.md"
printf -- '---\nspec: 001-a\nspec-status: complete\n---\n' >"$p/specs/001-a/report.md"
t "every row done is all-specs-reported" "all-specs-reported" "$(field "$p" stage)"

# The script runs under `set -e`; a helper that fails must be reported, never
# abort the run before `stage:` is printed.
broken="$tmp/broken-close"; mkdir -p "$broken"
printf 'exit 1\n' >"$broken/spec-state.sh"; printf 'exit 3\n' >"$broken/roadmap.sh"
p="$(mk helpers-fail active)"; : >"$p/a.spec.md"; roadmap "$p" '| R1 | a | i | s | — | planned | — |'
out="$(CONTEXTIUM_CLOSE_SCRIPTS="$broken" bash "$SUT" "$p" 2>/dev/null; echo "rc=$?")"
t "failing helpers: every line printed, exit 0" "stage: unknown|status: active|specs: 1|reports: 0|active-spec: |spec-state-error: spec-state.sh exited 1|next-row: |roadmap-error: roadmap.sh exited 3|rc=0" "$(printf '%s' "$out" | tr '\n' '|')"

# A spec-state.sh that CRASHES is not "no spec owed work": its silence would
# send an already specified row back to planning. `stage: unknown`, named.
ssonly="$tmp/ss-only"; mkdir -p "$ssonly"
for h in roadmap.sh open-clarifications.sh; do ln -s "$(cd "$(dirname "$SUT")/../../close/scripts" && pwd)/$h" "$ssonly/$h"; done
printf 'echo boom >&2; exit 7\n' >"$ssonly/spec-state.sh"
p="$(mk ss-crash active)"; roadmap "$p" '| R1 | a | i | s | — | planned | `specs/001-a/` |'
mkdir -p "$p/specs/001-a"; : >"$p/specs/001-a/spec.md"
t "a crashed spec-state.sh is stage unknown" "unknown" "$(CONTEXTIUM_CLOSE_SCRIPTS="$ssonly" bash "$SUT" "$p" 2>/dev/null | sed -n 's/^stage: //p')"
t "…and names the failure" "spec-state.sh exited 7" "$(CONTEXTIUM_CLOSE_SCRIPTS="$ssonly" bash "$SUT" "$p" 2>/dev/null | sed -n 's/^spec-state-error: //p')"
p="$(mk ss-crash-mon monitor)"; : >"$p/a.spec.md"
t "a status that wins still wins over a crashed helper" "monitor" "$(CONTEXTIUM_CLOSE_SCRIPTS="$ssonly" bash "$SUT" "$p" 2>/dev/null | sed -n 's/^stage: //p')"

# Folder specs with no ROADMAP.md: the folder spec owed work is the active one.
p="$(mk folders-only active)"; mkdir -p "$p/specs/001-a"; : >"$p/specs/001-a/spec.md"
t "folder spec, no roadmap: ready-to-implement" "ready-to-implement $p/specs/001-a/spec.md" "$(field "$p" stage) $(field "$p" active-spec)"
t "folder spec, no roadmap: no next-row line" "" "$(run "$p" | grep '^next-row' || true)"

# The status is read from the frontmatter only; a body line is prose.
p="$(mk body-status active)"; printf '\nstatus: completed\n' >>"$p/README.md"
t "a body status: line is not the field" "active" "$(field "$p" status)"

p="$(mk slash active)"; : >"$p/a.spec.md"
t "a trailing slash on the path reads the same" "$p/a.spec.md" "$(field "$p/" active-spec)"

p="$(mk no-status active)"; printf -- '---\nproject: x\n---\n' >"$p/README.md"
t "no status field is unknown" "unknown unknown" "$(field "$p" stage) $(field "$p" status)"
printf '\nstatus: active\n' >>"$p/README.md"
t "a body status: line does not stand in for a missing field" "unknown unknown" "$(field "$p" stage) $(field "$p" status)"

echo "detect-stage.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
