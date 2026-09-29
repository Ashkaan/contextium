#!/usr/bin/env bash
# Rows for check-standards-refs.sh: a citation that names a bullet passes, one
# that names nothing fails with its file and line, the retired rule-id form
# fails, history folders only count, and --cached reads the staged copies.
# Fixtures are throwaway git repos. The citation strings are assembled at run
# time so this file does not itself cite anything.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-standards-refs.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
A='→'
CITE="AGENTS.md § Standards $A"
RETIRED="@""rule:"

pass=0
fail=0
check() {
  if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1 — expected rc=$3, got rc=$2" >&2; fi
}
has() {
  if [[ "$2" == *"$3"* ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1 — output lacks '$3':" >&2; printf '%s\n' "$2" | sed 's/^/    /' >&2; fi
}

n=0
newrepo() {
  n=$((n + 1))
  REPO="$TMP/r$n"
  mkdir -p "$REPO/$1"
  git -C "$REPO" init -q
  cat >"$REPO/$1/AGENTS.md" <<EOF
# AGENTS.md

<!-- contextium:standards -->
## Standards

- **Read before asserting.** A claim needs a reading.
- **Fix the cause.** Not the symptom.
- **A gate you can't pass is not a bug.** Ask.
- **Data is fetched, judgment is prompted.** A name with a comma.
- **A decision that would be expensive to reverse gets a record** in the narrowest folder.
<!-- /contextium -->

## Ours

- **Deploy on Fridays.** Our own standard, outside the block.
EOF
  git -C "$REPO" add "$1/AGENTS.md"
}
run() { OUT="$(cd "$REPO" && bash "$SCRIPT" "$@" 2>&1)"; RC=$?; }
add() { mkdir -p "$(dirname "$REPO/$1")"; printf '%s\n' "$2" >"$REPO/$1"; git -C "$REPO" add "$1"; }

# ── citations that resolve ───────────────────────────────────────────────
newrepo .agents
add skills/a.md "See \`$CITE Read before asserting\`, and $CITE Fix the cause."
add skills/b.sh "# per $CITE a gate you can't pass is not a bug (case does not matter)"
add skills/c.md "User bullets count: $CITE Deploy on Fridays."
add skills/d.md "The form is \`$CITE <name>\` — a placeholder is not a citation."
add skills/f.md "$CITE Data is fetched, judgment is prompted — and $CITE A decision that would be expensive to reverse gets a record."
run
check "citations that name bullets" "$RC" 0
has "…and it says how many it read (the placeholder is not one)" "$OUT" "OK — 6 citation(s) checked"

# ── one that names nothing ───────────────────────────────────────────────
add skills/e.md "line one
see $CITE Read before guessing."
run
check "a citation naming no bullet" "$RC" 1
has "…names file, line and the name" "$OUT" "skills/e.md:2: cites 'Read before guessing', which is no bullet in AGENTS.md § Standards"
add skills/g.md "$CITE Fix the causes of things"
run
has "a name must end at a word boundary" "$OUT" "skills/g.md:1: cites 'Fix the causes of things'"

# ── the retired form ─────────────────────────────────────────────────────
newrepo .agents
add skills/x.md "per ${RETIRED}no-deferral"
run
check "a retired rule-id citation" "$RC" 1
has "…says what to write instead" "$OUT" "skills/x.md:1: ${RETIRED}no-deferral is retired"

# ── history is counted, not blocking ─────────────────────────────────────
newrepo .agents
add journal/2026-01-10/0930-x.md "old: ${RETIRED}gone and $CITE Gone standard"
add projects/web/2026-01-10_x/README.md "$CITE Also gone"
run
check "stale citations in journal/ and projects/" "$RC" 0
has "…are reported as information" "$OUT" "3 stale citation(s) in journal/ and projects/"

# ── the layer's source layout ────────────────────────────────────────────
newrepo templates/agents
add skills/a.md "$CITE Fix the cause"
run
check "templates/agents/AGENTS.md is read in the repo that authors the layer" "$RC" 0

# ── duplicate names ──────────────────────────────────────────────────────
newrepo .agents
printf -- '- **Fix the cause.** Twice.\n' >>"$REPO/.agents/AGENTS.md"
run
check "two bullets with one name" "$RC" 1
has "…is a violation" "$OUT" "two bullets named 'fix the cause'"

# ── --cached reads what is staged ────────────────────────────────────────
newrepo .agents
add skills/a.md "$CITE Made up"
printf '%s\n' "$CITE Fix the cause" >"$REPO/skills/a.md"
run --cached
check "a bad staged citation behind a fixed working copy" "$RC" 1
run
check "…while the working copy alone passes" "$RC" 0
git -C "$REPO" add .agents/AGENTS.md
sed 's/Fix the cause/Fix the root/' "$REPO/.agents/AGENTS.md" >"$REPO/x" && mv "$REPO/x" "$REPO/.agents/AGENTS.md"
printf '%s\n' "$CITE Fix the cause" >"$REPO/skills/a.md"
git -C "$REPO" add skills/a.md
run --cached
check "the staged AGENTS.md is the one read" "$RC" 0

# ── no AGENTS.md at all ──────────────────────────────────────────────────
REPO="$TMP/none"
mkdir -p "$REPO"
git -C "$REPO" init -q
run
check "a repo without the layer" "$RC" 0

run --bogus
check "an unknown option" "$RC" 2

# ── git cannot answer ────────────────────────────────────────────────────
# A grep or an index git cannot read is an error, never "no citations".
newrepo .agents
add skills/a.md "see $CITE Read before guessing."
echo garbage >"$REPO/.git/index"
run
check "an unreadable index fails the scan instead of passing it" "$RC" 2
run --cached
check "…and so under --cached" "$RC" 2
newrepo .agents
add skills/a.md "see $CITE Read before asserting."
run ':(bogus)skills'
check "a git grep that fails (a pathspec it rejects) is an error, not zero citations" "$RC" 2

echo "check-standards-refs.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
