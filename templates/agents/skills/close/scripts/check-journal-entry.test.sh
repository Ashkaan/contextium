#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures are literal markdown; backticks are not expansions
# check-journal-entry.test.sh — peer of check-journal-entry.sh.
# Every refusing case has a passing neighbour, because a false positive here
# refuses a close. A refusal must also name its check and the line, since a
# refusal that names the wrong rule sends the writer to the wrong fix.
# Run: bash check-journal-entry.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK="$SCRIPT_DIR/check-journal-entry.sh"
SCHEMA="$SCRIPT_DIR/../references/journal-entry.md"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); echo "ok: $1"; }
bad() { fail=$((fail + 1)); echo "FAIL: $1" >&2; }

# expect <name> <pass|block> <file-content> [needle...]
expect() {
  local name="$1" want="$2" content="$3"; shift 3
  local path="$TMP/$name/1200-a-session.md" out rc needle
  mkdir -p "$TMP/$name"
  printf '%s\n' "$content" >"$path"
  out="$(bash "$CHECK" "$path" 2>&1)"; rc=$?
  if [[ "$want" == pass ]]; then
    if [[ $rc -eq 0 ]]; then ok "$name passed"; else bad "$name — expected PASS, got BLOCK:"; printf '%s\n' "$out" >&2; fi
    return
  fi
  if [[ $rc -eq 0 ]]; then bad "$name — expected BLOCK, got PASS"; return; fi
  for needle in "$@"; do
    if [[ "$out" != *"$needle"* ]]; then
      bad "$name — blocked, but the message lacks '$needle':"; printf '%s\n' "$out" >&2; return
    fi
  done
  ok "$name blocked"
}

FM='---
date: 2026-01-12
time: "12:00"
title: one-off (a session)
project: null
tags: []
---

### one-off (a session)
**Action:** shipped

