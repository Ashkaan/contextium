#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures hold literal backticks and $ in single quotes
# project-remaining-work.test.sh — covers the veto signals (un-reported SPEC,
# open shard row, unchecked Next Steps box) and the clean no-hard-signal case
# that lets /close step-2.1 flip a finished project.
# Run: bash project-remaining-work.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GEN="$SCRIPT_DIR/project-remaining-work.sh"
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

field() { # field <key> <output>
  printf '%s\n' "$2" | sed -nE "s/^$1: (.*)/\1/p" | head -n1
}

mkproj() { # mkproj <folder-name> <status>
  local dir="$TMP/projects/web/$1"
  mkdir -p "$dir"
  {
    echo "---"
    echo "status: $2"
    echo "---"
    echo "# project"
  } >"$dir/README.md"
  printf '%s' "$dir"
}

# 1. Un-reported SPEC → work-remains (the deterministic veto).
d="$(mkproj "2026-01-01_pending-spec" active)"
: >"$d/foo.spec.md"
out="$("$GEN" "$d")"
check "pending-spec-verdict" "work-remains" "$(field verdict "$out")"
check "pending-spec-count" "1" "$(field unreported_specs "$out")"

# 2. Every SPEC reported, no Next Steps → no-hard-signal (flip candidate).
d="$(mkproj "2026-02-02_all-reported" active)"
: >"$d/foo.spec.md"
: >"$d/foo-report.md"
out="$("$GEN" "$d")"
check "all-reported-verdict" "no-hard-signal" "$(field verdict "$out")"
check "all-reported-specs" "0" "$(field unreported_specs "$out")"
check "all-reported-next-steps" "no" "$(field next_steps_section "$out")"

