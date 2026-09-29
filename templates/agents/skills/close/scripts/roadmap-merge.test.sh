#!/usr/bin/env bash
# roadmap-merge.test.sh — peer of roadmap-merge.sh: every rule of the row-by-row
# merge, and every case that must still conflict.
#
# Each case writes a base, an ours and a theirs, runs the driver the way git
# does (result into ours), and checks the exit status and the merged table.
#
# Run: bash .agents/skills/close/scripts/roadmap-merge.test.sh
# shellcheck disable=SC2016  # table rows hold literal backticks
set -uo pipefail

SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/roadmap-merge.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
is()  { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "ok   $1"; else FAIL=$((FAIL + 1)); echo "FAIL $1: got '$2', wanted '$3'"; fi; }
has() { case "$2" in *"$3"*) PASS=$((PASS + 1)); echo "ok   $1" ;; *) FAIL=$((FAIL + 1)); echo "FAIL $1: lacks '$3'"; esac; }

HDR='| ID | Sub-feature | Depends on | Status | Sub-spec |
|----|-------------|------------|--------|----------|'
# table <file> <rows...> — a roadmap with prose around the table.
table() {
  local f="$1"; shift
  { printf '# Roadmap: demo\n\nIntro prose.\n\n%s\n' "$HDR"; printf '%s\n' "$@"; printf '\nTrailing notes.\n'; } >"$f"
}
R1='| R1 | first | — | planned | `specs/001-first/` |'
R2='| R2 | second | — | planned | `specs/002-second/` |'
R3='| R3 | third | R1, R2 | planned | — |'

# merge <name> — runs the driver on $TMP/<name>.{o,a,b}; sets RC and OUT.
merge() { bash "$SUT" "$TMP/$1.o" "$TMP/$1.a" "$TMP/$1.b" ROADMAP.md; RC=$?; OUT="$(cat "$TMP/$1.a")"; }
rows() { printf '%s\n' "$OUT" | grep '^| R' | paste -sd'~' -; }

# ── Two sessions, two adjacent rows: the case git calls a conflict ─────────
table "$TMP/adj.o" "$R1" "$R2" "$R3"
table "$TMP/adj.a" '| R1 | first | — | done | `specs/001-first/` |' "$R2" "$R3"
table "$TMP/adj.b" "$R1" '| R2 | second | — | done | `specs/002-second/` |' "$R3"
cp "$TMP/adj.a" "$TMP/adj.git"
git merge-file -q "$TMP/adj.git" "$TMP/adj.o" "$TMP/adj.b"
is "(git's own line merge conflicts on adjacent rows)" "$?" "1"
merge adj
is "adjacent rows merge cleanly" "$RC" "0"
is "…keeping both rows' changes" "$(rows)" \
  '| R1 | first | — | done | `specs/001-first/` |~| R2 | second | — | done | `specs/002-second/` |~'"$R3"
has "…and the prose around the table" "$OUT" "Intro prose."
has "…both sides of it" "$OUT" "Trailing notes."

# ── One row, both sides moved its Status: the more advanced wins ───────────
table "$TMP/st.o" "$R1" "$R2"
table "$TMP/st.a" '| R1 | first | — | in-progress | `specs/001-first/` |' "$R2"
table "$TMP/st.b" '| R1 | first | — | done | `specs/001-first/` |' "$R2"
merge st
is "in-progress against done merges" "$RC" "0"
is "…to done" "$(rows)" '| R1 | first | — | done | `specs/001-first/` |~'"$R2"

# ── One row: Status on one side, Sub-spec on the other — cell by cell ──────
table "$TMP/cell.o" "$R3"
table "$TMP/cell.a" '| R3 | third | R1, R2 | in-progress | — |'
table "$TMP/cell.b" '| R3 | third | R1, R2 | planned | `specs/003-third/` |'
merge cell
is "different cells of one row merge" "$RC" "0"
is "…taking each side's cell" "$(rows)" '| R3 | third | R1, R2 | in-progress | `specs/003-third/` |'

