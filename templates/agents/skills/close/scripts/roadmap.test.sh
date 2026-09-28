#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures are literal markdown; backticks are not expansions
# roadmap.test.sh — peer of roadmap.sh. Run: bash roadmap.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/roadmap.sh"
TEMPLATE="$HERE/../../project/references/templates/ROADMAP.md"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# portable in-place edit: sed_i <expr> <file>
sed_i() { sed "$1" "$2" >"$2.new" && mv "$2.new" "$2"; }

HDR='| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|'
# mk <name> <rows...> — a project with a README and a ROADMAP holding those rows
mk() {
  local d="$tmp/$1"; shift
  mkdir -p "$d"
  printf -- '---\nproject: x\nstatus: active\ndescription: A thing\n---\n\n# Project\n' >"$d/README.md"
  { printf '# Roadmap: test\n\nIntro.\n\n**Status legend**: planned · in-progress · done\n\n%s\n' "$HDR"
    local r; for r in "$@"; do printf '%s\n' "$r"; done
    printf '\nTrailing prose.\n'; } >"$d/ROADMAP.md"
  printf '%s' "$d"
}
list() { bash "$SUT" "$1" 2>/dev/null; }
rc_of() { bash "$SUT" "$@" >/dev/null 2>&1; echo $?; }
# shellcheck disable=SC2069  # stderr only, on purpose: the message is the assertion
errs() { bash "$SUT" "$@" 2>&1 >/dev/null; }

# 0 rows: header only
d="$(mk empty)"
t "header-only prints nothing" "" "$(list "$d")"
t "header-only exits 0" "0" "$(rc_of "$d")"
t "header-only has no next" "" "$(bash "$SUT" "$d" --next)"
t "header-only has no ready rows" "" "$(bash "$SUT" "$d" --ready)"

# 1 row
d="$(mk one '| R1 | alpha | i | s | — | planned | — |')"
t "one row TSV" "R1	planned	yes	—	alpha" "$(list "$d")"
t "one row next" '"R1: alpha"' "$(bash "$SUT" "$d" --next)"

# The unfilled template: placeholder rows are a malformed table, not three rows
if [[ -f "$TEMPLATE" ]]; then
  d="$tmp/tpl"; mkdir -p "$d"; cp "$TEMPLATE" "$d/ROADMAP.md"
  t "unfilled template exits 1" "1" "$(rc_of "$d")"
  t "unfilled template names the placeholder" "roadmap: placeholder row R1 — the template was never filled in" "$(errs "$d")"
else
  echo "SKIP: unfilled template (no $TEMPLATE)"
fi
d="$(mk ph '| R1 | <name> | i | s | — | planned | — |')"
t "placeholder row exits 1" "1" "$(rc_of "$d")"

# Wrong cell count
d="$(mk cells '| R1 | alpha | i | s | — | planned |')"
t "short row exits 1" "1" "$(rc_of "$d")"
case "$(errs "$d")" in *"has 6 cells, the header has 7"*) t "short row message" ok ok ;; *) t "short row message" "has 6 cells" "$(errs "$d")" ;; esac

# blocked: with spaces; absorbed by satisfies a dependency
d="$(mk blk \
  '| R1 | alpha | i | s | — | blocked: vendor reply | — |' \
  '| R2 | beta | i | s | — | absorbed by R3 | — |' \
  '| R3 | gamma | i | s | R2 | planned | — |' \
  '| R4 | delta | i | s | R1 | planned | — |')"
t "blocked keeps its spaces" "blocked: vendor reply" "$(list "$d" | awk -F'\t' '$1=="R1"{print $2}')"
t "blocked is never ready" "no" "$(list "$d" | awk -F'\t' '$1=="R1"{print $3}')"
t "absorbed is never ready" "no" "$(list "$d" | awk -F'\t' '$1=="R2"{print $3}')"
t "absorbed by satisfies a dependency" "yes" "$(list "$d" | awk -F'\t' '$1=="R3"{print $3}')"
t "a blocked dependency is unsatisfied" "no" "$(list "$d" | awk -F'\t' '$1=="R4"{print $3}')"

# Unknown dependency: not ready, warned, exit 0
d="$(mk unk '| R5 | eps | i | s | R99 | planned | — |')"
t "unknown dep not ready" "no" "$(list "$d" | cut -f3)"
t "unknown dep warns" "roadmap: R5 depends on unknown R99" "$(errs "$d")"
t "unknown dep exits 0" "0" "$(rc_of "$d")"

