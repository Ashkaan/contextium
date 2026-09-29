#!/usr/bin/env bash
# roadmap-merge.sh — a git merge driver for ROADMAP.md: merge the table row by row.
#
# WHY. Two sessions building two rows of one project each flip their own row
# (planned → in-progress → done) and re-derive the README's `next:`. The rows are
# adjacent lines, and git's line merge calls adjacent edits a conflict, so the
# second of two parallel closes always stopped on NOT CLOSED with a conflict
# nobody had actually made. Keyed by row ID, the two edits never touch.
#
# THE RULES, per row ID across base (O), ours (A) and theirs (B):
#   - changed on one side only → that side's row (a `blocked: …` or
#     `absorbed by …` Status arrives exactly as the side that wrote it);
#   - added on one side → kept; added on both with the same text → kept once;
#   - deleted on one side and untouched on the other → deleted;
#   - changed on both → cell by cell: a cell only one side changed takes that
#     side's value; Status both changed takes the more advanced of
#     planned < in-progress < done; Sub-spec both changed takes the one that is
#     not `—`. Anything else — the same cell set to two different texts, a
#     `blocked:`/`absorbed by` both sides set differently, a row deleted on one
#     side and edited on the other — is a real conflict.
# Everything outside the table rows (the prose, the header) merges as whole
# blocks: identical, or changed on one side only. A real conflict anywhere
# falls back to git's own line merge, markers and all, and exits 1, so the
# close stops exactly as it did before.
#
# A PROJECT README (the path's last part is README.md) is merged by git's own
# line merge with one line set aside: its front-matter `next:`, which both
# sessions re-derive from their own copy of the table and so rewrite two ways.
# Ours is kept here, and land.sh re-derives it from the merged ROADMAP.md right
# after the merge, so the value that lands describes the merged table.
#
# The table is the one roadmap.sh reads: the first table under `# Roadmap`
# whose header names both ID and Status; Status and Sub-spec are found by
# header name. Cells split on unescaped `|`.
#
# Usage (git runs it; land.sh registers it before it merges):
#   roadmap-merge.sh <base> <ours> <theirs> [<path>]    result written to <ours>;
#   <path> ending in README.md selects the README rule above
# Exit: 0 merged cleanly · 1 conflict (markers written to <ours>) · 2 usage
#
# Portable: bash 3.2, any POSIX awk under LC_ALL=C.
#
# peers:
#   .agents/skills/close/scripts/roadmap-merge.test.sh
#   .agents/skills/close/scripts/roadmap.sh   (the table's one reader and writer)
#   .agents/skills/close/scripts/land.sh      (registers the driver before merging)

set -uo pipefail

