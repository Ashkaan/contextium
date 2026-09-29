#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures hold literal backticks and $ in single quotes
# spec-state.test.sh — peer of spec-state.sh.
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/spec-state.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: $2"; echo "  actual  : $3"; fi
}
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mk() { mkdir -p "$tmp/$1"; printf '%s\n' "${2:-}" >"$tmp/$1/README.md"; }
state() { bash "$SUT" "$tmp/$1" 2>&1 | awk -v n="$2" '$1==n {print $2}'; }

# 1. no report at all → none
mk p1; : >"$tmp/p1/alpha.spec.md"
t "no report is none" "none" "$(state p1 alpha)"

# 2. exact filename, no declaration → complete (the legacy convention)
mk p2; : >"$tmp/p2/alpha.spec.md"; echo "# report" >"$tmp/p2/alpha-report.md"
t "exact filename is complete" "complete" "$(state p2 alpha)"

# 3. qualified filename, no declaration → partial, NOT complete and NOT none
mk p3; : >"$tmp/p3/phase-2.spec.md"; echo "# r" >"$tmp/p3/phase-2-sync-freshness-report.md"
t "qualified filename is partial" "partial" "$(state p3 phase-2)"

# 4. prose declaration wins: qualified name but Status COMPLETE → complete
mk p4; : >"$tmp/p4/phase-2.spec.md"
printf '# R\n\n**SPEC**: `phase-2.spec.md` § 7\n**Status**: COMPLETE — shipped\n' >"$tmp/p4/phase-2-sync-report.md"
t "prose COMPLETE is complete" "complete" "$(state p4 phase-2)"

# 5. prose PARTIAL → partial even with the exact filename
mk p5; : >"$tmp/p5/alpha.spec.md"
printf '# R\n\n**SPEC**: `alpha.spec.md`\n**Status**: PARTIAL — half done\n' >"$tmp/p5/alpha-report.md"
t "prose PARTIAL beats exact filename" "partial" "$(state p5 alpha)"

# 6. frontmatter beats prose
mk p6; : >"$tmp/p6/alpha.spec.md"
printf -- '---\nspec: alpha\nspec-status: partial\n---\n\n**Status**: COMPLETE\n' >"$tmp/p6/alpha-report.md"
t "frontmatter beats prose" "partial" "$(state p6 alpha)"

# 7. a report whose FILENAME relates to nothing, but declares the spec
mk p7; : >"$tmp/p7/beta.spec.md"
printf '# R\n\n**SPEC**: `beta.spec.md`\n**Status**: COMPLETE\n' >"$tmp/p7/wholly-unrelated-report.md"
t "declaration found by name not filename" "complete" "$(state p7 beta)"

# 8. any one complete among several reports wins
mk p8; : >"$tmp/p8/gamma.spec.md"
printf '**SPEC**: `gamma.spec.md`\n**Status**: PARTIAL\n' >"$tmp/p8/gamma-a-report.md"
printf '**SPEC**: `gamma.spec.md`\n**Status**: COMPLETE\n' >"$tmp/p8/gamma-b-report.md"
t "one complete among many is complete" "complete" "$(state p8 gamma)"

# 9. CODE COMPLETE / NOT IMPLEMENTED fail toward partial, never complete
mk p9; : >"$tmp/p9/delta.spec.md"
printf '**SPEC**: `delta.spec.md`\n**Status**: CODE COMPLETE — not shipped\n' >"$tmp/p9/delta-report.md"
t "CODE COMPLETE is partial" "partial" "$(state p9 delta)"
mk p10; : >"$tmp/p10/eps.spec.md"
printf '**SPEC**: `eps.spec.md`\n**Status**: NOT IMPLEMENTED\n' >"$tmp/p10/eps-report.md"
t "NOT IMPLEMENTED is partial" "partial" "$(state p10 eps)"

# 10. legacy *.plan.md is recognised alongside *.spec.md
mk p11; : >"$tmp/p11/legacy.plan.md"; echo x >"$tmp/p11/legacy-report.md"
t "legacy plan file recognised" "complete" "$(state p11 legacy)"

# 11. a prefix collision must not leak: alpha-2.spec.md is not alpha's report
mk p12; : >"$tmp/p12/alpha.spec.md"; : >"$tmp/p12/alpha-2.spec.md"
echo x >"$tmp/p12/alpha-2-report.md"
t "sibling spec's report is not this spec's" "none" "$(state p12 alpha)"

# 12. The spec-kit layout: a folder `specs/NNN-name/` is its own spec, named by
# its path, and its report is that folder's report.md frontmatter.
mk p13; mkdir -p "$tmp/p13/specs/001-x"; : >"$tmp/p13/specs/001-x/spec.md"
t "folder spec with no report is none" "none" "$(state p13 specs/001-x)"
printf -- '---\nspec: 001-x\nspec-status: complete\n---\n' >"$tmp/p13/specs/001-x/report.md"
t "folder report claiming complete is complete" "complete" "$(state p13 specs/001-x)"
printf -- '---\nspec: 001-x\nspec-status: partial\n---\n' >"$tmp/p13/specs/001-x/report.md"
t "folder report claiming partial is partial" "partial" "$(state p13 specs/001-x)"
printf '# report\n\n**Status**: COMPLETE\n' >"$tmp/p13/specs/001-x/report.md"
t "folder report with no frontmatter is partial" "partial" "$(state p13 specs/001-x)"

# 13. A top-level report never completes a folder spec, even by its name
mk p14; mkdir -p "$tmp/p14/specs/001-x"; : >"$tmp/p14/specs/001-x/spec.md"
printf -- '---\nspec: specs/001-x\nspec-status: complete\n---\n' >"$tmp/p14/001-x-report.md"
t "top-level report does not complete a folder" "none" "$(state p14 specs/001-x)"

# 14. A legacy 001-x.spec.md beside a folder specs/001-x/ are two names
mk p15; mkdir -p "$tmp/p15/specs/001-x"; : >"$tmp/p15/specs/001-x/spec.md"; : >"$tmp/p15/001-x.spec.md"
echo x >"$tmp/p15/001-x-report.md"
t "legacy and folder are distinct names" "001-x complete
specs/001-x none" "$(bash "$SUT" "$tmp/p15" | cut -f1,2 | tr '\t' ' ')"

# 15. A specs/ folder of loose files is invisible, as it always was
mk p16; mkdir -p "$tmp/p16/specs"; : >"$tmp/p16/specs/old.spec.md"
t "loose files under specs/ are not specs" "" "$(bash "$SUT" "$tmp/p16")"

# 16. The one-line header older reports carry: SPEC and Status on one line.
mk p17; : >"$tmp/p17/gamma.spec.md"
printf '# Implementation Report\n**SPEC**: `projects/web/2026-01-10_checkout-flow/gamma.spec.md`  **Status**: PARTIAL\n' >"$tmp/p17/gamma-report.md"
t "same-line SPEC and Status read" "partial" "$(state p17 gamma)"
printf '# Implementation Report\n**SPEC**: `gamma.spec.md`  **Status**: COMPLETE\n' >"$tmp/p17/gamma-report.md"
t "same-line COMPLETE is complete" "complete" "$(state p17 gamma)"

echo "spec-state.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
