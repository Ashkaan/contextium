#!/usr/bin/env bash
# check-journal-entry.sh — refuse a journal session entry that does not follow
# .agents/skills/close/references/journal-entry.md.
#
# Usage:
#   check-journal-entry.sh [session-files...]
#   # no args: every staged journal/YYYY-MM-DD/*.md, read from the index
#
# Exit: 0 clean · 1 any violation (listed on stderr).
#
# CHECKS
#   J1 — one front matter block, opening on line 1, with exactly one column-0
#        `date:` in the file. A second block mid-file is invisible to anything
#        that parses front matter, which reads only the first.
#   J2 — no key twice at column 0 inside the front matter. YAML keeps the last,
#        so the earlier line's value is discarded without an error.
#   J3 — `title:` is present and equals the first body heading, so a grep for
#        either finds the same session.
#   J4 — every column-0 `**Label:**` in the body is one of the section set.
#        `**Next:**` and `**Issues:**` are retired and named as such.
#   J5 — a `**Decisions:**` bullet is a link and nothing else, or one
#        `rejected:` line of at most 500 characters.
#   J4 and J5 skip lines inside a ``` or ~~~ fence: an entry quoting an old
#   entry is not writing a section.
#
# The section list below is a copy of journal-entry.md § Section set, because a
# shell script cannot read a markdown table at every close;
# check-journal-entry.test.sh fails when the two drift, so the reference file
# stays the definition.
#
# In staged mode the INDEX copy is checked, because that is what commits: a
# repaired working copy over a broken staged one would otherwise pass.
#
# peers:
#   .agents/skills/close/scripts/check-journal-entry.test.sh
#   .agents/skills/close/scripts/journal-file.sh
#   .agents/skills/close/references/journal-entry.md

set -euo pipefail

# Copy of journal-entry.md § Section set; the test fails when it drifts.
SECTION_LABELS="Action|Changes|Findings|Decisions|Corrections|Lessons|Blocked"