# Unknown status: warned, not ready
d="$(mk ust '| R16 | fut | i | s | — | waiting on the vendor | — |')"
t "unknown status warns" "roadmap: R16 has unknown status" "$(errs "$d")"
t "unknown status not ready" "no" "$(list "$d" | cut -f3)"

# Depends on: several IDs, whitespace trimmed, all must be satisfied
d="$(mk deps \
  '| R1 | a | i | s | — | done | — |' \
  '| R2 | b | i | s | — | planned | — |' \
  '| R3 | c | i | s | R1 ,  R2 | planned | — |' \
  '| R4 | d | i | s | R1,R1 | planned | — |')"
t "one unsatisfied among several" "no" "$(list "$d" | awk -F'\t' '$1=="R3"{print $3}')"
t "all satisfied" "yes" "$(list "$d" | awk -F'\t' '$1=="R4"{print $3}')"
t "done is never ready" "no" "$(list "$d" | awk -F'\t' '$1=="R1"{print $3}')"

# in-progress beats an EARLIER planned row for --next and --ready
d="$(mk ord \
  '| R1 | first planned | i | s | — | planned | — |' \
  '| R2 | the one moving | i | s | — | in-progress | — |' \
  '| R3 | finished | i | s | — | done | — |')"
t "in-progress beats earlier planned" '"R2: the one moving"' "$(bash "$SUT" "$d" --next)"
t "--ready lists in-progress then planned, never done" "R2 R1" "$(bash "$SUT" "$d" --ready | cut -f1 | paste -s -d' ' -)"

# A 70-character Sub-feature is cut at a whole word with an ellipsis
long="sync engine adopts the shape and every reader follows along with it ok"
d="$(mk long "| R3 | $long | i | s | — | planned | — |")"
nxt="$(bash "$SUT" "$d" --next)"
t "long next is cut at a word" '"R3: sync engine adopts the shape and every reader follows…"' "$nxt"
# Multi-byte characters count once each, whatever the awk.
d="$(mk utf "| R4 | café señor — naïve résumé über straße déjà vu façade coöp élan ok |  i | s | — | planned | — |")"
nxt="$(bash "$SUT" "$d" --next)"
t "multi-byte next is cut by characters" '"R4: café señor — naïve résumé über straße déjà vu façade…"' "$nxt"

# Sub-spec forms
d="$(mk subs \
  '| R1 | a | i | s | — | done | `decision-records.spec.md` → `decision-records-report.md` |' \
  '| R2 | b | i | s | — | planned | `specs/004-mech/` |' \
  '| R3 | c | i | s | — | planned | specs/005-bare/ |')"
t "legacy Sub-spec gives the stem" "decision-records" "$(list "$d" | awk -F'\t' '$1=="R1"{print $4}')"
t "folder Sub-spec gives specs/NNN-name" "specs/004-mech" "$(list "$d" | awk -F'\t' '$1=="R2"{print $4}')"
t "unticked folder Sub-spec" "specs/005-bare" "$(list "$d" | awk -F'\t' '$1=="R3"{print $4}')"

# --set changes only the target row's Status and Sub-spec cells
d="$(mk set \
  '| R1 | a | i | s | — | planned | — |' \
  '| R2 |   b spaced   | i | s | R1 | planned | — |' \
  '| R3 | c | i | s | — | planned | — |')"
