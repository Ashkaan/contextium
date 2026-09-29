#!/usr/bin/env bash
# check-journal-entry.sh — refuse a journal session entry that does not follow
# close/references/journal-entry.md: front matter a reader cannot parse
# (F1–F5), and a body outside the schema (F6–F8).
#
# Usage:
#   check-journal-entry.sh [session-files...]
#   # no args: scan all staged journal/YYYY-MM-DD/*.md files via git diff --cached
#
# Exit: 0 if clean, 1 on any violation.
#
# It is only ever handed THIS thread's own entry — by `journal-file.sh --check`
# during /close § 3 and by `land.sh` before the commit — so entries written
# before a schema change are never re-read; a schema change applies to new
# entries only.
#
# WHY THIS EXISTS
#
# A day kept as ONE SHARED FILE, `journal/<date>.md`, with every session that
# closed that day appending its own `- slug:` entry to one `sessions:` list, is
# written by concurrent sessions from different worktrees, and git resolves
# their adjacent insertions WITHOUT a conflict. The result parses as valid
# markdown and valid-looking YAML, so nothing downstream complains — a reader
# just reads less than was written:
#
#   A front-matter parser reads only the FIRST `---` block. A second `---` /
#   `date:` / `tags:` / `sessions:` / `---` fragment appended further down the
#   file is dropped whole, taking that session with it.
#
#   A sessions-list parser opens a new session on every `- slug:` and attaches
#   each following indented `key: value` to whichever slug it saw last. A
#   `- slug:` inserted between another session's slug and its fields silently
#   re-parents those fields; the duplicate key that results just overwrites.
#
# Neither failure raises anything at the time. It surfaces later as a report
# built from the journal that under-counts, which is indistinguishable from a
# quiet week.
#
# A day is a FOLDER and a session is its own file, so the concurrency that
# caused both modes cannot recur — two sessions closing in the same minute take
# different filenames, and neither one opens the other's file. The checks stay
# for what survives: a `0000-day.md` may still carry a `sessions:` list, a hand
# edit can still duplicate a column-0 key, and F5 below keys a file to its own
# `slug:`, so a file whose first heading disagrees with its front matter would
# file its record under a session that does not exist.
#
# CHECKS
#   F1 — exactly one frontmatter block: one `date:` and at most one `sessions:`
#        at column 0 in the whole file. A second of either means a concurrent
#        session's block landed mid-file and no reader will ever see it.
#   F2 — no duplicate field key inside a single `- slug:` entry. This is the
#        fingerprint of a foreign `- slug:` splitting an entry in two.
#   F3 — no session field before the first `- slug:` in the `sessions:` block,
#        which is the same split seen from the orphaned end.
#   F5 — a session file's `slug:` matches its first body heading. Skipped for
#        every `0000-*.md`, which belongs to the DAY rather than to a session:
#        `0000-day.md` (the day's own prose) and any daily record a loop keeps.
#        None is a session, so none carries a slug a reader should count.
#   F4 — no duplicate key at column 0 inside the frontmatter block. YAML is
#        last-wins, so a second `tags:` discards the first line's tags outright:
#        nothing errors, the day just indexes under a subset of its own topics.
#        F1 sees this only when the duplicate is `date:` or `sessions:`, and
#        then reports it as a second frontmatter block — the wrong diagnosis
#        when both keys sit in ONE block.
#   F6 — every column-0 `**Label:**` in the body is one of the eight sections.
#        `**Next:**` and `**Issues:**` are retired: outstanding work is the
#        project's ROADMAP.md, and an investigation's results are Findings.
#   F7 — a `**Decisions:**` bullet is a link and nothing else, or one
#        `rejected:` line of at most 500 characters. Decision prose in a journal
#        restates reasoning that lives in a spec, a report or a decisions/
#        record; the entry links those. The `rejected:` line keeps its
#        reasoning because it IS the record of what was turned down, read by a
#        grep for that prefix.
#   F8 — `root_cause_status:` is one of its four values. A value outside them
#        splits one meaning across several buckets for anything counting them.
#   F6–F8 skip `0000-*.md`, as F5 does, and skip lines inside a ``` or ~~~
#   fence — an entry quoting an old entry is not writing a section.
#
# Schema SSOT is close/references/journal-entry.md. The two lists below are
# copies of its § Section set and § Field reference, because a shell script
# cannot read a markdown table at every close; check-journal-entry.test.sh
# asserts the copies match the file, so the file stays the definition. For the
# front matter this check validates STRUCTURE only — that each entry's fields
# belong to the slug above them — never the field names, so it does not have
# to move when the schema gains a field.
#
# Runs from close/scripts/land.sh before each commit of the records worktree
# and from journal-file.sh --check during /close § 3.

