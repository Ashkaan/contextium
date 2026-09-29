#!/usr/bin/env bash
# Test harness for .agents/skills/close/scripts/check-journal-entry.sh
#
# Front-matter fixtures are built from the two corruptions a shared day file
# suffers: a second frontmatter block appended mid-file, and a foreign `- slug:` inserted
# into another session's entry. Clean fixtures cover the shapes that must NOT
# trip the check — most importantly the nested `runtime_identity:` list, whose
# entries legitimately repeat `target:` / `branch:` / `head_sha:` and would be
# false duplicates under a naive key scan. The body fixtures (F6–F8) are the
# shapes close/references/journal-entry.md allows and the ones it retired; every
# refusing case also has a passing neighbour, because a false positive here
# refuses a close.
#
# Exit 0 on all-pass, 1 otherwise.

set -euo pipefail

# Telemetry isolation. When the workbench keeps a mechanism logger, the check
# under test writes a firing line under "$HOME", and a test fixture is not a
# firing — left unredirected, one run of this suite would add entries a report
# counts as real catches. Redirect HOME so the log resolves to a throwaway path.
export HOME="${TMPDIR:-/tmp}/claude-hook-test-home"
mkdir -p "$HOME/.local/share"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK="$SCRIPT_DIR/check-journal-entry.sh"

if [[ ! -f "$CHECK" ]]; then
  echo "FAIL: check script not found at $CHECK" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

# ─── Assertions ──────────────────────────────────────────────────────────

# The historical fixtures are day-shaped (a `sessions:` list), which after the
# 2026-09-13 split is `0000-day.md` — the one file that still carries a list, and
# the one the slug/heading check (F5) skips.
assert_blocks() {
  local name="$1" fixture="$2"
  local path="$TMP/$name/0000-day.md"
  mkdir -p "$TMP/$name"
  printf '%s\n' "$fixture" > "$path"
  if bash "$CHECK" "$path" > /dev/null 2>&1; then
    echo "FAIL: $name — expected BLOCK, got PASS" >&2
    fail=$((fail + 1))
  else
    echo "ok: $name blocked"
    pass=$((pass + 1))
  fi
}

assert_passes() {
  local name="$1" fixture="$2"
  local path="$TMP/$name/0000-day.md"
  mkdir -p "$TMP/$name"
  printf '%s\n' "$fixture" > "$path"
  if bash "$CHECK" "$path" > /dev/null 2>&1; then
    echo "ok: $name passed"
    pass=$((pass + 1))
  else
    echo "FAIL: $name — expected PASS, got BLOCK:" >&2
    bash "$CHECK" "$path" >&2 || true
    fail=$((fail + 1))
  fi
}

# ─── Clean fixtures ──────────────────────────────────────────────────────

assert_passes "single-session" '---
date: 2026-08-03
tags: [ai, telemetry]
sessions:
  - slug: one-off (weekly report triage)
    project: null
    root_cause_status: fixed
---

### one-off (weekly report triage)
**Action:** fixed

Body prose.'

assert_passes "multi-session" '---
date: 2026-08-03
tags: [ai]
sessions:
  - slug: one-off (first)
    project: null
    root_cause_status: fixed
  - slug: ai/2026-08-03_second
    project: projects/ai/2026-08-03_second
    implement_audit_rounds: 2
    rules_should_have_fired: [no-guessing]
---

### one-off (first)
**Action:** fixed'

# The nested list repeats target/branch/head_sha per entry by design. A key
# scan that ignored indent would call every one of these a duplicate.
assert_passes "nested-runtime-identity" '---
date: 2026-08-03
tags: [portals]
sessions:
  - slug: one-off (portal ship)
    project: null
    root_cause_status: fixed
    runtime_identity:
      - target: "finance.example.com"
        branch: main
        head_sha: abc1234
        runtime: "CF Pages finance-example"
        rebuilt: yes
        duplicates_checked: n/a
        evidence: "deployment polled to success"
      - target: "sales.example.com"
        branch: main
        head_sha: def5678
        runtime: "CF Pages sales-example"
        rebuilt: yes
        duplicates_checked: n/a
        evidence: "deployment polled to success"
  - slug: one-off (after the nested block)
    project: null