cp "$d/ROADMAP.md" "$tmp/set.before"
bash "$SUT" "$d" --set r2 in-progress --sub-spec specs/001-b/
t "--set exits 0" "0" "$?"
t "--set rewrote the row" '| R2 |   b spaced   | i | s | R1 | in-progress | `specs/001-b/` |' "$(grep '^| R2' "$d/ROADMAP.md")"
t "--set left every other line alone" "" "$(diff <(grep -v '^| R2' "$tmp/set.before") <(grep -v '^| R2' "$d/ROADMAP.md"))"
t "--set line count unchanged" "$(wc -l <"$tmp/set.before")" "$(wc -l <"$d/ROADMAP.md")"
t "--set missing row exits 1" "1" "$(rc_of "$d" --set R9 "done")"
t "--set missing row lists the IDs" "roadmap: no row R9 in ROADMAP.md (rows: R1, R2, R3)" "$(errs "$d" --set R9 "done")"
t "--set bad status is usage" "2" "$(rc_of "$d" --set R1 finished)"
bash "$SUT" "$d" --set R1 "blocked: 2026-10-02"
t "--set status only leaves Sub-spec" '| R1 | a | i | s | — | blocked: 2026-10-02 | — |' "$(grep '^| R1' "$d/ROADMAP.md")"
# A file with no final newline keeps having none.
printf '%s' "$(cat "$d/ROADMAP.md")" >"$d/ROADMAP.md"
bash "$SUT" "$d" --set R3 "done"
t "--set keeps a missing final newline missing" "." "$(tail -c1 "$d/ROADMAP.md")"
t "--set on a no-newline file still rewrote" '| R3 | c | i | s | — | done | — |' "$(grep '^| R3' "$d/ROADMAP.md")"

# --sync-next: insert after description, replace, remove
d="$(mk sync '| R1 | alpha | i | s | — | planned | — |')"
bash "$SUT" "$d" --sync-next
t "--sync-next inserts after description" "description: A thing
next: \"R1: alpha\"" "$(sed -n '4,5p' "$d/README.md")"
bash "$SUT" "$d" --set R1 in-progress
sed_i 's/| alpha |/| alpha renamed |/' "$d/ROADMAP.md"
bash "$SUT" "$d" --sync-next
t "--sync-next replaces in place" 'next: "R1: alpha renamed"' "$(sed -n 5p "$d/README.md")"
t "--sync-next leaves one next line" "1" "$(grep -c '^next:' "$d/README.md")"
cp "$d/README.md" "$tmp/sync.before"
bash "$SUT" "$d" --set R1 "done"
bash "$SUT" "$d" --sync-next
t "--sync-next removes when none ready" "0" "$(grep -c '^next:' "$d/README.md")"
t "--sync-next removal changes nothing else" "" "$(diff <(grep -v '^next:' "$tmp/sync.before") "$d/README.md")"
d2="$(mk nodesc '| R1 | alpha | i | s | — | planned | — |')"
printf -- '---\nproject: x\nstatus: active\n---\n\n# P\n' >"$d2/README.md"
bash "$SUT" "$d2" --sync-next
t "--sync-next with no description goes before ---" 'next: "R1: alpha"
---' "$(sed -n '4,5p' "$d2/README.md")"
t "--sync-next with no README exits 1" "1" "$(rm "$d2/README.md"; rc_of "$d2" --sync-next)"

# Columns are found by header name
d="$tmp/reorder"; mkdir -p "$d"
printf '# Roadmap: r\n\n| Status | Sub-spec | ID | Depends on | Sub-feature |\n|---|---|---|---|---|\n| done | — | R1 | — | a |\n| planned | `specs/002-b/` | R2 | R1 | b |\n' >"$d/ROADMAP.md"
t "reordered columns read by name" "R2	planned	yes	specs/002-b	b" "$(list "$d" | sed -n 2p)"

# Malformed: no Status column / no heading / no file
d="$tmp/nostatus"; mkdir -p "$d"
printf '# Roadmap: r\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n' >"$d/ROADMAP.md"
t "no Status column exits 1" "1" "$(rc_of "$d")"
t "no Status column message" "roadmap: no table under \`# Roadmap\` with ID and Status columns" "$(errs "$d")"
d="$tmp/nohead"; mkdir -p "$d"
printf '| ID | Status |\n|---|---|\n| R1 | planned |\n' >"$d/ROADMAP.md"
t "no heading exits 1" "1" "$(rc_of "$d")"
d="$tmp/nofile"; mkdir -p "$d"
t "no ROADMAP.md exits 1" "1" "$(rc_of "$d")"
t "usage exits 2" "2" "$(rc_of "$d" --bogus)"
t "duplicate ID exits 1" "1" "$(rc_of "$(mk dup '| R1 | a | i | s | — | planned | — |' '| R1 | b | i | s | — | planned | — |')")"


