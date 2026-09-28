#!/usr/bin/env bash
# check-staleness.test.sh — proof-of-catch for check-staleness.sh's EXPIRED scan.
#
# Builds a throwaway project tree in $TMPDIR (never inside the repo, so the
# real projects are never scanned), runs the script against it, and asserts one
# row per boundary case from @rule:boundary-inputs:
#
#   past bare date          → EXPIRED with the right days-overdue
#   past quoted date+prose  → EXPIRED (quote + trailing colons must not break it)
#   date == today           → silent (the day is still being watched)
#   future date             → silent
#   missing monitoring-until→ NOWINDOW
#   unparseable value       → NOWINDOW
#   status: active w/ date  → silent (EXPIRED is monitor-only)
#   body prose mentioning the field → silent (frontmatter only)
#   --expired-only          → emits no STALE line even with an empty journal dir
#   empty project tree      → no output, exit 0
#
# Plus STALE rows: a never-mentioned project must not abort the scan, a
# folder-form mention counts, and both journal shapes (a day folder, and the
# older one-file day) are read.
#
# Run: bash .agents/skills/project/scripts/check-staleness.test.sh

set -uo pipefail

CHECK="$(cd "$(dirname "$0")" && pwd)/check-staleness.sh"

FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/check-staleness-test.XXXXXX")
trap 'rm -rf "$FIXTURE"' EXIT

TODAY=$(date +%Y-%m-%d)
# GNU date, else BSD date (macOS).
PAST=$(date -d "10 days ago" +%Y-%m-%d 2>/dev/null || date -v-10d +%Y-%m-%d)
FUTURE=$(date -d "10 days" +%Y-%m-%d 2>/dev/null || date -v+10d +%Y-%m-%d)
OLD=$(date -d "30 days ago" +%Y-%m-%d 2>/dev/null || date -v-30d +%Y-%m-%d)

mk() { # mk <domain> <slug> <frontmatter-body>
  local dir="$FIXTURE/projects/$1/2026-01-01_$2"
  mkdir -p "$dir"
  { echo "---"; printf '%s\n' "$3"; echo "---"; echo; echo "# $2"; } > "$dir/README.md"
}

mk ai bare-past "status: monitor
priority: high
monitoring-until: $PAST"

mk ai quoted-past "status: monitor
priority: high
monitoring-until: \"$PAST — prose: with a colon, and \"\"quotes\"\" inside.\""

mk ai ends-today "status: monitor
priority: high
monitoring-until: $TODAY"

mk ai future-window "status: monitor
priority: high
monitoring-until: $FUTURE — still watching."

mk ai no-field "status: monitor
priority: high"

mk ai garbage-date "status: monitor
priority: high
monitoring-until: sometime next quarter"

mk ai active-with-date "status: active
priority: high
monitoring-until: $PAST"

mk ai body-mention "status: monitor
priority: high
monitoring-until: $FUTURE"
cat >> "$FIXTURE/projects/ai/2026-01-01_body-mention/README.md" <<'BODY'

## Next Steps
1. `monitoring-until: 2020-01-01` lapsed long ago — this is prose, not a field.
monitoring-until: 2020-01-01
BODY

mkdir -p "$FIXTURE/journal"

cd "$FIXTURE" || exit 1
OUT=$(bash "$CHECK" --expired-only)

FAILED=0
expect_line() { # expect_line <description> <regex>
  if printf '%s\n' "$OUT" | grep -qE "$2"; then
    echo "  ok   — $1"
  else
    echo "  FAIL — $1 (no line matching: $2)"
    FAILED=1
  fi
}
expect_absent() { # expect_absent <description> <regex>
  if printf '%s\n' "$OUT" | grep -qE "$2"; then
    echo "  FAIL — $1 (unexpected line matching: $2)"
    FAILED=1
  else
    echo "  ok   — $1"
  fi
}

echo "check-staleness EXPIRED scan"
expect_line   "past bare date flags with days-overdue=10"  "^EXPIRED:ai/bare-past:monitoring-until=${PAST}:days-overdue=10$"
expect_line   "quoted date + prose with colons still parses" "^EXPIRED:ai/quoted-past:monitoring-until=${PAST}:days-overdue=10$"
expect_absent "window ending today is not overdue"         "ends-today"
expect_absent "future window is silent"                    "future-window"
expect_line   "missing monitoring-until is NOWINDOW"       "^NOWINDOW:ai/no-field$"
expect_line   "unparseable date is NOWINDOW"               "^NOWINDOW:ai/garbage-date$"
expect_absent "status: active is not scanned for expiry"   "active-with-date"
expect_absent "body prose is not read as frontmatter"      "body-mention"
expect_absent "--expired-only emits no STALE rows"         "^STALE:"