# ── Sub-spec set on both sides, one to — : the real one wins ───────────────
table "$TMP/sub.o" '| R3 | third | R1, R2 | planned | `specs/003-x/` |'
table "$TMP/sub.a" '| R3 | third | R1, R2 | in-progress | — |'
table "$TMP/sub.b" '| R3 | third | R1, R2 | done | `specs/003-third/` |'
merge sub
is "a Sub-spec both sides changed, one to —, merges" "$RC" "0"
is "…to the one that names a spec, and the more advanced Status" "$(rows)" '| R3 | third | R1, R2 | done | `specs/003-third/` |'

# ── A row added on one side, and a blocked: set on one side ────────────────
table "$TMP/add.o" "$R1" "$R2"
table "$TMP/add.a" "$R1" "$R2" '| R4 | fourth | R3 | planned | — |'
table "$TMP/add.b" "$R1" '| R2 | second | — | blocked: vendor reply | `specs/002-second/` |'
merge add
is "a new row and a blocked row merge" "$RC" "0"
is "…with the new row kept and blocked: as written" "$(rows)" \
  "$R1"'~| R2 | second | — | blocked: vendor reply | `specs/002-second/` |~| R4 | fourth | R3 | planned | — |'

# ── A row deleted on one side and untouched on the other is deleted ────────
table "$TMP/del.o" "$R1" "$R2"
table "$TMP/del.a" "$R1"
table "$TMP/del.b" '| R1 | first | — | done | `specs/001-first/` |' "$R2"
merge del
is "a deletion against an unrelated edit merges" "$RC" "0"
is "…deleting the row" "$(rows)" '| R1 | first | — | done | `specs/001-first/` |'

# ── A row theirs inserted mid-table keeps its place ────────────────────────
table "$TMP/pos.o" "$R1" "$R3"
table "$TMP/pos.a" '| R1 | first | — | done | `specs/001-first/` |' "$R3"
table "$TMP/pos.b" "$R1" "$R2" "$R3"
merge pos
is "a row theirs inserted between two others merges" "$RC" "0"
is "…between the same two" "$(rows)" '| R1 | first | — | done | `specs/001-first/` |~'"$R2~$R3"

# …after any rows ours appended at the same place, so appends stay in order.
table "$TMP/app.o" "$R1"
table "$TMP/app.a" "$R1" "$R2"
table "$TMP/app.b" "$R1" "$R3"
merge app
is "rows both sides appended merge" "$RC" "0"
is "…ours first, then theirs" "$(rows)" "$R1~$R2~$R3"

# …and when the row theirs placed it after is one ours deleted, there is no
# place to put it: that is a conflict, not a guess.
table "$TMP/gone.o" "$R1" "$R2"
table "$TMP/gone.a" "$R1"
table "$TMP/gone.b" "$R1" "$R2" "$R3"
merge gone
is "a row placed after one ours deleted conflicts" "$RC" "1"

# ── Header names in either case, as roadmap.sh reads them ──────────────────
lower() { sed 's/| ID | Sub-feature | Depends on | Status | Sub-spec |/| id | Sub-feature | Depends on | status | Sub-spec |/' "$1" >"$1.l" && mv "$1.l" "$1"; }
cp "$TMP/adj.o" "$TMP/lc.o"; lower "$TMP/lc.o"
table "$TMP/lc.a" '| R1 | first | — | done | `specs/001-first/` |' "$R2" "$R3"; lower "$TMP/lc.a"
table "$TMP/lc.b" "$R1" '| R2 | second | — | done | `specs/002-second/` |' "$R3"; lower "$TMP/lc.b"
merge lc
is "a lower-case header merges row by row too" "$RC" "0"

# ── A result that cannot be written is a failed merge ──────────────────────
if [ "$(id -u)" != 0 ]; then
  table "$TMP/ro.o" "$R1" "$R2"
  table "$TMP/ro.a" '| R1 | first | — | done | `specs/001-first/` |' "$R2"
  table "$TMP/ro.b" "$R1" '| R2 | second | — | done | `specs/002-second/` |'
  chmod a-w "$TMP/ro.a"
  bash "$SUT" "$TMP/ro.o" "$TMP/ro.a" "$TMP/ro.b" ROADMAP.md 2>/dev/null; RC=$?
  chmod u+w "$TMP/ro.a"
  is "an unwritable result fails the merge" "$RC" "1"