---

### one-off (portal ship)
**Action:** shipped'

# A slug with no fields at all is legal — plenty of sessions carry only a slug.
assert_passes "slug-only-entries" '---
date: 2026-08-03
tags: [misc]
sessions:
  - slug: one-off (a)
  - slug: one-off (b)
---

### one-off (a)
**Action:** investigated'

# `---` as a markdown horizontal rule in the body must not read as frontmatter.
assert_passes "body-horizontal-rules" '---
date: 2026-08-03
tags: [misc]
sessions:
  - slug: one-off (a)
    project: null
---

### one-off (a)
**Action:** investigated

---

Some prose after a rule.

---'

# ─── Corruption fixtures ─────────────────────────────────────────────────

# Corruption 1: a concurrent session appended its whole frontmatter block
# mid-file. A reader reads only the first and drops this session.
assert_blocks "second-frontmatter-block" '---
date: 2026-08-03
tags: [ai]
sessions:
  - slug: one-off (first)
    project: null
---

### one-off (first)
**Action:** fixed

Body prose.

---
date: 2026-08-03
tags: [finance]
sessions:
  - slug: finance/2026-08-03_second
    project: projects/finance/2026-08-03_second
    root_cause_status: n/a
---

### finance/2026-08-03_second
**Action:** shipped'

# Corruption 2: a foreign `- slug:` landed between a slug and its fields, so the
# fields re-parented onto the intruder, which then carried two `project:` keys.
assert_blocks "split-entry-duplicate-key" '---
date: 2026-08-03
tags: [ai]
sessions:
  - slug: one-off (mine)
  - slug: ai/2026-08-03_theirs
    project: ai/2026-08-03_theirs
    project: null
    implement_audit_rounds: 11
    root_cause_status: fixed
---

### one-off (mine)
**Action:** fixed'

# The same split seen from the orphaned end: fields with no slug above them.
assert_blocks "orphaned-fields-before-slug" '---
date: 2026-08-03
tags: [ai]
sessions:
    project: null
    root_cause_status: fixed
  - slug: one-off (first)
---

### one-off (first)
**Action:** fixed'

assert_blocks "duplicate-nested-block-key" '---
date: 2026-08-03
tags: [portals]
sessions:
  - slug: one-off (portal ship)
    runtime_identity:
      - target: "finance.example.com"
        branch: main
    runtime_identity:
      - target: "sales.example.com"
        branch: main
---

### one-off (portal ship)
**Action:** shipped'

# F4. Two `tags:` keys in ONE block: YAML keeps the second, so `billing` here is
# discarded with no error anywhere, and F1 does not see it — its counters are `date:` and `sessions:` only.
assert_blocks "duplicate-top-level-tags" '---
date: 2026-08-03
tags: [ai, billing]
tags: [ai, sales]
sessions:
  - slug: one-off (first)
---

### one-off (first)
**Action:** fixed'

# The same key at column 0 in the BODY is not a duplicate — the frontmatter
# closed at the second `---`, and F4 must not reach past it.
assert_passes "body-line-looks-like-a-key" '---
date: 2026-08-03
tags: [ai]
sessions:
  - slug: one-off (first)
---

### one-off (first)
**Action:** fixed

tags: this is prose, not frontmatter'

assert_blocks "no-frontmatter" '### one-off (no frontmatter)
**Action:** fixed

Body prose only.'

# ─── F5: a session file's slug is the session its body is about ─────────

assert_session() { # name, expected (pass|block), fixture
  local name="$1" expect="$2" fixture="$3"
  local path="$TMP/$name/0900-a-session.md"
  mkdir -p "$TMP/$name"
  printf '%s\n' "$fixture" > "$path"
  if bash "$CHECK" "$path" > /dev/null 2>&1; then
    if [[ "$expect" == pass ]]; then
      echo "ok: $name passed"; pass=$((pass + 1))
    else
      echo "FAIL: $name — expected BLOCK, got PASS" >&2; fail=$((fail + 1))
    fi
  else
    if [[ "$expect" == block ]]; then
      echo "ok: $name blocked"; pass=$((pass + 1))
    else
      echo "FAIL: $name — expected PASS, got BLOCK" >&2; fail=$((fail + 1))
    fi
  fi
}