# 3. Open shard row → work-remains even with every SPEC reported.
d="$(mkproj "2026-03-03_sharded" active)"
: >"$d/a.spec.md"
: >"$d/a-report.md"
: >"$d/b.spec.md"
: >"$d/b-report.md"
{
  echo "## Shard Status"
  echo ""
  echo "| Shard | SPEC | Report | State |"
  echo "|---|---|---|---|"
  echo "| a | \`a.spec.md\` | \`a-report.md\` | closed |"
  echo "| b | \`b.spec.md\` | — | in-flight |"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "open-shard-verdict" "work-remains" "$(field verdict "$out")"
check "open-shard-count" "1" "$(field shard_open "$out")"
check "open-shard-row" "b in-flight" "$(field shard "$out")"
check "shard-table-present" "yes" "$(field shard_table "$out")"

# 4. All shard rows closed → no-hard-signal (header + separator not counted).
d="$(mkproj "2026-04-04_shards-closed" active)"
: >"$d/a.spec.md"
: >"$d/a-report.md"
{
  echo "## Shard Status"
  echo ""
  echo "| Shard | SPEC | Report | State |"
  echo "|---|---|---|---|"
  echo "| a | \`a.spec.md\` | \`a-report.md\` | closed |"
  echo "| b | \`b.spec.md\` | \`b-report.md\` | dropped |"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "closed-shards-verdict" "no-hard-signal" "$(field verdict "$out")"
check "closed-shards-count" "0" "$(field shard_open "$out")"

# 5. Unchecked box under ## Next Steps → work-remains; checked ones ignored,
#    and a box in a LATER section does not leak in.
d="$(mkproj "2026-05-05_open-todos" active)"
{
  echo "## Next Steps"
  echo ""
  echo "- [x] shipped the parser"
  echo "- [ ] wire the dashboard"
  echo ""
  echo "## Notes"
  echo ""
  echo "- [ ] not a next step"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "open-todo-verdict" "work-remains" "$(field verdict "$out")"
check "open-todo-count" "1" "$(field next_steps_unchecked "$out")"
check "open-todo-text" "wire the dashboard" "$(field todo "$out")"

# 6. All boxes checked → no-hard-signal.
d="$(mkproj "2026-06-06_todos-done" active)"
{
  echo "## Next Steps"
  echo ""
  echo "- [x] shipped the parser"
  echo "- [x] wired the dashboard"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "done-todos-verdict" "no-hard-signal" "$(field verdict "$out")"
check "done-todos-count" "0" "$(field next_steps_unchecked "$out")"

# 7. Status is echoed verbatim for the caller's gate.
d="$(mkproj "2026-07-07_monitoring" monitor)"
out="$("$GEN" "$d")"
check "status-echo" "monitor" "$(field status "$out")"

# 8. Missing README → exit 2, not a silent pass.
mkdir -p "$TMP/projects/web/2026-08-08_no-readme"
set +e
"$GEN" "$TMP/projects/web/2026-08-08_no-readme" >/dev/null 2>&1
rc=$?
set -e
check "missing-readme-exit2" "2" "$rc"

# ── Backlogs that are not checkboxes ───────────────────────────────────
#
# Counting only unchecked boxes under a case-SENSITIVE heading clears projects that
# carry written backlogs, and misses one whose heading is "## Next steps". Each
# shape below is one of those cases.

# 9. A numbered backlog is real work, not an empty one.
d="$(mkproj "2026-08-10_numbered" active)"
{
  echo "## Next Steps"
  echo ""
  echo "1. approve the wording"
  echo "2. watch two mornings"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "numbered-verdict" "work-remains" "$(field verdict "$out")"
check "numbered-unparsed" "2" "$(field next_steps_unparsed "$out")"
check "numbered-not-counted-as-boxes" "0" "$(field next_steps_unchecked "$out")"

# 10. The heading matches whatever case the author used.
d="$(mkproj "2026-08-10_lowercase" active)"
{
  echo "## Next steps"
  echo ""
  echo "- [ ] a real checkbox under a lowercase heading"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "lowercase-heading-section" "yes" "$(field next_steps_section "$out")"
check "lowercase-heading-verdict" "work-remains" "$(field verdict "$out")"

# 11. Plain bullets and lettered items, in BOTH cases, all count.
d="$(mkproj "2026-08-10_bullets" active)"
{
  echo "## Next Steps"
  echo ""
  echo "- a plain bullet"
  echo "a. a lowercase lettered item"
  echo "A. an uppercase lettered item"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "bullets-unparsed" "3" "$(field next_steps_unparsed "$out")"
check "bullets-verdict" "work-remains" "$(field verdict "$out")"

# 12. It must NOT over-fire. Narrative prose with no list markers is not a backlog,
#     and pinning those projects active forever would make the veto useless the other way.
d="$(mkproj "2026-08-10_prose" active)"
{
  echo "## Next Steps"
  echo ""
  echo "Nothing further. Watch it for a week and close."
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "prose-verdict" "no-hard-signal" "$(field verdict "$out")"
check "prose-unparsed" "0" "$(field next_steps_unparsed "$out")"

# 13. A checked box is DONE — neither a todo nor unparsed.
d="$(mkproj "2026-08-10_checked" active)"
{
  echo "## Next Steps"
  echo ""
  echo "- [x] shipped"
  echo "- [X] also shipped"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "checked-unparsed" "0" "$(field next_steps_unparsed "$out")"
check "checked-verdict" "no-hard-signal" "$(field verdict "$out")"

# 14. Mixed: an open box AND a numbered leftover are counted separately, both remain.
d="$(mkproj "2026-08-10_mixed" active)"
{
  echo "## Next Steps"
  echo ""
  echo "- [ ] a real box"
  echo "1. and a numbered leftover"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "mixed-unchecked" "1" "$(field next_steps_unchecked "$out")"
check "mixed-unparsed" "1" "$(field next_steps_unparsed "$out")"
check "mixed-verdict" "work-remains" "$(field verdict "$out")"

# 15. A list under a DIFFERENT heading is not this section's backlog.
d="$(mkproj "2026-08-10_other-section" active)"
{
  echo "## Next Steps"
  echo ""
  echo "- [x] done"
  echo ""
  echo "## Notes"
  echo ""
  echo "1. not a next step"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "other-section-unparsed" "0" "$(field next_steps_unparsed "$out")"
check "other-section-verdict" "no-hard-signal" "$(field verdict "$out")"

# 16. Sub-bullets under a COMPLETED box are explanation, not backlog. Counting them
#     would pin a finished checklist work-remains forever — the same defect as
#     under-counting, pointed the other way.
d="$(mkproj "2026-08-10_nested-under-done" active)"
{
  echo "## Next Steps"
  echo ""
  echo "- [x] shipped the parser"
  echo "  - it handles the fullwidth mark"
  echo "  - and the inverted one"
  echo "- [x] wired the dashboard"
  echo "  1. behind the feature flag"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "nested-under-done-unparsed" "0" "$(field next_steps_unparsed "$out")"
check "nested-under-done-verdict" "no-hard-signal" "$(field verdict "$out")"

# 17. A nested UNCHECKED box is still open work, at any depth.
d="$(mkproj "2026-08-10_nested-open-box" active)"
{
  echo "## Next Steps"
  echo ""
  echo "- [x] the parent shipped"
  echo "  - [ ] but this child has not"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "nested-open-box-count" "1" "$(field next_steps_unchecked "$out")"
check "nested-open-box-verdict" "work-remains" "$(field verdict "$out")"

# 18. All three markdown bullet markers are checkboxes, at any depth. Recognizing only
#     `-` and `*` meant a `+ [ ]` was not a box, and once unparsed narrowed to column
#     zero a NESTED one was counted as nothing at all.
d="$(mkproj "2026-08-10_plus-boxes" active)"
{
  echo "## Next Steps"
  echo ""
  echo "+ [ ] a top-level plus box"
  echo "- [x] a done parent"
  echo "  + [ ] a nested plus box"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "plus-box-count" "2" "$(field next_steps_unchecked "$out")"
check "plus-box-unparsed" "0" "$(field next_steps_unparsed "$out")"
check "plus-box-verdict" "work-remains" "$(field verdict "$out")"

# 19. A completed `+ [x]` is done, same as its two siblings.
d="$(mkproj "2026-08-10_plus-done" active)"
{
  echo "## Next Steps"
  echo ""
  echo "+ [x] shipped"
} >>"$d/README.md"
out="$("$GEN" "$d")"
check "plus-done-verdict" "no-hard-signal" "$(field verdict "$out")"

# ── ROADMAP.md projects ─────────────────────────────────────────────
RM_HDR='| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|'
mkroadmap() { # mkroadmap <dir> <rows...>
  local d="$1"; shift
  { printf '# Roadmap: t\n\n%s\n' "$RM_HDR"; local r; for r in "$@"; do printf '%s\n' "$r"; done; } >"$d/ROADMAP.md"
}

# A legacy project prints no roadmap lines at all.
d="$(mkproj "2026-09-01_no-roadmap" active)"
out="$("$GEN" "$d")"
check "legacy-no-roadmap-lines" "" "$(printf '%s\n' "$out" | grep '^roadmap' || true)"

# Header-only table: nothing open.
d="$(mkproj "2026-09-02_rm-empty" active)"; mkroadmap "$d"
out="$("$GEN" "$d")"
check "rm-empty-table" "yes" "$(field roadmap_table "$out")"
check "rm-empty-open" "0" "$(field roadmap_open "$out")"
check "rm-empty-verdict" "no-hard-signal" "$(field verdict "$out")"

# Open rows — planned, blocked watch, unknown status — are named; done and
# absorbed are not.
d="$(mkproj "2026-09-03_rm-open" active)"
mkroadmap "$d" \
  '| R1 | a | i | s | — | done | — |' \
  '| R2 | b | i | s | — | absorbed by R1 | — |' \
  '| R3 | c | i | s | — | planned | — |' \
  '| R4 | d | i | s | — | blocked: 2026-10-02 | — |' \
  '| R5 | e | i | s | — | waiting on the vendor | — |'
out="$("$GEN" "$d" 2>/dev/null)"
check "rm-open-count" "3" "$(field roadmap_open "$out")"
check "rm-open-rows" "roadmap: R3 planned
roadmap: R4 blocked: 2026-10-02
roadmap: R5 waiting on the vendor" "$(printf '%s\n' "$out" | grep '^roadmap: ')"
check "rm-open-verdict" "work-remains" "$(field verdict "$out")"
check "rm-block-before-verdict" "verdict: work-remains" "$(printf '%s\n' "$out" | tail -n1)"

# Every row done → no-hard-signal.
d="$(mkproj "2026-09-04_rm-done" active)"
mkroadmap "$d" '| R1 | a | i | s | — | done | — |' '| R2 | b | i | s | — | absorbed by R1 | — |'
out="$("$GEN" "$d")"
check "rm-done-verdict" "no-hard-signal" "$(field verdict "$out")"

# Malformed table → roadmap-error and work-remains, never a completion.
d="$(mkproj "2026-09-05_rm-bad" active)"
printf '# Roadmap: t\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n' >"$d/ROADMAP.md"
out="$("$GEN" "$d")"
check "rm-bad-error" "no table under \`# Roadmap\` with ID and Status columns" "$(field roadmap-error "$out")"
check "rm-bad-verdict" "work-remains" "$(field verdict "$out")"

# A folder spec still owed work counts as an unreported spec.
d="$(mkproj "2026-09-06_rm-folder" active)"
mkroadmap "$d" '| R1 | a | i | s | — | in-progress | `specs/001-a/` |'
mkdir -p "$d/specs/001-a"; : >"$d/specs/001-a/spec.md"
out="$("$GEN" "$d")"
check "rm-folder-spec" "specs/001-a none" "$(field spec "$out")"

# A ROADMAP project ignores a leftover README ## Next Steps list: the roadmap
# is its one list of outstanding work.
d="$(mkproj "2026-09-07_rm-stale-list" active)"
mkroadmap "$d" '| R1 | a | i | s | — | done | — |'
printf '\n## Next Steps\n\n- [ ] an old todo\n1. an old numbered item\n' >>"$d/README.md"
out="$("$GEN" "$d")"
check "rm-ignores-next-steps-verdict" "no-hard-signal" "$(field verdict "$out")"
check "rm-reports-no-next-steps-section" "no" "$(field next_steps_section "$out")"

echo "── project-remaining-work: $pass passed, $fail failed ──"
[[ "$fail" -eq 0 ]]