[[ $# -ge 3 ]] || { echo "usage: roadmap-merge.sh <base> <ours> <theirs> [<path>]" >&2; exit 2; }
BASE="$1" OURS="$2" THEIRS="$3" NAME="${4:-ROADMAP.md}"
for f in "$BASE" "$OURS" "$THEIRS"; do
  [[ -f "$f" ]] || { echo "roadmap-merge: no such file: $f" >&2; exit 2; }
done

OUT="$(mktemp)"
trap 'rm -f "$OUT" "$OUT.o" "$OUT.b"' EXIT

# next_aside <file> <next-line> — the file with its front-matter `next:` line
# replaced by <next-line> (removed when that is empty), on stdout.
next_aside() {
  awk -v want="$2" '
    NR == 1 && $0 == "---" { fm = 1; print; next }
    fm && $0 == "---" { fm = 0; print; next }
    fm && /^next:/ && !done { done = 1; if (want != "") print want; next }
    { print }
  ' "$1"
}
if [[ "$(basename "$NAME")" == "README.md" ]]; then
  ours_next="$(awk 'NR == 1 && $0 == "---" { fm = 1; next } fm && $0 == "---" { exit } fm && /^next:/ { print; exit }' "$OURS")"
  next_aside "$BASE" "$ours_next" >"$OUT.o"
  next_aside "$THEIRS" "$ours_next" >"$OUT.b"
  if git merge-file -L "$NAME (ours)" -L "$NAME (base)" -L "$NAME (theirs)" \
      "$OURS" "$OUT.o" "$OUT.b" >/dev/null 2>&1; then
    exit 0
  fi
  exit 1
fi

# shellcheck disable=SC2016  # the awk program must reach awk unexpanded
LC_ALL=C awk '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
# Split a table line into C[1..n] on unescaped pipes; returns n.
function cells(line, C,    n, i, ch, cur, prev) {
  n = 0; cur = ""; prev = ""
  for (i = 1; i <= length(line); i++) {
    ch = substr(line, i, 1)
    if (ch == "|" && prev != "\\") { C[++n] = trim(cur); cur = "" }
    else cur = cur ch
    prev = ch
  }
  C[++n] = trim(cur)
  return n
}
function rank(s) { s = tolower(s); return s == "planned" ? 0 : s == "in-progress" ? 1 : s == "done" ? 2 : -1 }

{ L[FILENAME, ++N[FILENAME]] = $0 }
FNR == 1 { F[++nf] = FILENAME }

END {
  if (nf != 3) exit 1
  for (k = 1; k <= 3; k++) {
    f = F[k]; H[k] = 0; inr = 0
    for (i = 1; i <= N[f]; i++) {
      if (L[f, i] ~ /^#[ \t]+Roadmap([ \t:]|$)/) inr = 1
      if (inr && !H[k] && L[f, i] ~ /^[ \t]*\|/) {
        # Header names compared without case, as roadmap.sh compares them.
        n = cells(L[f, i], C); idc[k] = 0; hasst = 0
        for (c = 2; c < n; c++) { if (tolower(C[c]) == "id") idc[k] = c; if (tolower(C[c]) == "status") hasst = 1 }
        if (idc[k] && hasst) { H[k] = i; break }
      }
    }
    if (!H[k]) exit 1
    # Rows run from the line after the separator to the first non-table line.
    R0[k] = H[k] + 2; R1[k] = R0[k] - 1
    for (i = R0[k]; i <= N[f] && L[f, i] ~ /^[ \t]*\|/; i++) R1[k] = i
    pre[k] = ""; for (i = 1; i <= H[k] + 1; i++) pre[k] = pre[k] L[f, i] "\n"
    post[k] = ""; for (i = R1[k] + 1; i <= N[f]; i++) post[k] = post[k] L[f, i] "\n"
    ids[k] = 0
    for (i = R0[k]; i <= R1[k]; i++) {
      cells(L[f, i], C); id = C[idc[k]]
      if (id == "" || ((k, id) in ROW)) exit 1
      ROW[k, id] = L[f, i]; ORD[k, ++ids[k]] = id
    }
  }
  # Column positions, by header name, from ours (the headers must agree).
  n = cells(L[F[2], H[2]], HC); stc = 0; sbc = 0
  for (c = 2; c < n; c++) { if (tolower(HC[c]) == "status") stc = c; if (tolower(HC[c]) == "sub-spec") sbc = c }
  # Prose and header: identical, or changed on one side only.
  if (pre[2] == pre[3] || pre[3] == pre[1]) P = pre[2]; else if (pre[2] == pre[1]) P = pre[3]; else exit 1
  if (post[2] == post[3] || post[3] == post[1]) Q = post[2]; else if (post[2] == post[1]) Q = post[3]; else exit 1

  out = P; nout = 0
  # Ours in its own order; each row only theirs has goes where theirs put it:
  # right after the row that precedes it in theirs, past any rows ours added
  # there (so two sides appending keep ours first). When that preceding row is
  # one ours deleted, there is no place to put it — a conflict, not a guess.
  for (j = 1; j <= ids[2]; j++) { SEQ[++nout] = ORD[2, j]; INSEQ[ORD[2, j]] = 1 }
  for (j = 1; j <= ids[3]; j++) {
    id = ORD[3, j]
    if (id in INSEQ) continue
    # In base but not in ours: ours deleted it. Deleted it stays, unless theirs
    # edited it — a delete against an edit is a conflict.
    if ((1, id) in ROW) { if (ROW[3, id] != ROW[1, id]) exit 1; continue }
    if (j == 1) pos = 0
    else {
      prev = ORD[3, j - 1]
      if (!(prev in INSEQ)) exit 1
      for (pos = 1; pos <= nout && SEQ[pos] != prev; pos++) ;
      while (pos < nout && !((1, SEQ[pos + 1]) in ROW) && !((3, SEQ[pos + 1]) in ROW)) pos++
    }
    for (q = nout; q > pos; q--) SEQ[q + 1] = SEQ[q]
    SEQ[pos + 1] = id; nout++; INSEQ[id] = 1
  }
  # A row in base only was deleted on both sides: it is in neither list.

  for (j = 1; j <= nout; j++) {
    id = SEQ[j]
    o = ((1, id) in ROW) ? ROW[1, id] : ""; ino = ((1, id) in ROW)
    a = ((2, id) in ROW) ? ROW[2, id] : ""; ina = ((2, id) in ROW)
    b = ((3, id) in ROW) ? ROW[3, id] : ""; inb = ((3, id) in ROW)
    if (ina && inb) {
      if (a == b || b == o) { out = out a "\n"; continue }
      if (a == o) { out = out b "\n"; continue }
      # Both changed: cell by cell.
      na = cells(a, CA); nb = cells(b, CB)
      if (ino) no = cells(o, CO); else { no = na; for (c = 1; c <= no; c++) CO[c] = "\001" }
      if (na != nb || na != no) exit 1
      row = ""
      for (c = 2; c < na; c++) {
        x = CA[c]; y = CB[c]; z = CO[c]
        if (x == y || y == z) v = x
        else if (x == z) v = y
        else if (c == stc && rank(x) >= 0 && rank(y) >= 0) v = rank(x) >= rank(y) ? x : y
        else if (c == sbc && (x == "—" || x == "-" || x == "")) v = y
        else if (c == sbc && (y == "—" || y == "-" || y == "")) v = x
        else exit 1
        row = row "| " v " "
      }
      out = out row "|\n"
    } else if (ina) {
      # Theirs lacks it: new in ours, or deleted in theirs.
      if (!ino) out = out a "\n"
      else if (a != o) exit 1
    } else if (inb) {
      if (!ino) out = out b "\n"
      else if (b != o) exit 1
    }
  }
  printf "%s%s", out, Q > OUTFILE
}
' OUTFILE="$OUT" "$BASE" "$OURS" "$THEIRS"
RC=$?

if [[ "$RC" -eq 0 && -s "$OUT" ]]; then
  # git reads the result out of <ours>: a write that failed is a failed merge,
  # never a clean one over whatever the file was left holding.
  if ! cat "$OUT" >"$OURS"; then
    echo "roadmap-merge: could not write the merged table to $OURS" >&2
    exit 1
  fi
  exit 0
fi

# A real conflict, or a file this driver cannot read as a roadmap: git's own
# line merge, markers and all. It exits with the number of conflicts, so a file
# it merges cleanly (a roadmap whose table did not move) still merges.
if git merge-file -L "$NAME (ours)" -L "$NAME (base)" -L "$NAME (theirs)" \
    "$OURS" "$BASE" "$THEIRS" >/dev/null 2>&1; then
  exit 0
fi
exit 1
