#!/usr/bin/env bash
# roadmap.sh — THE one reader and writer of a project's ROADMAP.md table.
# detect-stage.sh, project-remaining-work.sh, next-implement-command.sh and
# setup-worktree.sh all call this instead of parsing the table themselves, for
# the reason two shard-table parsers taught: they disagreed (`reported`
# counted as done in one and as open in the other), and a table read two ways
# routes a project two ways.
#
# WHICH ROW IS READY, AND WHAT `next:` SAYS, IS NOT DEFINED HERE. The rule is
# written once, in the README template's derivation comment:
#   .agents/skills/project/references/templates/README.md  (the <!-- --> block)
# This script implements it; if the two ever disagree, the template is right and
# this file is the bug.
#
# Reading the table. The first table under `# Roadmap` whose header row names
# both an `ID` and a `Status` column. Columns are found BY HEADER NAME, so a
# reordered table reads the same. Cells are split on unescaped `|` (GFM's rule,
# which applies inside code spans too) and trimmed; spaces inside a cell are
# kept, so `blocked: vendor reply` survives whole.
#
# Sub-spec is printed as the NAME spec-state.sh gives that spec, so a caller can
# join the two outputs on it directly:
#   `specs/004-x/`                               → specs/004-x
#   `` `x.spec.md` → `x-report.md` `` (legacy)   → x   (the first backticked *.spec.md)
#   `—`, `-` or empty                            → —
#
# Usage:
#   roadmap.sh <project-folder>                 one TSV line per row:
#                                               ID  Status  ready(yes|no)  Sub-spec  Sub-feature
#   roadmap.sh <project-folder> --next          the derived `next:` value, or nothing
#   roadmap.sh <project-folder> --ready         the ready rows only, same TSV, in
#                                               next-order (in-progress, then planned)
#   roadmap.sh <project-folder> --check <ID>    exit 0 and print the row's Sub-spec when
#                                               the row may be built now: ready, a
#                                               Sub-spec named, that spec on disk and
#                                               still owed work. Otherwise exit 1 with one
#                                               `roadmap: <ID> not ready: <reason>` line per
#                                               reason (each unmet dependency by name)
#   roadmap.sh <project-folder> --set <ID> <status> [--sub-spec <path>]
#                                               rewrite that row's Status (and Sub-spec)
#                                               cells; every other byte is left alone
#   roadmap.sh <project-folder> --sync-next     rewrite README.md's `next:` line from --next
#
# --set and --sync-next take a per-project lock (lock.sh: bash-3.2 safe, a
# dead holder's lock taken over), re-read the files
# under it, and replace them through a temp file + mv, so two sessions writing
# one checkout never lose each other's row. ROADMAP_LOCK_WAIT (seconds,
# default 30) bounds the wait.
#
# Warnings (exit 0) and errors (exit 1) go to stderr as `roadmap: <message>`.
# Exit: 0 ok · 1 no ROADMAP.md, malformed table, placeholder row, missing row,
# row not ready (--check), lock timeout, no README (--sync-next) · 2 usage.
#
# Portable: bash 3.2, any POSIX awk, BSD or GNU userland. awk runs under
# LC_ALL=C and counts characters itself, so the 60-character cut is the same
# whether the awk is byte-oriented or UTF-8-aware.
#
# peers:
#   .agents/skills/close/scripts/roadmap.test.sh
#   .agents/skills/close/scripts/spec-state.sh   (what each Sub-spec's state is)
#   .agents/skills/project/references/templates/ROADMAP.md

set -uo pipefail

err() { echo "roadmap: $*" >&2; }
usage() { err "usage: roadmap.sh <project-folder> [--next | --ready | --check <ID> | --set <ID> <status> [--sub-spec <path>] | --sync-next]"; exit 2; }