assert_session "f5-slug-matches-heading" pass "---
date: 2026-09-13
time: 09:00
slug: one-off (a session)
project: null
---

### one-off (a session)

**Action:** land the thing"

assert_session "f5-slug-disagrees-with-heading" block "---
date: 2026-09-13
time: 09:00
slug: one-off (a session)
---

### one-off (a different session)

**Action:** land the thing"

assert_session "f5-no-slug-key" block "---
date: 2026-09-13
time: 09:00
---

### one-off (a session)"

assert_session "f5-recorded-slug-does-not-count" block "---
date: 2026-09-13
time: 09:00
recorded_slug: one-off (the old name)
---

### one-off (a session)"

assert_session "f5-quoted-slug-matches-heading" pass "---
date: 2026-09-13
time: 09:00
slug: \"one-off (scorecard: HR Technician Satisfaction)\"
---

### one-off (scorecard: HR Technician Satisfaction)"

assert_session "f5-quoted-slug-disagrees" block "---
date: 2026-09-13
time: 09:00
slug: \"one-off (scorecard: something else)\"
---

### one-off (scorecard: HR Technician Satisfaction)"


# ─── F6 / F7 / F8: the body follows journal-entry.md ────────────────────
#
# Session-named files, so every session check runs. `assert_body` also reads
# the check's stderr for the check id and the words the message must carry —
# a refusal that names the wrong rule sends the writer to the wrong fix.

FM='---
date: 2026-09-23
time: "12:00"
slug: one-off (a session)
project: null
---

### one-off (a session)
**Action:** shipped

One line.
'

assert_body() { # name, expected (pass|block), body, [needle...]
  local name="$1" expect="$2" body="$3"; shift 3
  local path="$TMP/$name/1200-a-session.md" out
  mkdir -p "$TMP/$name"
  printf '%s\n%s\n' "$FM" "$body" > "$path"
  if out=$(bash "$CHECK" "$path" 2>&1); then
    if [[ "$expect" == pass ]]; then
      echo "ok: $name passed"; pass=$((pass + 1))
    else
      echo "FAIL: $name — expected BLOCK, got PASS" >&2; fail=$((fail + 1))
    fi
  else
    if [[ "$expect" == block ]]; then
      local needle missing=0
      for needle in "$@"; do
        if [[ "$out" != *"$needle"* ]]; then
          echo "FAIL: $name — blocked, but the message lacks '$needle':" >&2
          printf '%s\n' "$out" >&2
          missing=1
        fi
      done
      if [[ $missing -eq 0 ]]; then echo "ok: $name blocked"; pass=$((pass + 1)); else fail=$((fail + 1)); fi
    else
      echo "FAIL: $name — expected PASS, got BLOCK:" >&2
      printf '%s\n' "$out" >&2
      fail=$((fail + 1))
    fi
  fi
}

# F7 — a Decisions bullet is a link or a rejected: line, one line each.

assert_body "f7-prose-bullet" block '**Decisions:**
- Chose X because Y.' "F7" "1200-a-session.md:14" "neither a link nor a \`rejected:\` line"

assert_body "f7-link-only" pass '**Decisions:**
- [0002-project-file-templates](../../projects/web/2026-01-10_checkout-flow/decisions/0002-project-file-templates.md)'

assert_body "f7-link-only-trailing-space" pass '**Decisions:**
- [spec 009 § Clarifications](../../projects/ai/x/specs/009-journal-schema/spec.md)   '

assert_body "f7-link-with-reasoning" block '**Decisions:**
- [x](decisions/0001-x.md) because y' "F7" ":14"

assert_body "f7-rejected" pass '**Decisions:**
- rejected: firing a live run now — the kernel update reboots the host'