fi

# ── Real conflicts still conflict ──────────────────────────────────────────
table "$TMP/txt.o" "$R1"
table "$TMP/txt.a" '| R1 | first thing | — | planned | `specs/001-first/` |'
table "$TMP/txt.b" '| R1 | the first | — | planned | `specs/001-first/` |'
merge txt
is "the same cell set to two texts conflicts" "$RC" "1"
has "…with git's markers" "$OUT" "<<<<<<< ROADMAP.md (ours)"

table "$TMP/blk.o" "$R1"
table "$TMP/blk.a" '| R1 | first | — | blocked: legal | `specs/001-first/` |'
table "$TMP/blk.b" '| R1 | first | — | done | `specs/001-first/` |'
merge blk
is "blocked: against done conflicts" "$RC" "1"

table "$TMP/de.o" "$R1" "$R2"
table "$TMP/de.a" "$R1"
table "$TMP/de.b" "$R1" '| R2 | second | — | done | `specs/002-second/` |'
merge de
is "a row deleted on one side and edited on the other conflicts" "$RC" "1"

table "$TMP/pr.o" "$R1"
table "$TMP/pr.a" "$R1"; sed 's/Intro prose./Ours says this./' "$TMP/pr.a" >"$TMP/pr.a2"; mv "$TMP/pr.a2" "$TMP/pr.a"
table "$TMP/pr.b" "$R1"; sed 's/Intro prose./Theirs says that./' "$TMP/pr.b" >"$TMP/pr.b2"; mv "$TMP/pr.b2" "$TMP/pr.b"
merge pr
is "prose changed two ways conflicts" "$RC" "1"

table "$TMP/p1.o" "$R1"
table "$TMP/p1.a" '| R1 | first | — | done | `specs/001-first/` |'
table "$TMP/p1.b" "$R1"; sed 's/Trailing notes./New notes./' "$TMP/p1.b" >"$TMP/p1.b2"; mv "$TMP/p1.b2" "$TMP/p1.b"
merge p1
is "prose changed on one side merges" "$RC" "0"
has "…taking that side's prose" "$OUT" "New notes."

# ── Not a roadmap: git's own merge, clean or not ───────────────────────────
printf 'a\nb\nc\n' >"$TMP/nt.o"; printf 'A\nb\nc\n' >"$TMP/nt.a"; printf 'a\nb\nC\n' >"$TMP/nt.b"
merge nt
is "a file with no roadmap table falls back to a clean line merge" "$RC" "0"
is "…with both edits" "$(tr '\n' ' ' <"$TMP/nt.a")" "A b C "

# ── A project README: next: set aside, the rest merged by line ─────────────
readme() {  # readme <file> <next> <body line>
  printf -- '---\nproject: demo\nstatus: active\nnext: %s\n---\n\n# Project\n\n%s\n\nEnd.\n' "$2" "$3" >"$1"
}
readme "$TMP/rd.o" '"R1: first"' "Body."
readme "$TMP/rd.a" '"R2: second"' "Body."
readme "$TMP/rd.b" '"R3: third"' "Body, edited by theirs."
bash "$SUT" "$TMP/rd.o" "$TMP/rd.a" "$TMP/rd.b" projects/x/README.md; RC=$?; OUT="$(cat "$TMP/rd.a")"
is "a README whose next: both sides rewrote merges" "$RC" "0"
has "…keeping ours, for land.sh to re-derive" "$OUT" 'next: "R2: second"'
has "…and theirs' body edit" "$OUT" "Body, edited by theirs."
readme "$TMP/rc.o" '"R1: first"' "Body."
readme "$TMP/rc.a" '"R2: second"' "Ours rewrote the body."
readme "$TMP/rc.b" '"R3: third"' "Theirs rewrote the body."
bash "$SUT" "$TMP/rc.o" "$TMP/rc.a" "$TMP/rc.b" projects/x/README.md; RC=$?
is "a README body both sides rewrote still conflicts" "$RC" "1"

echo
echo "roadmap-merge.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