[[ $# -ge 1 ]] || usage
project_dir="$1"; shift
[[ -d "$project_dir" ]] || { err "not a directory: $project_dir"; exit 2; }
roadmap="$project_dir/ROADMAP.md"

mode="list" set_id="" set_status="" set_subspec=""
case "${1:-}" in
  "") ;;
  --next) mode="next"; [[ $# -eq 1 ]] || usage ;;
  --ready) mode="ready"; [[ $# -eq 1 ]] || usage ;;
  --check) mode="check"; [[ $# -eq 2 && -n "$2" ]] || usage; set_id="$2" ;;
  --sync-next) mode="sync"; [[ $# -eq 1 ]] || usage ;;
  --set)
    mode="set"
    [[ $# -eq 3 || ( $# -eq 5 && "$4" == "--sub-spec" ) ]] || usage
    set_id="$2"; set_status="$3"; set_subspec="${5:-}"
    case "$set_status" in
      planned|in-progress|done|"blocked: "?*|"absorbed by "?*) ;;
      *) err "not a status: '$set_status' (planned · in-progress · done · blocked: <what> · absorbed by <ID>)"; exit 2 ;;
    esac
    ;;
  *) usage ;;
esac

[[ -f "$roadmap" ]] || { err "no ROADMAP.md in $project_dir"; exit 1; }

# Replace $1 with the content of $2 through a temp file + mv in the same
# folder, keeping $1's mode (cp -p) and its missing final newline if it had
# none (awk's print always adds one; command substitution strips exactly that
# one, because the original ended on a non-newline byte).
replace_atomic() {
  local target="$1" content="$2" swap body
  swap="$(mktemp "${target}.XXXXXX")" || return 1
  cp -p "$target" "$swap" 2>/dev/null || true
  if [[ -n "$(tail -c1 "$target")" ]]; then
    body="$(cat "$content")"
    printf '%s' "$body" >"$swap" || { rm -f "$swap"; return 1; }
  else
    cat "$content" >"$swap" || { rm -f "$swap"; return 1; }
  fi
  mv -f "$swap" "$target" || { rm -f "$swap"; return 1; }
}

# One writer at a time per project (lock.sh: a pid symlink beside the table).
# shellcheck disable=SC1091  # sibling file, resolved at run time
source "$(dirname "${BASH_SOURCE[0]}")/lock.sh"
LOCK="$project_dir/.roadmap.lock"
take_lock() {
  lock_take "$LOCK" "${ROADMAP_LOCK_WAIT:-30}" && return 0
  err "another session is writing this project (lock $LOCK held by pid ${LOCK_HOLDER:-?}); nothing was written"
  exit 1
}

# The whole table model, in one awk program so list, --next, --ready and --set
# cannot read the table differently from each other.
parse() {
  LC_ALL=C awk -v mode="$1" -v set_id="$set_id" -v set_status="$set_status" -v set_subspec="$set_subspec" '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    # Split a table line into raw segments between unescaped pipes. seg[1] is
    # whatever precedes the first pipe, seg[n] whatever follows the last.
    function segs(line, seg,    i, c, n, cur) {
      n = 1; cur = ""
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (c == "\\" && substr(line, i + 1, 1) == "|") { cur = cur "\\|"; i++; continue }
        if (c == "|") { seg[n++] = cur; cur = ""; continue }
        cur = cur c
      }
      seg[n] = cur
      return n
    }
    # Cells of a row: the segments between the leading and trailing pipe.
    function cells(line, cell,    seg, n, i, k) {
      n = segs(line, seg); k = 0
      for (i = 2; i < n; i++) cell[++k] = trim(seg[i])
      if (trim(seg[n]) != "") cell[++k] = trim(seg[n])   # row with no trailing pipe
      return k
    }
    # Characters of s, one per slot. A UTF-8 continuation byte joins the slot
    # before it, so this counts characters under a byte-oriented awk; under a
    # UTF-8-aware awk each substr is already a character and nothing joins.
    function uchars(s, out,    n, i, c) {
      n = 0
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (n > 0 && c ~ /^[\200-\277]$/) out[n] = out[n] c
        else out[++n] = c
      }
      return n
    }
    function ujoin(a, from, to,    s, i) { s = ""; for (i = from; i <= to; i++) s = s a[i]; return s }
    function fail(msg) { print "roadmap: " msg > "/dev/stderr"; failed = 1; exit 1 }
    function subspec_name(s,    m) {
      if (match(s, /`[^`]*\.spec\.md`/)) {
        m = substr(s, RSTART + 1, RLENGTH - 2); sub(/.*\//, "", m); sub(/\.spec\.md$/, "", m); return m
      }
      gsub(/`/, "", s); s = trim(s)
      if (s == "" || s == "—" || s == "-") return "—"
      sub(/\/+$/, "", s)
      return s
    }
    function row_tsv(r) { return rid[r] "\t" rstatus[r] "\t" (ready[r] ? "yes" : "no") "\t" rsub[r] "\t" rfeat[r] }
    BEGIN { state = "seek-heading" }
    { line[NR] = $0 }
    state == "seek-heading" { if ($0 ~ /^#[ \t]+Roadmap([ \t:]|$)/) state = "seek-table"; next }
    state == "seek-table" && /^[ \t]*\|/ {
      nh = cells($0, hdr)
      col_id = col_status = col_sub = col_feat = col_dep = 0
      for (i = 1; i <= nh; i++) {
        h = tolower(hdr[i])
        if (h == "id") col_id = i
        else if (h == "status") col_status = i
        else if (h == "sub-spec") col_sub = i
        else if (h == "sub-feature") col_feat = i
        else if (h == "depends on") col_dep = i
      }
      state = (col_id && col_status) ? "sep" : "skip-table"
      next
    }
    state == "skip-table" { if ($0 !~ /^[ \t]*\|/) state = "seek-table"; next }
    state == "sep" {
      state = "rows"
      if ($0 ~ /^[ \t]*\|[ \t:|-]*$/) next
    }
    state == "rows" {
      if ($0 !~ /^[ \t]*\|/) { state = "done"; next }
      nc = cells($0, c)
      if (nc != nh) fail("row at line " NR " has " nc " cells, the header has " nh)
      id = c[col_id]
      if (id == "") fail("row at line " NR " has no ID")
      if (toupper(id) in seen) fail("ID " id " appears twice")
      seen[toupper(id)] = 1
      feat = col_feat ? c[col_feat] : ""
      if (feat ~ /^<[^>]*>$/) fail("placeholder row " id " — the template was never filled in")
      nrow++; rid[nrow] = id; rline[nrow] = NR
      rstatus[nrow] = c[col_status]; rfeat[nrow] = feat
      rsub[nrow] = col_sub ? subspec_name(c[col_sub]) : "—"
      rdep[nrow] = col_dep ? c[col_dep] : ""
      byid[toupper(id)] = nrow
      next
    }
    END {
      if (failed) exit 1
      if (state == "seek-heading") fail("no `# Roadmap` heading in ROADMAP.md")
      if (!col_id || !col_status || state == "seek-table" || state == "skip-table")
        fail("no table under `# Roadmap` with ID and Status columns")

      # Status → kind. The vocabulary is the template derivation rule.
      for (r = 1; r <= nrow; r++) {
        s = tolower(rstatus[r])
        if (s == "planned" || s == "in-progress" || s == "done") kind[r] = s
        else if (s ~ /^blocked:/) kind[r] = "blocked"
        else if (s ~ /^absorbed by /) kind[r] = "absorbed"
        else { kind[r] = "unknown"; print "roadmap: " rid[r] " has unknown status" > "/dev/stderr" }
      }
      for (r = 1; r <= nrow; r++) {
        ready[r] = (kind[r] == "planned" || kind[r] == "in-progress")
        d = trim(rdep[r])
        if (d == "" || d == "—" || d == "-") continue
        nd = split(d, deps, ",")
        for (k = 1; k <= nd; k++) {
          dep = trim(deps[k]); gsub(/`/, "", dep)
          if (dep == "") continue
          if (!(toupper(dep) in byid)) {
            print "roadmap: " rid[r] " depends on unknown " dep > "/dev/stderr"
            ready[r] = 0; continue
          }
          dk = kind[byid[toupper(dep)]]
          if (dk != "done" && dk != "absorbed") ready[r] = 0
        }
      }

      if (mode == "list") {
        for (r = 1; r <= nrow; r++) print row_tsv(r)
        exit 0
      }
      if (mode == "ready") {
        for (r = 1; r <= nrow; r++) if (ready[r] && kind[r] == "in-progress") print row_tsv(r)
        for (r = 1; r <= nrow; r++) if (ready[r] && kind[r] == "planned") print row_tsv(r)
        exit 0
      }
      if (mode == "check") {
        if (!(toupper(set_id) in byid)) {
          ids = ""; for (r = 1; r <= nrow; r++) ids = ids (ids == "" ? "" : ", ") rid[r]
          fail("no row " set_id " in ROADMAP.md (rows: " (ids == "" ? "none" : ids) ")")
        }
        r = byid[toupper(set_id)]; bad = 0
        if (kind[r] != "planned" && kind[r] != "in-progress") {
          print "roadmap: " rid[r] " not ready: its Status is `" rstatus[r] "`" > "/dev/stderr"; bad = 1
        }
        d = trim(rdep[r])
        if (d != "" && d != "—" && d != "-") {
          nd = split(d, deps, ",")
          for (k = 1; k <= nd; k++) {
            dep = trim(deps[k]); gsub(/`/, "", dep)
            if (dep == "") continue
            if (!(toupper(dep) in byid)) { print "roadmap: " rid[r] " not ready: depends on " dep ", which is not a row" > "/dev/stderr"; bad = 1; continue }
            q = byid[toupper(dep)]
            if (kind[q] != "done" && kind[q] != "absorbed") {
              print "roadmap: " rid[r] " not ready: depends on " rid[q] ", which is `" rstatus[q] "`" > "/dev/stderr"; bad = 1
            }
          }
        }
        if (rsub[r] == "—") { print "roadmap: " rid[r] " not ready: no spec yet (Sub-spec is —) — run /project" > "/dev/stderr"; bad = 1 }
        if (bad) exit 1
        print rsub[r]
        exit 0
      }
      if (mode == "next") {
        pick = 0
        for (r = 1; r <= nrow && !pick; r++) if (ready[r] && kind[r] == "in-progress") pick = r
        for (r = 1; r <= nrow && !pick; r++) if (ready[r] && kind[r] == "planned") pick = r
        if (!pick) exit 0
        head = rid[pick] ": "
        nf = uchars(rfeat[pick], fc)
        if (length(head) + nf <= 60) v = head rfeat[pick]
        else {
          room = 60 - length(head) - 1          # 1 for the ellipsis
          if (fc[room + 1] == " ") f = ujoin(fc, 1, room)
          else { f = ujoin(fc, 1, room); sub(/[ \t]+[^ \t]*$/, "", f) }
          sub(/[ \t,;:]+$/, "", f)
          v = head f "…"
        }
        gsub(/"/, "\\\"", v)
        printf "\"%s\"\n", v
        exit 0
      }
      if (mode == "set") {
        # Test membership BEFORE indexing: reading byid[x] would create the key.
        if (!(toupper(set_id) in byid)) {
          ids = ""; for (r = 1; r <= nrow; r++) ids = ids (ids == "" ? "" : ", ") rid[r]
          fail("no row " set_id " in ROADMAP.md (rows: " (ids == "" ? "none" : ids) ")")
        }
        target = byid[toupper(set_id)]
        if (set_subspec != "" && !col_sub) fail("no Sub-spec column to set")
        ln = rline[target]
        n = segs(line[ln], seg)
        seg[col_status + 1] = " " set_status " "
        if (set_subspec != "") seg[col_sub + 1] = " `" set_subspec "` "
        out = seg[1]; for (i = 2; i <= n; i++) out = out "|" seg[i]
        line[ln] = out
        for (i = 1; i <= NR; i++) print line[i]
        exit 0
      }
    }
  ' "$roadmap"
}

case "$mode" in
  list|next|ready) parse "$mode" ;;
  check)
    sub="$(parse check)" || exit 1
    state="$(bash "$(dirname "${BASH_SOURCE[0]}")/spec-state.sh" "$project_dir" | awk -F'\t' -v n="$sub" '$1==n && !f {print $2; f=1}')"
    case "$state" in
      none|partial) printf '%s\n' "$sub" ;;
      complete) err "$set_id not ready: its spec $sub is already complete — /close flips the row to done"; exit 1 ;;
      *) err "$set_id not ready: its Sub-spec $sub is not on disk — run /project"; exit 1 ;;
    esac
    ;;
  set)
    take_lock
    tmp="$(mktemp "${roadmap}.XXXXXX")" || { err "cannot write beside $roadmap"; exit 1; }
    if parse set >"$tmp"; then
      if replace_atomic "$roadmap" "$tmp"; then rm -f "$tmp"; else rm -f "$tmp"; err "cannot write $roadmap"; exit 1; fi
    else
      rm -f "$tmp"; exit 1
    fi
    ;;
  sync)
    readme="$project_dir/README.md"
    [[ -f "$readme" ]] || { err "no README.md in $project_dir"; exit 1; }
    take_lock
    [[ "$(head -n1 "$readme")" == "---" ]] || { err "README.md has no frontmatter"; exit 1; }
    value="$(parse next)" || exit 1
    tmp="$(mktemp "${readme}.XXXXXX")" || { err "cannot write beside $readme"; exit 1; }
    # Only frontmatter lines are touched. An existing `next:` is replaced where it
    # stands (and removed when no row is ready); a missing one goes after the
    # `description:` entry, or before the closing `---` when there is none.
    LC_ALL=C awk -v value="$value" '
      NR == FNR {
        if (FNR == 1) { fm = 1; next }
        if (fm == 1 && $0 == "---") { fm = 2; close_at = FNR }
        if (fm == 1 && /^next:/) has_next = 1
        if (fm == 1 && /^description:/) desc_at = FNR
        if (fm == 1 && desc_at && FNR > desc_at && !desc_end && !/^[ \t]/) desc_end = FNR - 1
        next
      }
      FNR == 1 { if (desc_at && !desc_end) desc_end = close_at - 1 }
      FNR < close_at && /^next:/ { if (value != "" && !done) { print "next: " value; done = 1 }; next }
      { print }
      !has_next && value != "" && !done && desc_at && FNR == desc_end { print "next: " value; done = 1 }
      !has_next && value != "" && !done && !desc_at && FNR == close_at - 1 { print "next: " value; done = 1 }
    ' "$readme" "$readme" >"$tmp" || { rm -f "$tmp"; err "cannot rewrite $readme"; exit 1; }
    replace_atomic "$readme" "$tmp" || { rm -f "$tmp"; err "cannot write $readme"; exit 1; }
    rm -f "$tmp"
    ;;
esac