assert_body "f7-rejected-500-chars" pass "**Decisions:**
- rejected: $(printf 'x%.0s' $(seq 1 490))"
# "rejected: " is 10 characters; 490 x's make exactly 500 after the "- ".
assert_body "f7-rejected-501-chars" block "**Decisions:**
- rejected: $(printf 'x%.0s' $(seq 1 491))" "F7" "500"

assert_body "f7-wrapped-bullet" block '**Decisions:**
- rejected: a long option — with a reason that
  wraps onto a second line' "F7" ":15" "one line"

assert_body "f7-two-good-one-bad" block '**Decisions:**
- [a](decisions/0001-a.md)
- Chose X because Y.
- rejected: b — c' "F7" ":15"

assert_body "f7-empty-decisions" pass '**Decisions:**

**Lessons:**
- nothing under Decisions is fine'

assert_body "f7-no-decisions" pass '**Changes:**
- a change, with the small choice that explains it'

assert_body "f7-only-first-section-is-checked" pass '**Decisions:**
- rejected: a — b

**Lessons:**
- Chose X because Y is a fine Lessons bullet'

# Fenced code is quoted text, not the entry's own sections.
assert_body "f7-f6-inside-fence" pass '**Changes:**
- quoted an old entry:

```markdown
**Next:**
- follow up

**Decisions:**
- Chose X because Y.
```

- and a tilde fence too:

~~~
**Issues:**
~~~'

assert_body "f7-unclosed-fence-runs-to-eof" pass '**Changes:**
- an unclosed fence