# --check: an explicit row may be built only when it is ready, names a spec,
# and that spec is on disk and still owed work; every reason is named
d="$(mk chk \
  '| R1 | a | i | s | — | done | — |' \
  '| R2 | b | i | s | — | planned | — |' \
  '| R3 | c | i | s | R1, R2 | planned | `specs/003-c/` |' \
  '| R4 | d | i | s | R1 | planned | `specs/004-d/` |' \
  '| R5 | e | i | s | R1 | planned | — |' \
  '| R6 | f | i | s | — | blocked: vendor reply | `specs/006-f/` |' \
  '| R7 | g | i | s | R1 | in-progress | `specs/007-g/` |' \
  '| R8 | h | i | s | R1 | planned | `specs/008-h/` |')"
mkdir -p "$d/specs/003-c" "$d/specs/004-d" "$d/specs/006-f" "$d/specs/007-g"
for n in 003-c 004-d 006-f 007-g; do echo "# spec" >"$d/specs/$n/spec.md"; done
printf -- '---\nspec: 007-g\nspec-status: complete\n---\n' >"$d/specs/007-g/report.md"
t "--check a ready row prints its Sub-spec" "specs/004-d" "$(bash "$SUT" "$d" --check r4 2>/dev/null)"
t "--check a ready row exits 0" "0" "$(rc_of "$d" --check R4)"
t "--check names the unmet dependency" "roadmap: R3 not ready: depends on R2, which is \`planned\`" "$(errs "$d" --check R3)"
t "--check a blocked row exits 1" "1" "$(rc_of "$d" --check R6)"
t "--check a blocked row says why" "roadmap: R6 not ready: its Status is \`blocked: vendor reply\`" "$(errs "$d" --check R6)"
t "--check a done row says why" "roadmap: R1 not ready: its Status is \`done\`
roadmap: R1 not ready: no spec yet (Sub-spec is —) — run /project" "$(errs "$d" --check R1)"
t "--check a row with no spec" "roadmap: R5 not ready: no spec yet (Sub-spec is —) — run /project" "$(errs "$d" --check R5)"
t "--check a spec already complete" "roadmap: R7 not ready: its spec specs/007-g is already complete — /close flips the row to done" "$(errs "$d" --check R7)"
t "--check a Sub-spec not on disk" "roadmap: R8 not ready: its Sub-spec specs/008-h is not on disk — run /project" "$(errs "$d" --check R8)"
t "--check a missing row exits 1" "1" "$(rc_of "$d" --check R99)"
t "--check with no ID is usage" "2" "$(rc_of "$d" --check)"

# Writers lock the project: a live holder makes --set wait, then give up
# without writing; a dead holder's lock is taken over; the mode survives
d="$(mk lock '| R1 | a | i | s | — | planned | — |' '| R2 | b | i | s | — | planned | — |')"
chmod 640 "$d/ROADMAP.md"
sleep 30 & live=$!
ln -s "$live" "$d/.roadmap.lock"
cp "$d/ROADMAP.md" "$tmp/lock.before"
t "--set waits out a live lock, then exits 1" "1" "$(ROADMAP_LOCK_WAIT=1 rc_of "$d" --set R1 "done")"
t "…having written nothing" "" "$(diff "$tmp/lock.before" "$d/ROADMAP.md")"
case "$(ROADMAP_LOCK_WAIT=1 errs "$d" --sync-next)" in *"another session is writing this project"*) t "--sync-next honours the lock too" ok ok ;; *) t "--sync-next honours the lock too" "lock message" "none" ;; esac
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
t "a dead holder's lock is taken over" "0" "$(ROADMAP_LOCK_WAIT=5 rc_of "$d" --set R1 "done")"
t "…and released after" "no" "$([[ -L "$d/.roadmap.lock" ]] && echo yes || echo no)"
# shellcheck disable=SC2012  # ls -l is the portable way to read a mode (stat differs GNU/BSD)
t "…and the file mode is kept" "-rw-r-----" "$(ls -l "$d/ROADMAP.md" | cut -c1-10)"
t "…and no temp file is left" "" "$(find "$d" -name 'ROADMAP.md.*')"

# Many writers at once: every row's update survives
rows=(); for i in $(seq 1 12); do rows+=("| R$i | f$i | i | s | — | planned | — |"); done
d="$(mk par "${rows[@]}")"
for i in $(seq 1 12); do bash "$SUT" "$d" --set "R$i" in-progress & done; wait
t "parallel --set loses no row" "12" "$(grep -c '| in-progress |' "$d/ROADMAP.md")"

echo "roadmap.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