# ─── Collect files to scan ──────────────────────────────────────────────
STAGED_MODE=0
files=()
if [[ $# -gt 0 ]]; then
  files=("$@")
else
  STAGED_MODE=1
  while IFS= read -r f; do
    [[ -n "$f" ]] && files+=("$f")
  done < <(git diff --cached --name-only --diff-filter=ACM 2>/dev/null \
    | grep -E '^journal/[0-9]{4}-[0-9]{2}-[0-9]{2}/[^/]+\.md$' || true)
fi

[[ ${#files[@]} -eq 0 ]] && exit 0

# Created here, in the parent shell: scan_target runs in a command substitution,
# and a temp dir made in there would be gone before the caller read it.
SCRATCH=""
if [[ "$STAGED_MODE" == 1 ]]; then
  SCRATCH="$(mktemp -d)"
  trap 'rm -rf "$SCRATCH"' EXIT
fi

scan_target() {
  local f="$1" dest
  if [[ "$STAGED_MODE" != 1 ]]; then printf '%s\n' "$f"; return; fi
  dest="$SCRATCH/$(printf '%s' "$f" | tr '/' '_')"
  if git show ":$f" >"$dest" 2>/dev/null; then printf '%s\n' "$dest"
  else printf '%s\n' "$f"; fi
}

issues=()
add_lines() { # add_lines <text> — one issue per line
  local line
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then issues+=("$line"); fi
  done <<<"$1"
  return 0
}

for journal_path in "${files[@]}"; do
  journal="$(scan_target "$journal_path")"
  if [[ ! -f "$journal" ]]; then
    issues+=("$journal_path: not a file")
    continue
  fi

  # ─── J1 ──────────────────────────────────────────────────────────────
  # `date:` is counted inside the opening block only. In the body, a second
  # block is a `---` line followed only by YAML-looking lines up to another
  # `---`, holding a `date:` — so a horizontal rule, or prose that starts with
  # "date:", is never read as one. Fenced code is skipped.
  if [[ "$(head -n 1 "$journal")" != "---" ]]; then
    issues+=("$journal_path:1: J1 — no front matter: the file must open with a '---' line")
  else
    j1_out="$(LC_ALL=C awk -v file="$journal_path" '
      NR == 1 { infm = 1; next }
      infm { if ($0 == "---") { infm = 0; body = 1 } else if ($0 ~ /^date:[ \t]/) fm_date = 1; next }
      /^(```|~~~)/ { fence = !fence; cand = 0; next }
      fence { next }
      cand && $0 == "---" {
        if (cand_date) printf("%s:%d: J1 — a second front matter block; only the first is ever read — fold it into the first and delete this one\n", file, cand)
        cand = 0; next
      }
      cand && ($0 ~ /^[A-Za-z_][A-Za-z0-9_-]*:/ || $0 ~ /^[ \t]/ || $0 ~ /^- /) { if ($0 ~ /^date:[ \t]/) cand_date = 1; next }
      cand { cand = 0 }
      $0 == "---" { cand = NR; cand_date = 0 }
      END { if (!infm && !fm_date) printf("%s: J1 — no `date:` key in the front matter\n", file) }
    ' "$journal")"
    add_lines "$j1_out"
  fi

  # ─── J2 + J3: inside the front matter ────────────────────────────────
  fm_out="$(LC_ALL=C awk -v file="$journal_path" '
    NR == 1 { if ($0 != "---") exit; infm = 1; next }
    infm && $0 == "---" { closed = 1; exit }
    infm && /^[A-Za-z_][A-Za-z0-9_-]*:/ {
      key = $0; sub(/:.*$/, "", key)
      if (key in seen) printf("%s:%d: J2 — `%s:` appears twice at column 0 (first at line %d); YAML keeps the last and discards the first — merge them into one line\n", file, NR, key, seen[key])
      else seen[key] = NR
    }
    END { if (NR > 1 && infm && !closed) printf("%s: J1 — the front matter never closes with a second `---` line\n", file) }
  ' "$journal")"
  add_lines "$fm_out"

  fm_title="$(LC_ALL=C awk 'NR==1 && $0=="---" {infm=1; next} infm && $0=="---" {exit} infm && /^title:[ \t]/ {
      sub(/^title:[ \t]*/, "")
      if ($0 ~ /^".*"$/) { sub(/^"/, ""); sub(/"$/, ""); gsub(/\\"/, "\"") }
      else if ($0 ~ /^'"'"'.*'"'"'$/) { sub(/^'"'"'/, ""); sub(/'"'"'$/, "") }
      print; exit
    }' "$journal")"
  first_heading="$(LC_ALL=C awk 'NR==1 && $0=="---" {infm=1; next} infm && $0=="---" {infm=0; body=1; next} body && /^#+ / {sub(/^#+[ \t]*/, ""); print; exit}' "$journal")"
  if [[ -z "$fm_title" ]]; then
    issues+=("$journal_path: J3 — no 'title:' key in the front matter; it must equal the first heading")
  elif [[ "$fm_title" != "$first_heading" ]]; then
    issues+=("$journal_path: J3 — front matter title '$fm_title' does not match the first heading '${first_heading:-(none)}'; make them identical")
  fi

  # ─── J4 + J5: the body ───────────────────────────────────────────────
  # LC_ALL=C and a continuation-byte count, so the 500-character ceiling counts
  # characters under any awk: an em dash is three bytes and one character.
  body_out="$(LC_ALL=C awk -v labels="$SECTION_LABELS" -v file="$journal_path" '
    function report(id, msg) { printf("%s:%d: %s — %s\n", file, FNR, id, msg) }
    function chars(s,    t, k) { t = s; k = gsub(/[\200-\277]/, "", t); return length(s) - k }
    BEGIN { n = split(labels, arr, "|"); for (i = 1; i <= n; i++) allowed[arr[i]] = 1 }
    FNR == 1 { infm = ($0 == "---"); if (infm) next }
    infm { if ($0 == "---") infm = 0; next }
    /^(```|~~~)/ { fence = !fence; next }
    fence { next }
    /^#+ / { section = ""; next }
    /^\*\*[A-Za-z][A-Za-z -]*:\*\*/ {
      label = $0; sub(/^\*\*/, "", label); sub(/:\*\*.*$/, "", label)
      if (!(label in allowed)) {
        if (label == "Next")
          where = "retired: outstanding project work belongs in the project ROADMAP.md, work waiting on someone under **Blocked:**"
        else if (label == "Issues")
          where = "retired: what an investigation found belongs under **Findings:**, each bullet naming its reading"
        else
          where = "fold it into **Changes:**, **Findings:** or **Lessons:**"
        report("J4", "`**" label ":**` is not one of the sections (" labels ") — " where)
      }
      section = label; next
    }
    section != "Decisions" { next }
    /^[ \t]*$/ { next }
    /^[ \t]/ { report("J5", "a Decisions bullet wraps onto an indented line — each bullet is one line, so a grep for `^- rejected:` finds all of it"); next }
    /^- \[[^]]+\]\([^)]+\)[ \t]*$/ { next }
    /^- rejected: / {
      c = chars($0) - 2
      if (c > 500) report("J5", "this `rejected:` line is " c " characters after the `- ` — the ceiling is 500")
      next
    }
    { report("J5", "a Decisions bullet is neither a link nor a `rejected:` line — link the file that holds the choice (a decisions/ record, spec.md § Clarifications, report.md § Deviations) with nothing after the link, or write `- rejected: <what> — <why>` on one line; a one-off choice goes under **Changes:**") }
  ' "$journal")"
  add_lines "$body_out"
done

if [[ ${#issues[@]} -gt 0 ]]; then
  {
    echo ""
    echo "JOURNAL ENTRY CHECK FAILED — the entry does not follow .agents/skills/close/references/journal-entry.md:"
    printf '  %s\n' "${issues[@]}"
    echo ""
  } >&2
  exit 1
fi
exit 0