```
**Next:**
**Decisions:**
- Chose X because Y.'

# F6 — the section set is closed.

assert_body "f6-next" block '**Next:**
- follow up later' "F6" ":13" "Next" "ROADMAP.md" "Blocked"

assert_body "f6-issues" block '**Issues:**
- the thing was broken' "F6" "Issues" "Findings"

assert_body "f6-one-off-label" block '**Verification:**
- ran it' "F6" "Verification"

# shellcheck disable=SC2016  # literal markdown — the backticks and `$` belong to the fixture or the pattern, not the shell
assert_body "f6-all-eight" pass '**Changes:**
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
- g

**Root-Cause Status:** fixed — h'

assert_body "f6-bold-lead-in-bullet" pass '**Changes:**
- **T20260910.0032 was a dead run.** Restarted.
- **Bold lead.** text'

# The same labels in a day file are the day's business, not a session's.
assert_passes "f6-f8-day-file-skipped" '---
date: 2026-09-23
tags: [ai]
root_cause_status: partial
sessions:
  - slug: one-off (first)
---

**Next:**
- whatever the day file says

**Decisions:**
- Chose X because Y.'

# F8 — root_cause_status is one of four.

for v in fixed unknown-pending-verification deferred-by-user-directive n/a; do
  assert_session "f8-$v" pass "---
date: 2026-09-23
time: \"12:00\"
slug: one-off (a session)
root_cause_status: $v
---

### one-off (a session)
**Action:** fixed

One line."
done

assert_session "f8-quoted-value" pass '---
date: 2026-09-23
time: "12:00"
slug: one-off (a session)
root_cause_status: "n/a"
---

### one-off (a session)
**Action:** fixed

One line.'

f8_block() { # name, value, [needle...]
  local name="$1" value="$2"; shift 2
  local path="$TMP/$name/1200-a-session.md" out
  mkdir -p "$TMP/$name"
  printf -- '---\ndate: 2026-09-23\ntime: "12:00"\nslug: one-off (a session)\nroot_cause_status: %s\n---\n\n### one-off (a session)\n**Action:** fixed\n\nOne line.\n' "$value" > "$path"
  if out=$(bash "$CHECK" "$path" 2>&1); then
    echo "FAIL: $name — expected BLOCK, got PASS" >&2; fail=$((fail + 1)); return
  fi
  local needle
  for needle in "F8" "$value" "$@"; do
    if [[ "$out" != *"$needle"* ]]; then
      echo "FAIL: $name — blocked, but the message lacks '$needle':" >&2
      printf '%s\n' "$out" >&2
      fail=$((fail + 1)); return
    fi
  done
  echo "ok: $name blocked"; pass=$((pass + 1))
}

f8_block "f8-addressed" "addressed" "unknown-pending-verification"
f8_block "f8-retired-deferred-with-project" "deferred-with-project"
f8_block "f8-value-with-a-tail" "fixed — projects/x/report.md"
f8_block "f8-partial" "partial"

assert_body "f8-absent-key-passes" pass '**Changes:**
- no root_cause_status key at all'

# ─── The lists the check compares against are journal-entry.md's ────────
#
# The check carries copies of the section set and the root_cause_status
# values because a shell script cannot read a markdown table at every close.
# This row is what keeps the copies honest: the schema file is the definition,
# and a change to either list without the other fails here.

SCHEMA="$SCRIPT_DIR/../references/journal-entry.md"
# shellcheck disable=SC2016  # literal markdown — the backticks and `$` belong to the fixture or the pattern, not the shell
schema_labels=$(sed -n '/^### Section set/,/^\*\*Retired/p' "$SCHEMA" \
  | sed -nE 's/^\| `\*\*([A-Za-z -]+):\*\*` \|.*$/\1/p' | paste -sd'|')
script_labels=$(sed -nE 's/^SECTION_LABELS="(.*)"$/\1/p' "$CHECK")
if [[ -n "$schema_labels" && "$schema_labels" == "$script_labels" ]]; then
  echo "ok: section set matches journal-entry.md ($schema_labels)"; pass=$((pass + 1))
else
  echo "FAIL: section set — journal-entry.md says '$schema_labels', the check says '$script_labels'" >&2
  fail=$((fail + 1))
fi

# shellcheck disable=SC2016  # literal markdown — the backticks and `$` belong to the fixture or the pattern, not the shell
schema_values=$(grep -A1 -F -- '- **`root_cause_status:`** — optional; when present, one of' "$SCHEMA" \
  | tail -n 1 | grep -o '`[^`]*`' | tr -d '`' | paste -sd'|')
script_values=$(sed -nE 's/^ROOT_CAUSE_VALUES="(.*)"$/\1/p' "$CHECK")
if [[ -n "$schema_values" && "$schema_values" == "$script_values" ]]; then
  echo "ok: root_cause_status values match journal-entry.md ($schema_values)"; pass=$((pass + 1))
else
  echo "FAIL: root_cause_status values — journal-entry.md says '$schema_values', the check says '$script_values'" >&2
  fail=$((fail + 1))
fi

# ─── Default (staged) path ───────────────────────────────────────────────

setup_repo() {
  local dir="$1"
  mkdir -p "$dir/journal"
  git -C "$dir" init -q
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name Test
}

test_default_path_blocks_staged_bad_journal() {
  local dir="$TMP/repo-bad"
  setup_repo "$dir"
  mkdir -p "$dir/journal/2026-08-03"
  cp "$TMP/second-frontmatter-block/0000-day.md" "$dir/journal/2026-08-03/0000-day.md"
  git -C "$dir" add journal/2026-08-03/0000-day.md
  if (cd "$dir" && bash "$CHECK" > /dev/null 2>&1); then
    echo "FAIL: default-path — expected BLOCK on staged corrupt journal" >&2
    fail=$((fail + 1))
  else
    echo "ok: default-path blocked staged corrupt journal"
    pass=$((pass + 1))
  fi
}

test_default_path_passes_clean_staged_journal() {
  local dir="$TMP/repo-clean"
  setup_repo "$dir"
  mkdir -p "$dir/journal/2026-08-03"
  cp "$TMP/nested-runtime-identity/0000-day.md" "$dir/journal/2026-08-03/0000-day.md"
  git -C "$dir" add journal/2026-08-03/0000-day.md
  if (cd "$dir" && bash "$CHECK" > /dev/null 2>&1); then
    echo "ok: default-path passed clean staged journal"
    pass=$((pass + 1))
  else
    echo "FAIL: default-path — expected PASS on clean staged journal" >&2
    fail=$((fail + 1))
  fi
}

# A leftover `journal/<date>.md` is not this check's business either: the split
# removed every one of them, and a new one is a reader's failure to catch, not
# a frontmatter shape.
test_default_path_skips_legacy_day_file() {
  local dir="$TMP/repo-legacy"
  setup_repo "$dir"
  cp "$TMP/second-frontmatter-block/0000-day.md" "$dir/journal/2026-08-03.md"
  git -C "$dir" add journal/2026-08-03.md
  if (cd "$dir" && bash "$CHECK" > /dev/null 2>&1); then
    echo "ok: default-path ignored a legacy day file"
    pass=$((pass + 1))
  else
    echo "FAIL: default-path scanned a legacy day file" >&2
    fail=$((fail + 1))
  fi
}

test_default_path_skips_non_journal_staged() {
  local dir="$TMP/repo-other"
  setup_repo "$dir"
  cp "$TMP/second-frontmatter-block/0000-day.md" "$dir/notes.md"
  git -C "$dir" add notes.md
  if (cd "$dir" && bash "$CHECK" > /dev/null 2>&1); then
    echo "ok: default-path correctly ignored non-journal file"
    pass=$((pass + 1))
  else
    echo "FAIL: default-path scanned a non-journal file" >&2
    fail=$((fail + 1))
  fi
}

# A git that cannot read the index is not "nothing staged". Read through a
# process substitution the failure listed nothing and the check exited 0, so a
# close's journal gate passed over an entry it never read.
test_default_path_fails_when_git_cannot_read() {
  local dir="$TMP/repo-failgit" bin="$TMP/failgit-bin" rc=0
  setup_repo "$dir"
  mkdir -p "$dir/journal/2026-08-03" "$bin"
  cp "$TMP/second-frontmatter-block/0000-day.md" "$dir/journal/2026-08-03/0000-day.md"
  git -C "$dir" add journal/2026-08-03/0000-day.md
  printf '#!/usr/bin/env bash\ncase " $* " in *" --cached "*) exit 128 ;; esac\nexec "%s" "$@"\n' "$(command -v git)" >"$bin/git"
  chmod +x "$bin/git"
  (cd "$dir" && PATH="$bin:$PATH" bash "$CHECK" >/dev/null 2>&1) || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "ok: default-path fails when git cannot read the index"
    pass=$((pass + 1))
  else
    echo "FAIL: default-path passed with an unreadable index" >&2
    fail=$((fail + 1))
  fi
}

test_default_path_blocks_staged_bad_journal
test_default_path_fails_when_git_cannot_read
test_default_path_passes_clean_staged_journal
test_default_path_skips_non_journal_staged
test_default_path_skips_legacy_day_file

# ─── Real-repo regression: the 30 most recent session entries must be clean ─
#
# The records are in the same repo as these scripts, so this case runs on every
# test run from a workbench that has a journal (and is skipped where there is
# none, as in the template repo). Session files are `HHMM-<slug>.md` under a day
# folder; a `0000-` file is the day's own record and outside the section checks.

REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$REPO_ROOT" && -d "$REPO_ROOT/journal" ]]; then
  real_journals=()
  while IFS= read -r _j; do real_journals+=("$_j"); done \
    < <(find "$REPO_ROOT/journal" -mindepth 2 -name '*.md' -not -name '0000-*' | sort | tail -30)
  if [[ ${#real_journals[@]} -gt 0 ]]; then
    if bash "$CHECK" "${real_journals[@]}" > /dev/null 2>&1; then
      echo "ok: last ${#real_journals[@]} real journals pass"
      pass=$((pass + 1))
    else
      echo "FAIL: real journals tripped the check:" >&2
      bash "$CHECK" "${real_journals[@]}" >&2 || true
      fail=$((fail + 1))
    fi
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────

echo ""
echo "── Results ────────────────────────────────────"
echo "passed: $pass"
echo "failed: $fail"
[[ $fail -eq 0 ]] || exit 1
exit 0