# A project with NO journal mention makes `grep -l` fail; under `pipefail` that
# used to kill the whole scan. Both rows below must appear, and the run must
# exit 0.
NEVER=$(mktemp -d "${TMPDIR:-/tmp}/check-staleness-never.XXXXXX")
mkdir -p "$NEVER/projects/ai/2026-01-01_aaa-never" "$NEVER/projects/ai/2026-01-01_zzz-later" "$NEVER/journal"
printf -- '---\nstatus: active\npriority: high\n---\n' > "$NEVER/projects/ai/2026-01-01_aaa-never/README.md"
printf -- '---\nstatus: active\npriority: high\n---\n' > "$NEVER/projects/ai/2026-01-01_zzz-later/README.md"
mkdir -p "$NEVER/journal/2020-01-01"
: > "$NEVER/journal/2020-01-01/0900-nothing.md"
cd "$NEVER" || exit 1
NEVER_OUT=$(bash "$CHECK"); NEVER_RC=$?
cd "$FIXTURE" || exit 1
rm -rf "$NEVER"
if [ "$NEVER_RC" -eq 0 ] \
  && printf '%s\n' "$NEVER_OUT" | grep -q '^STALE:ai/aaa-never:days-since-last-mention=never$' \
  && printf '%s\n' "$NEVER_OUT" | grep -q '^STALE:ai/zzz-later:days-since-last-mention=never$'; then
  echo "  ok   — a never-mentioned project does not abort the scan"
else
  echo "  FAIL — never-mentioned project aborted the scan (rc=$NEVER_RC, out='$NEVER_OUT')"
  FAILED=1
fi

# A `\b` matcher cannot match the folder form a journal writes
# (`projects/x/2026-01-01_my-slug/`) because `_` is a word character. `my-slug`
# must be seen in the folder form; `lonely-slug-extended` must NOT be matched by
# a search for `lonely-slug`.
MATCH=$(mktemp -d "${TMPDIR:-/tmp}/check-staleness-match.XXXXXX")
mkdir -p "$MATCH/projects/ai/2026-01-01_my-slug" "$MATCH/projects/ai/2026-01-01_lonely-slug" \
  "$MATCH/journal/$(date +%Y-%m-%d)"
printf -- '---\nstatus: active\npriority: high\n---\n' > "$MATCH/projects/ai/2026-01-01_my-slug/README.md"
printf -- '---\nstatus: active\npriority: high\n---\n' > "$MATCH/projects/ai/2026-01-01_lonely-slug/README.md"
echo 'Worked on projects/ai/2026-01-01_my-slug/ and on lonely-slug-extended today.' \
  > "$MATCH/journal/$(date +%Y-%m-%d)/0900-a-session.md"
cd "$MATCH" || exit 1
MATCH_OUT=$(bash "$CHECK")
cd "$FIXTURE" || exit 1
rm -rf "$MATCH"
if printf '%s\n' "$MATCH_OUT" | grep -q 'my-slug'; then
  echo "  FAIL — folder-form mention still read as stale (out='$MATCH_OUT')"
  FAILED=1
else
  echo "  ok   — a folder-form journal mention counts as a mention"
fi
if printf '%s\n' "$MATCH_OUT" | grep -q '^STALE:ai/lonely-slug:days-since-last-mention=never$'; then
  echo "  ok   — a longer slug that contains this one is not a mention"
else
  echo "  FAIL — 'lonely-slug-extended' wrongly counted as a mention of 'lonely-slug' (out='$MATCH_OUT')"
  FAILED=1
fi

# Both journal shapes, and the newest mention wins: a one-file day
# (`journal/<date>.md`) 30 days back and a day folder 10 days back put the last
# mention at 10 days; with a 7-day cutoff that is STALE at 10.
SHAPES=$(mktemp -d "${TMPDIR:-/tmp}/check-staleness-shapes.XXXXXX")
mkdir -p "$SHAPES/projects/web/2026-01-10_checkout-flow" "$SHAPES/journal/$PAST"
printf -- '---\nstatus: active\npriority: high\n---\n' > "$SHAPES/projects/web/2026-01-10_checkout-flow/README.md"
echo 'checkout-flow: first pass' > "$SHAPES/journal/$OLD.md"
echo 'checkout-flow: second pass' > "$SHAPES/journal/$PAST/1400-checkout.md"
cd "$SHAPES" || exit 1
SHAPES_OUT=$(bash "$CHECK" 7)
cd "$FIXTURE" || exit 1
rm -rf "$SHAPES"
if [ "$SHAPES_OUT" = "STALE:web/checkout-flow:days-since-last-mention=10" ]; then
  echo "  ok   — day folders and one-file days are both read; newest wins"
else
  echo "  FAIL — expected STALE at 10 days from the day folder, got '$SHAPES_OUT'"
  FAILED=1
fi

# Empty tree → empty output, exit 0.
EMPTY=$(mktemp -d "${TMPDIR:-/tmp}/check-staleness-empty.XXXXXX")
mkdir -p "$EMPTY/projects" "$EMPTY/journal"
cd "$EMPTY" || exit 1
EMPTY_OUT=$(bash "$CHECK" --expired-only); EMPTY_RC=$?
rm -rf "$EMPTY"
if [ -z "$EMPTY_OUT" ] && [ "$EMPTY_RC" -eq 0 ]; then
  echo "  ok   — no projects: empty output, exit 0"
else
  echo "  FAIL — no projects: expected empty output + exit 0, got rc=$EMPTY_RC out='$EMPTY_OUT'"
  FAILED=1
fi

[ "$FAILED" -eq 0 ] && echo "PASS" || echo "FAIL"
exit "$FAILED"
