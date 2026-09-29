#!/usr/bin/env bash
# gen-design-md.test.sh — the generator, and the stub marker it now writes.
#
# The marker is the whole point of this suite. Before it existed, `/qa` wrote a
# token inventory on a repo's first run, treated that file as the app's sole
# design authority, ran four design-system checks against it, and reported clean
# forever — on an app nobody had designed. The cases below pin the two halves of
# the fix: every generated file says it is a stub, and a hand-written file is
# never touched.
#
# Run: bash .agents/skills/qa/scripts/tests/gen-design-md.test.sh
#
# peers:
#   .agents/skills/qa/scripts/gen-design-md.ts
#   .agents/skills/qa/scripts/design-authority.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="${SCRIPT_DIR}/../gen-design-md.ts"
AUTHORITY="${SCRIPT_DIR}/../design-authority.sh"

TMP="$(mktemp -d -t gen-design-md-test-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  echo "FAIL: $*" >&2
}
check_rc() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected rc=$expect, got rc=$got"; fi
}
check_has() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then ok; else bad "$name — missing '$needle' in:"$'\n'"$hay"; fi
}
check_lacks() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then bad "$name — unexpected '$needle' in:"$'\n'"$hay"; else ok; fi
}
check_eq() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected '$expect', got '$got'"; fi
}

new_repo() {
  local dir="$TMP/$1"
  mkdir -p "$dir"
  cat >"$dir/theme.css" <<'CSS'
:root {
  --color-ink: #1b232c;
  --radius: 0.5rem;
}
body { font-family: 'Lexend Deca', system-ui, sans-serif; }
CSS
  printf '%s\n' "$dir"
}

# ── 1. A generated file declares itself a stub ────────────────────────────
REPO="$(new_repo generated)"
node "$GEN" "$REPO" >/dev/null 2>&1
check_rc "the generator writes a file" 0 $?
body="$(cat "$REPO/DESIGN.md")"
check_has "carries the marker" "design-authority: generated-stub" "$body"
check_eq "on the first line of the frontmatter" "design-authority: generated-stub" "$(sed -n 2p "$REPO/DESIGN.md")"
check_has "and says so in prose, where a human reads it" "This is a stub" "$body"
check_has "it still extracts the tokens it always did" "ink:" "$body"

# ── 2. And the authority check agrees ─────────────────────────────────────
out="$(bash "$AUTHORITY" status "$REPO" 2>&1)"
rc=$?
check_rc "a generated file is not a design authority" 3 "$rc"
check_has "for the stated reason" "AUTHORITY=stub" "$out"

# ── 3. Removing the key is the claim that it is now real ──────────────────
# Only if the body also says something. The marker is limb one of the rule; a
# body with no contract headings is limb two, and deleting the key alone does
# not get past it.
REPO2="$(new_repo promoted)"
node "$GEN" "$REPO2" >/dev/null 2>&1
grep -v 'design-authority: generated-stub' "$REPO2/DESIGN.md" >"$TMP/x" && mv "$TMP/x" "$REPO2/DESIGN.md"
out="$(bash "$AUTHORITY" status "$REPO2" 2>&1)"
check_rc "deleting the key alone is not enough" 3 $?
check_has "because the body still declares no contract" "declares no design contract" "$out"
printf '\n## Type\nA four-step ramp.\n\n## Focus\nOne ring.\n' >>"$REPO2/DESIGN.md"
out="$(bash "$AUTHORITY" status "$REPO2" 2>&1)"
check_rc "a real contract plus no marker is a real authority" 0 $?
check_has "and it says so" "AUTHORITY=real" "$out"

# ── 4. A hand-written file is never overwritten ───────────────────────────
REPO3="$(new_repo handwritten)"
cat >"$REPO3/DESIGN.md" <<'MD'
---
name: Mine
colors:
  ink: "#000000"
---

# Design System: Mine

## Type
11 / 12 / 14 / 16 / 20 / 24.
MD
before="$(cat "$REPO3/DESIGN.md")"
node "$GEN" "$REPO3" >/dev/null 2>&1
check_rc "the generator refuses an existing file" 3 $?
check_eq "and leaves it byte-identical" "$before" "$(cat "$REPO3/DESIGN.md")"

# ── 5. --mark-existing backfills OUR files, and only ours ─────────────────
# The marker did not exist when most DESIGN.md files were written, so the whole
# affected population is unmarked. This is how they get marked — identified by
# the generator's own output shape, never by a guess about thinness.
REPO4="$(new_repo backfill)"
node "$GEN" "$REPO4" >/dev/null 2>&1
grep -v 'design-authority: generated-stub' "$REPO4/DESIGN.md" >"$TMP/y" && mv "$TMP/y" "$REPO4/DESIGN.md"
out="$(node "$GEN" --mark-existing "$REPO4" 2>&1)"
check_rc "marks a file this generator wrote" 0 $?
check_has "says what it did" "marked" "$out"
check_eq "and the key is back on line 2" "design-authority: generated-stub" "$(sed -n 2p "$REPO4/DESIGN.md")"

out="$(node "$GEN" --mark-existing "$REPO4" 2>&1)"
check_rc "marking twice is a no-op, not a second key" 3 $?
check_eq "still exactly one marker" 1 "$(grep -c 'design-authority: generated-stub' "$REPO4/DESIGN.md")"

before="$(cat "$REPO3/DESIGN.md")"
out="$(node "$GEN" --mark-existing "$REPO3" 2>&1)"
check_rc "refuses a hand-written file" 3 $?
check_has "and says why" "not written by this generator" "$out"
check_eq "leaving it byte-identical" "$before" "$(cat "$REPO3/DESIGN.md")"

# ── 5b. Sizes are emitted in the published DESIGN.md typography shape ─────
# google-labs-code/design.md allows only named entries carrying fontSize etc.
# under `typography`; a `scale:` map is flagged and ignored by its linter.
REPO6="$TMP/sized"
mkdir -p "$REPO6"
cat >"$REPO6/theme.css" <<'CSS'
:root {
  --color-ink: #1b232c;
  --text-sm: 14px;
  --text-lg: 20px;
}
CSS
node "$GEN" "$REPO6" >/dev/null 2>&1
body6="$(cat "$REPO6/DESIGN.md")"
check_lacks "no scale map under typography" "  scale:" "$body6"
check_has "each size is a named typography entry" "  text-sm:" "$body6"
check_has "carrying its fontSize" '    fontSize: "14px"' "$body6"
fm="$(node "${SCRIPT_DIR}/../design-frontmatter.mjs" "$REPO6")"
check_has "and the drift reader still arms the type ramp from it" "TYPE_SCALE=14px|20px" "$fm"

# ── 6. No tokens at all is still a distinct outcome ───────────────────────
REPO5="$TMP/empty"
mkdir -p "$REPO5"
node "$GEN" "$REPO5" >/dev/null 2>&1
check_rc "a repo with no tokens writes nothing" 4 $?
check_eq "and leaves no file behind" "" "$(ls "$REPO5")"

echo
echo "gen-design-md.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