One line.
'
# body <name> <pass|block> <sections> [needle...] — a valid entry plus sections
body() { local n="$1" w="$2" b="$3"; shift 3; expect "$n" "$w" "$FM
$b" "$@"; }

# ─── J1 / J2 / J3: front matter and heading ─────────────────────────────

expect "minimal" pass "$FM"

expect "quoted-title-with-colon" pass '---
date: 2026-01-12
time: "12:00"
title: "web/2026-01-10_checkout-flow — R2: retry"
---

### web/2026-01-10_checkout-flow — R2: retry
**Action:** shipped'

expect "single-quoted-title" pass "---
date: 2026-01-12
title: 'one-off (a: b)'
---

### one-off (a: b)
**Action:** fixed"

expect "no-front-matter" block '### one-off (a session)
**Action:** fixed' "J1" ":1:"

expect "no-date" block '---
title: one-off (a session)
---

### one-off (a session)' "J1" "date:"

expect "second-front-matter-block" block '---
date: 2026-01-12
title: one-off (a session)
---

### one-off (a session)
**Action:** fixed

---
date: 2026-01-12
title: one-off (another)
---' "J1" ":9:" "second front matter block"

body "j1-body-date-prose-is-not-a-block" pass '**Changes:**
- moved the release

date: the new release date is in the plan'

body "j1-rule-then-date-prose-is-not-a-block" pass '---
date: shipped, see below
and this line is prose, so no block

---'

body "j1-quoted-block-in-a-fence" pass '**Changes:**
- quoted an old entry

```
---
date: 2026-01-01
title: x
---
```'

expect "j1-date-only-in-body" block '---
title: one-off (a session)
---

### one-off (a session)
**Action:** fixed

date: 2026-01-12' "J1" "no \`date:\` key in the front matter"

expect "unclosed-front-matter" block '---
date: 2026-01-12
title: one-off (a session)' "J1" "never closes"

expect "duplicate-tags" block '---
date: 2026-01-12
title: one-off (a session)
tags: [a]
tags: [b]
---

### one-off (a session)' "J2" ":5:" "tags" "line 4"

expect "body-line-looks-like-a-key" pass "$FM
tags: this is prose, not front matter"

expect "body-horizontal-rules" pass "$FM
---

Prose after a rule.

---"

expect "title-disagrees-with-heading" block '---
date: 2026-01-12
title: one-off (a session)
---

### one-off (a different session)' "J3" "a different session"

expect "no-title" block '---
date: 2026-01-12
---

### one-off (a session)' "J3" "no 'title:'"

expect "no-heading" block '---
date: 2026-01-12
title: one-off (a session)
---

**Action:** fixed' "J3" "(none)"

# ─── J5: Decisions bullets ──────────────────────────────────────────────

body "j5-prose-bullet" block '**Decisions:**
- Chose X because Y.' "J5" "1200-a-session.md:15:" "neither a link nor a \`rejected:\` line"

body "j5-link-only" pass '**Decisions:**
- [0003-retry-once](../../projects/web/2026-01-10_checkout-flow/decisions/0003-retry-once.md)'

body "j5-link-trailing-space" pass '**Decisions:**
- [spec 002 § Clarifications](../../projects/web/x/specs/002-retry/spec.md)   '

body "j5-link-with-reasoning" block '**Decisions:**
- [x](decisions/0001-x.md) because y' "J5" ":15:"

body "j5-rejected" pass '**Decisions:**
- rejected: retrying three times — the processor bills each attempt'

# "rejected: " is 10 characters; 488 x's and one em dash (3 bytes, 1 character)
# plus one space make exactly 500 after the "- ".
body "j5-rejected-500-chars-with-em-dash" pass "**Decisions:**
- rejected: $(printf 'x%.0s' $(seq 1 488)) —"
body "j5-rejected-501-chars" block "**Decisions:**
- rejected: $(printf 'x%.0s' $(seq 1 491))" "J5" "501" "500"

body "j5-wrapped-bullet" block '**Decisions:**
- rejected: a long option — with a reason that
  wraps onto a second line' "J5" ":16:" "one line"

body "j5-two-good-one-bad" block '**Decisions:**
- [a](decisions/0001-a.md)
- Chose X because Y.
- rejected: b — c' "J5" ":16:"

body "j5-empty-decisions" pass '**Decisions:**

**Lessons:**
- nothing under Decisions is fine'

body "j5-only-decisions-is-checked" pass '**Decisions:**
- rejected: a — b

**Lessons:**
- Chose X because Y is a fine Lessons bullet'

# ─── J4: the section set ────────────────────────────────────────────────

body "j4-next" block '**Next:**
- follow up later' "J4" ":14:" "Next" "ROADMAP.md" "Blocked"

body "j4-issues" block '**Issues:**
- the thing was broken' "J4" "Issues" "Findings"

body "j4-one-off-label" block '**Verification:**
- ran it' "J4" "Verification"

# shellcheck disable=SC2016  # literal markdown: the backticks belong to the fixture
body "j4-all-seven" pass '**Changes:**
- a

**Findings:**
- b — `grep -n b file`

**Decisions:**
- rejected: c — d

**Corrections:**
- "e"

**Lessons:**
- f

**Blocked:**
- g'

body "j4-bold-lead-in-bullet" pass '**Changes:**
- **Bold lead.** text'

# Fenced code is quoted text, not the entry's own sections.
body "j4-j5-inside-fence" pass '**Changes:**
- quoted an old entry:

```markdown
**Next:**
- follow up

**Decisions:**
- Chose X because Y.
```

~~~
**Issues:**
~~~'

body "j4-unclosed-fence-runs-to-eof" pass '**Changes:**
- an unclosed fence

```
**Next:**'

# ─── Several files: every bad one is named ──────────────────────────────
mkdir -p "$TMP/multi"
printf '%s\n' "$FM" >"$TMP/multi/0900-good.md"
printf '%s\n**Next:**\n- x\n' "$FM" >"$TMP/multi/1000-bad.md"
out="$(bash "$CHECK" "$TMP/multi/0900-good.md" "$TMP/multi/1000-bad.md" 2>&1)"; rc=$?
if [[ $rc -eq 1 && "$out" == *"1000-bad.md"* && "$out" != *"0900-good.md"* ]]; then ok "multi-file names only the bad one"
else bad "multi-file: rc=$rc out=$out"; fi

out="$(bash "$CHECK" "$TMP/does-not-exist.md" 2>&1)"; rc=$?
if [[ $rc -eq 1 && "$out" == *"not a file"* ]]; then ok "a missing file is a failure"; else bad "missing file: rc=$rc"; fi

# ─── The label copy matches journal-entry.md ────────────────────────────
# shellcheck disable=SC2016  # literal markdown pattern
schema_labels="$(sed -n '/^## Section set/,/^\*\*Retired/p' "$SCHEMA" \
  | sed -nE 's/^\| `\*\*([A-Za-z -]+):\*\*` \|.*$/\1/p' | paste -s -d'|' -)"
script_labels="$(sed -nE 's/^SECTION_LABELS="(.*)"$/\1/p' "$CHECK")"
if [[ -n "$schema_labels" && "$schema_labels" == "$script_labels" ]]; then
  ok "section set matches journal-entry.md ($schema_labels)"
else
  bad "section set — journal-entry.md says '$schema_labels', the check says '$script_labels'"
fi

# ─── Staged mode reads the index ────────────────────────────────────────
repo="$TMP/repo"
git init -q "$repo"
git -C "$repo" config user.email t@example.com
git -C "$repo" config user.name Test
mkdir -p "$repo/journal/2026-01-12"
printf '%s\n**Next:**\n- x\n' "$FM" >"$repo/journal/2026-01-12/1200-a.md"
git -C "$repo" add journal
printf '%s\n' "$FM" >"$repo/journal/2026-01-12/1200-a.md"   # repaired on disk only
if (cd "$repo" && bash "$CHECK" >/dev/null 2>&1); then bad "staged: a bad index copy passed because the disk copy was repaired"
else ok "staged mode checks the index copy"; fi
git -C "$repo" add journal
if (cd "$repo" && bash "$CHECK" >/dev/null 2>&1); then ok "staged mode passes once the index is repaired"
else bad "staged: a clean staged entry was refused"; fi
printf '%s\n**Next:**\n- x\n' "$FM" >"$repo/journal/2026-01-12.md"
printf 'x\n' >"$repo/notes.md"
git -C "$repo" add journal/2026-01-12.md notes.md
if (cd "$repo" && bash "$CHECK" >/dev/null 2>&1); then ok "staged mode ignores old day files and non-journal files"
else bad "staged: scanned an old day file or a non-journal file"; fi

echo ""
echo "check-journal-entry.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