set -euo pipefail

# Mechanism-firing telemetry, when the workbench keeps a logger for it: a
# sibling `log-mechanism-fired.sh`, or `.agents/checks/log-mechanism-fired.sh`
# of the repo this script sits in (CONTEXT_CODE_REPO overrides, for a test). A
# missing logger degrades to a no-op rather than failing the check — telemetry
# is not what any of these exist to enforce.
_LOG_MECH="$(dirname "$0")/log-mechanism-fired.sh"
[[ -f "$_LOG_MECH" ]] || _LOG_MECH="${CONTEXT_CODE_REPO:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)}/.agents/checks/log-mechanism-fired.sh"
if [[ -f "$_LOG_MECH" ]]; then
  # shellcheck disable=SC1090
  source "$_LOG_MECH"
else
  log_mechanism() { :; }
fi
log_mechanism "check-journal-entry" "${TRIGGERED_BY:-close}" "$#"

# Copies of close/references/journal-entry.md § Section set and § Field
# reference; the test fails when either drifts from the file.
SECTION_LABELS="Action|Changes|Findings|Decisions|Corrections|Lessons|Blocked|Root-Cause Status"
ROOT_CAUSE_VALUES="fixed|unknown-pending-verification|deferred-by-user-directive|n/a"

# ─── Collect files to scan ──────────────────────────────────────────────
STAGED_MODE=0
if [[ $# -gt 0 ]]; then
  files=("$@")
else
  STAGED_MODE=1
  # A read loop, not `mapfile`, which bash 3.2 (macOS) does not have.
  # Read and checked before it is filtered: through a process substitution a
  # failed read listed nothing, and "nothing staged" exits 0 — a gate passed.
  if ! staged="$(git diff --cached --name-only --diff-filter=ACM 2>&1)"; then
    echo "check-journal-entry: could not read the staged files: ${staged##*$'\n'}" >&2
    exit 1
  fi
  files=()
  while IFS= read -r _f; do
    [[ -n "$_f" ]] && files+=("$_f")
  done < <(printf '%s\n' "$staged" | grep -E '^journal/[0-9]{4}-[0-9]{2}-[0-9]{2}/[^/]+\.md$' || true)
fi

[[ ${#files[@]} -eq 0 ]] && exit 0

# THE INDEX COPY IS WHAT COMMITS, and this scanned the working-tree copy — so
# staging a journal with a duplicated frontmatter block and then repairing only
# the file on disk committed the corruption while the check reported clean. In
# staged mode each file is materialised from the index and scanned there.
# SCRATCH is created HERE, in the parent shell, not lazily inside scan_target.
# scan_target runs in a command substitution — its own subshell — so a mktemp and
# an EXIT trap set in there fire the moment the substitution closes, deleting the
# materialised copy before the caller ever opens it. Every staged file then read
# as "not a file" and the check passed by skipping everything.
SCRATCH=""
if [[ "$STAGED_MODE" == 1 ]]; then
  SCRATCH=$(mktemp -d)
  trap 'rm -rf "$SCRATCH"' EXIT
fi

scan_target() {
  local f="$1"
  if [[ "$STAGED_MODE" != 1 ]]; then
    printf '%s\n' "$f"
    return
  fi
  local dest
  dest="$SCRATCH/$(echo "$f" | tr '/' '_')"
  if git show ":$f" > "$dest" 2>/dev/null; then
    printf '%s\n' "$dest"
  else
    # Not in the index after all (raced, or invoked outside a repo) — fall back
    # to the working copy rather than skipping the file silently.
    printf '%s\n' "$f"
  fi
}

issues=()

for journal_path in "${files[@]}"; do
  journal="$(scan_target "$journal_path")"
  [[ -f "$journal" ]] || continue

  # ─── F1: one frontmatter block per file ──────────────────────────────
  # Column-0 `date:` / `sessions:` only appear in frontmatter — journal bodies
  # are `###` headings and `**Label:**` bullets — so a count above one is a
  # stray block, not prose.
  date_count=$(grep -cE '^date:[[:space:]]' "$journal" || true)
  sessions_count=$(grep -cE '^sessions:[[:space:]]*$' "$journal" || true)

  if [[ "$date_count" -gt 1 || "$sessions_count" -gt 1 ]]; then
    issues+=("$journal_path: $date_count 'date:' and $sessions_count 'sessions:' keys at column 0 — expected at most 1 of each.")
    issues+=("  A concurrent session appended a SECOND frontmatter block mid-file. A reader")
    issues+=("  reads only the first, so every session in the later block is invisible to telemetry.")
    issues+=("  offending lines:")
    while IFS= read -r line; do issues+=("    $line"); done < <(grep -nE '^(date:[[:space:]]|sessions:[[:space:]]*$)' "$journal" | head -20)
  fi

  if [[ "$date_count" -eq 0 ]]; then
    issues+=("$journal_path: no 'date:' key at column 0 — frontmatter block missing or malformed.")
  fi

  # ─── F5: the file's slug is the session its body is about ────────────
  if [[ "$(basename "$journal_path")" != 0000-* ]]; then
    # The value may be QUOTED — a session name containing `: ` has to be, or the
    # front matter is not valid YAML — so compare what the quotes contain.
    fm_slug=$(awk 'NR==1 && $0=="---" {infm=1; next} infm && $0=="---" {exit} infm && /^slug:[[:space:]]/ {
      sub(/^slug:[[:space:]]*/, "")
      if ($0 ~ /^".*"$/) { sub(/^"/, ""); sub(/"$/, ""); gsub(/\\"/, "\"") }
      print; exit
    }' "$journal")
    # ANY heading level: an older session written under `## ` inside another
    # session's block keeps that heading when it gets a file of its own.
    first_heading=$(awk 'NR==1 && $0=="---" {infm=1; next} infm && $0=="---" {infm=0; body=1; next} body && /^#+ / {sub(/^#+[[:space:]]*/, ""); print; exit}' "$journal")
    if [[ -z "$fm_slug" ]]; then
      issues+=("$journal_path: no 'slug:' key — a reader of the journal keys this session to it.")
    elif [[ "$fm_slug" != "$first_heading" ]]; then
      issues+=("$journal_path: front matter says slug '$fm_slug' but the first body heading is '### $first_heading'.")
      issues+=("  A reader files this file under the front matter's slug, so its record")
      issues+=("  would land on a session whose write-up is somewhere else.")
    fi

    # ─── F8: root_cause_status is one of four ────────────────────────────
    # Optional key; when present its value is compared unquoted. The line
    # number comes from the same pass so the message can point at it.
    fm_rcs=$(awk 'NR==1 && $0=="---" {infm=1; next} infm && $0=="---" {exit} infm && /^root_cause_status:[[:space:]]/ {
      sub(/^root_cause_status:[[:space:]]*/, "")
      if ($0 ~ /^".*"$/) { sub(/^"/, ""); sub(/"$/, "") }
      printf("%d\t%s\n", NR, $0); exit
    }' "$journal")
    if [[ -n "${fm_rcs#*$'\t'}" ]]; then
      rcs_line="${fm_rcs%%$'\t'*}"
      rcs_value="${fm_rcs#*$'\t'}"
      case "|$ROOT_CAUSE_VALUES|" in
        *"|$rcs_value|"*) ;;
        *) issues+=("$journal_path:$rcs_line: F8 — root_cause_status '$rcs_value' is not one of ${ROOT_CAUSE_VALUES//|/ | } — journal-entry.md § Field reference says which each case is; a detail goes on the **Root-Cause Status:** line, not in the key.") ;;
      esac
    fi

    # ─── F6 + F7: the body's sections and the Decisions bullets ──────────
    # One pass over the body (after the closing `---`). A fence opener flips
    # `fence` and an unclosed fence runs to the end of the file, so quoted
    # text is never read as a section. Characters are counted, not bytes: a
    # `rejected:` line usually carries an em-dash, and a byte count would refuse
    # a 499-character line. awk runs under LC_ALL=C and chars() subtracts UTF-8
    # continuation bytes, which counts the same under any awk on any platform
    # (C.UTF-8 does not exist on macOS).
    body_out=$(LC_ALL=C awk -v labels="$SECTION_LABELS" -v file="$journal_path" '
      function report(id, msg) { printf("%s:%d: %s — %s\n", file, FNR, id, msg) }
      function chars(s,    t, k) { t = s; k = gsub(/[\200-\277]/, "", t); return length(s) - k }
      BEGIN { n = split(labels, arr, "|"); for (i = 1; i <= n; i++) allowed[arr[i]] = 1 }
      FNR == 1 { infm = ($0 == "---"); fence = 0; section = ""; if (infm) next }
      infm { if ($0 == "---") infm = 0; next }
      /^(```|~~~)/ { fence = !fence; next }
      fence { next }
      /^#+ / { section = ""; next }
      /^\*\*[A-Za-z][A-Za-z -]*:\*\*/ {
        label = $0; sub(/^\*\*/, "", label); sub(/:\*\*.*$/, "", label)
        if (!(label in allowed)) {
          if (label == "Next")
            where = "retired: outstanding project work belongs in the project ROADMAP.md, work waiting on the user under **Blocked:**"
          else if (label == "Issues")
            where = "retired: what an investigation found belongs under **Findings:**, each bullet naming its reading"
          else
            where = "not a section in journal-entry.md § Section set; fold it into **Changes:**, **Findings:** or **Lessons:**"
          report("F6", "`**" label ":**` is not one of the eight sections (" labels ") — " where)
        }
        section = label; next
      }
      section != "Decisions" { next }
      /^[[:space:]]*$/ { next }
      /^[ \t]/ { report("F7", "a Decisions bullet wraps onto an indented line — each bullet is one line, because a grep for what was turned down reads a line that STARTS with `rejected:`"); next }
      /^- \[[^]]+\]\([^)]+\)[[:space:]]*$/ { next }
      /^- rejected: / {
        if (chars($0) - 2 > 500)
          report("F7", "this `rejected:` line is " (chars($0) - 2) " characters after the `- ` — the ceiling is 500")
        next
      }
      { report("F7", "a Decisions bullet is neither a link nor a `rejected:` line — link the file that holds the choice (a decisions/ record, spec.md § Clarifications, research.md, report.md § Deviations) with nothing after the link, or write `- rejected: <what was not done> — <why>` on one line; a one-off session small choice goes under **Changes:**") }
    ' "$journal")
    if [[ -n "$body_out" ]]; then
      while IFS= read -r line; do issues+=("$line"); done <<< "$body_out"
    fi
  fi

  # ─── F2 + F3: entry integrity inside the sessions: block ─────────────
  # State machine over the FIRST frontmatter block only. `field_indent` is
  # derived from each `- slug:` line (dash indent + 2), so nested
  # `runtime_identity:` entries sit deeper and are skipped rather than
  # mistaken for duplicate entry fields.
  awk_out=$(awk '
    function report(msg) { printf("%s:%d: %s\n", FILENAME, FNR, msg) }

    FNR == 1 {
      state = ($0 == "---") ? 1 : 2
      in_sessions = 0
      seen_slug = 0
      slug = ""
      split("", top_keys)
      next
    }

    # Frontmatter closes; nothing after it is our business.
    state == 1 && $0 == "---" { state = 2; in_sessions = 0; next }
    state != 1 { next }

    # F4. Deliberately falls through rather than `next`-ing: the sessions-block
    # rules below still have to see `sessions:` itself.
    /^[A-Za-z_][A-Za-z0-9_-]*:/ {
      top = $0
      sub(/:.*$/, "", top)
      if (top in top_keys) {
        report("duplicate `" top ":` at column 0 — YAML keeps the LAST one, so everything on the earlier line is discarded")
      }
      top_keys[top] = 1
    }

    /^sessions:[[:space:]]*$/ {
      in_sessions = 1
      seen_slug = 0
      split("", keys)
      next
    }

    # Any other column-0 key ends the sessions block.
    in_sessions && /^[A-Za-z_]/ { in_sessions = 0 }
    !in_sessions { next }

    # Entry start.
    /^[[:space:]]*-[[:space:]]+slug:/ {
      match($0, /^[[:space:]]*/)
      field_indent = RLENGTH + 2
      slug = $0
      sub(/^[[:space:]]*-[[:space:]]+slug:[[:space:]]*/, "", slug)
      seen_slug = 1
      split("", keys)
      next
    }

    /^[[:space:]]*$/ { next }

    {
      match($0, /^[[:space:]]*/)
      ind = RLENGTH

      if (!seen_slug) {
        report("session field appears before any `- slug:` — a concurrent session split an entry and orphaned these fields")
        next
      }

      # Deeper than an entry field => nested (runtime_identity list). Shallower
      # is not a session field either. Only exact-depth keys are entry fields.
      if (ind != field_indent) next
      if ($0 !~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_-]*:/) next

      key = $0
      sub(/^[[:space:]]*/, "", key)
      sub(/:.*$/, "", key)

      if (key in keys) {
        report("duplicate `" key ":` inside session `" slug "` — a foreign `- slug:` was inserted into this entry, re-parenting its fields")
      }
      keys[key] = 1
    }
  ' "$journal")

  if [[ -n "$awk_out" ]]; then
    issues+=("$journal_path: corrupt frontmatter structure.")
    while IFS= read -r line; do issues+=("    $line"); done <<< "$awk_out"
  fi
done

# ─── Report ─────────────────────────────────────────────────────────────
if [[ ${#issues[@]} -gt 0 ]]; then
  echo "" >&2
  echo "JOURNAL ENTRY GATE FAILED — the entry does not follow close/references/journal-entry.md:" >&2
  printf '  %s\n' "${issues[@]}" >&2
  echo "" >&2
  echo "Fix (do NOT delete the other session's content — it is someone else's close):" >&2
  echo "  0. Slug/heading disagreement: make the front matter's 'slug:' and the first" >&2
  echo "     '### ' heading identical — both contain the full session title, not the" >&2
  echo "     filename stem. Keep the allocated filename and ledger path unchanged." >&2
  echo "  1. Two frontmatter blocks: fold the later block's '- slug:' entries and its" >&2
  echo "     tags into the FIRST block, then delete the stray '---'/'date:'/'tags:'/" >&2
  echo "     'sessions:'/'---' fragment. Leave its body '###' section where it is." >&2
  echo "  2. Duplicate key / orphaned fields: find the '- slug:' that was inserted" >&2
  echo "     mid-entry and move it (with its own fields) below the entry it split," >&2
  echo "     so every field sits under the slug that actually produced it." >&2
  echo "  3. Duplicate key at column 0: MERGE the two lines' values into the first" >&2
  echo "     one and delete the second. Do not just delete a line — for 'tags:' that" >&2
  echo "     throws away whichever topics were unique to it." >&2
  echo "  4. F6 (a label outside the set): move the content where the message says and" >&2
  echo "     delete the label. F7 (a Decisions bullet): replace prose with a link to the" >&2
  echo "     file that holds the choice, or a one-line 'rejected: <what> — <why>'." >&2
  echo "     F8 (root_cause_status): pick one of the four values." >&2
  echo "  5. Schema: close/references/journal-entry.md" >&2
  echo "" >&2
  exit 1
fi

exit 0
