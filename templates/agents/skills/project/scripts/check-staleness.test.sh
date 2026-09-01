#!/usr/bin/env bash
# check-staleness.test.sh — proof-of-catch for check-staleness.sh's EXPIRED scan.
#
# Builds a throwaway project tree in $TMPDIR (never inside the repo, per
# @rule:claude-scripts-tested-outside-claude), runs the script against it, and
# asserts one row per boundary case from @rule:boundary-inputs:
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
# Plus two regression rows for defects the EXPIRED work uncovered in the
# pre-existing STALE scan (each documented at its assertion below): a
# never-mentioned project must not abort the scan, and a folder-form journal
# mention must count as a mention.
#
# Run: bash .agents/skills/project/scripts/check-staleness.test.sh

set -uo pipefail

CHECK="$(cd "$(dirname "$0")" && pwd)/check-staleness.sh"
export TZ="America/Los_Angeles"

FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/check-staleness-test.XXXXXX")
trap 'rm -rf "$FIXTURE"' EXIT

TODAY=$(date +%Y-%m-%d)
PAST=$(date -d "10 days ago" +%Y-%m-%d)
FUTURE=$(date -d "10 days" +%Y-%m-%d)

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

# Regression, found 2026-08-18: the pre-EXPIRED script ran `set -euo pipefail`,
# so the first project with NO journal mention made `grep -l` fail the pipeline
# and killed the whole scan — it printed nothing and exited 1. Both rows below
# must appear, and the run must exit 0.
NEVER=$(mktemp -d "${TMPDIR:-/tmp}/check-staleness-never.XXXXXX")
mkdir -p "$NEVER/projects/ai/2026-01-01_aaa-never" "$NEVER/projects/ai/2026-01-01_zzz-later" "$NEVER/journal"
printf -- '---\nstatus: active\npriority: high\n---\n' > "$NEVER/projects/ai/2026-01-01_aaa-never/README.md"
printf -- '---\nstatus: active\npriority: high\n---\n' > "$NEVER/projects/ai/2026-01-01_zzz-later/README.md"
: > "$NEVER/journal/2020-01-01.md"
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

# Regression, found 2026-08-18: the slug matcher used `\b`, which cannot match
# the folder form a journal actually writes (`projects/x/2026-08-17_my-slug/`)
# because `_` is a word character. Projects written up yesterday reported
# `never`. `my-slug` must be seen in the folder form; `my-slug-extended` must
# NOT be matched by a search for `my-slug`.
MATCH=$(mktemp -d "${TMPDIR:-/tmp}/check-staleness-match.XXXXXX")
mkdir -p "$MATCH/projects/ai/2026-01-01_my-slug" "$MATCH/projects/ai/2026-01-01_lonely-slug" "$MATCH/journal"
printf -- '---\nstatus: active\npriority: high\n---\n' > "$MATCH/projects/ai/2026-01-01_my-slug/README.md"
printf -- '---\nstatus: active\npriority: high\n---\n' > "$MATCH/projects/ai/2026-01-01_lonely-slug/README.md"
echo 'Worked on projects/ai/2026-01-01_my-slug/ and on lonely-slug-extended today.' \
  > "$MATCH/journal/$(date +%Y-%m-%d).md"
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
