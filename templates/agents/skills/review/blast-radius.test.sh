#!/usr/bin/env bash
# blast-radius.test.sh — the packer, against hermetic temp repos.
#
# Every case builds its own git repo in a temp dir, so nothing here depends on
# this checkout, a model, auth or a network. Run: bash blast-radius.test.sh
#
# The cases that need the REAL TypeScript parser (re-export statements, which
# the regex fallback cannot see) run when a `typescript` package is found —
# under BLAST_RADIUS_TEST_PARSER_ROOT, or Node's global node_modules — and are
# reported as skipped otherwise.
#
# `set -uo pipefail` without `-e`: the suite drives expected non-zero exits and
# counts failures itself.
#
# peers:
#   .agents/skills/review/blast-radius.sh
#   .agents/skills/review/blast-radius-symbols.mjs

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACK="${SCRIPT_DIR}/blast-radius.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/blast-radius-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# In-place edit that works with GNU and BSD sed alike.
ed_() { sed -i.bak "$1" "$2" && rm -f "$2.bak"; }

PARSER_ROOT="${BLAST_RADIUS_TEST_PARSER_ROOT:-}"
if [[ -z "$PARSER_ROOT" ]] && command -v node >/dev/null 2>&1; then
  PARSER_ROOT="$(cd "$(dirname "$(command -v node)")/../lib/node_modules" 2>/dev/null && pwd || true)"
fi
HAVE_TS=0
if [[ -n "$PARSER_ROOT" && -f "$PARSER_ROOT/typescript/package.json" ]]; then
  HAVE_TS=1
  export BLAST_RADIUS_PARSER_ROOTS="$PARSER_ROOT"
else
  export BLAST_RADIUS_PARSER_ROOTS=""
  echo "SKIP: no typescript package found — real-parser cases not run (set BLAST_RADIUS_TEST_PARSER_ROOT)"
fi
skipped=0

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

# new_repo <name> — an initialized repo with an identity, printed on stdout.
new_repo() {
  local dir="$TMP/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q .
  git -C "$dir" config user.email t@t
  git -C "$dir" config user.name t
  git -C "$dir" config commit.gpgsign false
  printf '%s\n' "$dir"
}

echo "blast-radius.sh: the packer"

# ── 1. Nothing to pack ────────────────────────────────────────────────

R0="$(new_repo empty)"
printf 'x\n' >"$R0/seed.txt"
git -C "$R0" add seed.txt
git -C "$R0" commit -qm init

rc=0
out="$(bash "$PACK" --repo "$R0" 2>/dev/null)" || rc=$?
check_rc "0 files exits 0" 0 "$rc"
check_eq "0 files prints nothing" "" "$out"

rc=0
out="$(bash "$PACK" --repo "$R0" README.md 2>/dev/null)" || rc=$?
check_rc "a list with no packable language exits 0" 0 "$rc"
check_eq "a list with no packable language prints nothing" "" "$out"

rc=0
bash "$PACK" --repo "$TMP/not-a-repo-at-all" src/a.ts >/dev/null 2>&1 || rc=$?
check_rc "a non-repo is a caller error" 2 "$rc"

rc=0
bash "$PACK" --repo "$R0" --files-file "$TMP/no-such-list" >/dev/null 2>&1 || rc=$?
check_rc "an unreadable --files-file is a caller error" 2 "$rc"

rc=0
bash "$PACK" --repo "$R0" --diff-file "$TMP/no-such-diff" src/a.ts >/dev/null 2>&1 || rc=$?
check_rc "an unreadable --diff-file is a caller error" 2 "$rc"

# ── The main fixture repo ─────────────────────────────────────────────
#
# One exported function, one exported arrow const, one short-named export, one
# shell library, and four distinct import spellings pointed at them.

R="$(new_repo main)"
mkdir -p "$R/src" "$R/other"
cat >"$R/src/a.ts" <<'EOF'
// a comment on the first line
export function doThing() {
  return 1
}
export const arrowThing = () => {
  return 2
}
export const id = 7
EOF
cat >"$R/src/named-import.ts" <<'EOF'
import { doThing } from './a'
export function useNamed() {
  return doThing()
}
EOF
cat >"$R/src/reexport.ts" <<'EOF'
export { arrowThing } from './a'
EOF
cat >"$R/other/js-specifier.ts" <<'EOF'
import { doThing } from '../src/a.js'
export const viaJs = doThing
EOF
cat >"$R/other/aliased.ts" <<'EOF'
import { doThing } from '@app/a'
export const viaAlias = doThing
EOF
cat >"$R/lib.sh" <<'EOF'
#!/usr/bin/env bash
helper_fn() {
  echo hi
}
EOF
cat >"$R/user.sh" <<'EOF'
#!/usr/bin/env bash
source ./lib.sh
helper_fn
EOF
git -C "$R" add src other lib.sh user.sh
git -C "$R" commit -qm init

pack() { bash "$PACK" --repo "$R" "$@" 2>/dev/null; }

# ── 2 + 3. A body-line change names the enclosing symbol ──────────────

ed_ 's/^  return 1$/  return 11/' "$R/src/a.ts"
git -C "$R" diff >"$TMP/fn-body.diff"
out="$(pack --diff-file "$TMP/fn-body.diff" src/a.ts)"
check_has "a function body change names the function" "doThing — callers:" "$out"
check_has "the function's caller is listed" "src/named-import.ts" "$out"
check_lacks "an untouched sibling symbol is not named" "arrowThing — callers" "$out"
git -C "$R" checkout -q -- src/a.ts

# `export const foo = () => {` is the shape a regex walk-up gets wrong: it sees
# `const`, not a function, and names the previous declaration instead.
ed_ 's/^  return 2$/  return 22/' "$R/src/a.ts"
git -C "$R" diff >"$TMP/arrow-body.diff"
out="$(pack --diff-file "$TMP/arrow-body.diff" src/a.ts)"
check_has "an export-const-arrow body change names the const" "arrowThing — callers:" "$out"
check_lacks "and does not name the function above it" "doThing — callers" "$out"
git -C "$R" checkout -q -- src/a.ts

# ── 4. A comment-only diff has no symbols, but still has a graph ──────

ed_ 's|^// a comment on the first line$|// a comment on the first line, reworded|' "$R/src/a.ts"
git -C "$R" diff >"$TMP/comment.diff"
out="$(pack --diff-file "$TMP/comment.diff" src/a.ts)"
check_lacks "a comment-only diff names no symbols" "changed symbols:" "$out"
check_has "a comment-only diff still prints the import graph" "imported-by:" "$out"
git -C "$R" checkout -q -- src/a.ts

# ── 5. Identifiers under 4 characters are never symbols ───────────────

out="$(pack src/a.ts)"
check_has "with no diff every export is a changed symbol" "doThing" "$out"
check_has "with no diff the arrow const is one too" "arrowThing" "$out"
check_lacks "a 2-character identifier is skipped" "    id —" "$out"

# ── 7 + 8. The import graph ───────────────────────────────────────────

check_has "a bare relative import is an importer" "src/named-import.ts" "$out"
check_has "an export-from is an importer" "src/reexport.ts" "$out"
check_has "a .js specifier matches the .ts source" "other/js-specifier.ts" "$out"
imported_by_block="$(sed -n '/^  imported-by:/,/^  [a-z]/p' <<<"$out")"
check_lacks "a tsconfig alias is NOT resolved as an importer" "other/aliased.ts" "$imported_by_block"
check_has "the alias file is still found by the caller grep" "other/aliased.ts" "$out"

sh_out="$(pack lib.sh)"
check_has "a sourced shell library names its sourcer" "user.sh" "$sh_out"
check_has "a shell function's callers are listed" "helper_fn — callers:" "$sh_out"

# A journal entry that quotes a symbol or a `source` line is prose about the
# change, not a caller of it.
mkdir -p "$R/journal/2026-01-01"
cat >"$R/journal/2026-01-01/0900-x.md" <<'EOF'
Renamed doThing() and re-read `source ./lib.sh` in user.sh; helper_fn stays.
EOF
git -C "$R" add journal
git -C "$R" commit -qm journal
out="$(pack --diff-file "$TMP/fn-body.diff" src/a.ts)"
check_has "the code caller is still listed beside the journal" "src/named-import.ts" "$out"
check_lacks "a journal entry naming the symbol is not a caller" "journal/2026-01-01/0900-x.md" "$out"
sh_out="$(pack lib.sh)"
check_lacks "a journal entry quoting a source line is not an importer" "journal/2026-01-01/0900-x.md" "$sh_out"
check_has "and the real sourcer is still listed" "user.sh" "$sh_out"

# imports-of runs the same resolution in the other direction, and excludes the
# files the reviewer is already being shown.
imp_out="$(pack src/named-import.ts)"
check_has "a file's own imports are listed" "imports (not in this change):" "$imp_out"
check_has "and name the resolved target" "src/a.ts" "$imp_out"
both_out="$(pack src/named-import.ts src/a.ts)"
check_lacks "an import already in the change list is omitted" "imports (not in this change):" "$both_out"

# ── 7. A deleted file in the list is skipped, the rest are packed ─────

rm "$R/src/reexport.ts"
out="$(pack src/reexport.ts src/a.ts)"
check_eq "a deleted file gets no section" "0" "$(grep -cx 'src/reexport\.ts' <<<"$out")"
check_has "its live neighbour is still packed" "src/a.ts" "$out"
rc=0
bash "$PACK" --repo "$R" src/reexport.ts >/dev/null 2>&1 || rc=$?
check_rc "a list of only deleted files exits 0" 0 "$rc"
check_eq "and prints nothing" "" "$(pack src/reexport.ts)"
git -C "$R" checkout -q -- src/reexport.ts

# ── 9. Uncommitted and untracked files are packed ─────────────────────

cat >>"$R/src/a.ts" <<'EOF'
export function uncommittedFn() {
  return 3
}
EOF
cat >"$R/src/untracked-caller.ts" <<'EOF'
import { uncommittedFn } from './a'
export const viaUntracked = uncommittedFn
EOF
out="$(pack src/a.ts)"
check_has "an uncommitted export is packed" "uncommittedFn" "$out"
check_has "an untracked caller is found" "src/untracked-caller.ts" "$out"

rc=0
out="$(bash "$PACK" --repo "$R" src/untracked-caller.ts 2>/dev/null)" || rc=$?
check_rc "an untracked file can itself be packed" 0 "$rc"
check_has "and its import resolves" "src/a.ts" "$out"

git -C "$R" checkout -q -- src/a.ts
rm -f "$R/src/untracked-caller.ts"

# A gitignored file is not in the population — it is not in the diff either, so
# citing it would point the reviewer at bytes it was never shown.
printf 'build/\n' >"$R/.gitignore"
mkdir -p "$R/build"
cat >"$R/build/generated.ts" <<'EOF'
import { doThing } from '../src/a'
export const built = doThing
EOF
out="$(pack src/a.ts)"
check_lacks "a gitignored file is not in the search population" "build/generated.ts" "$out"
rm -rf "$R/build" "$R/.gitignore"

# ── 14. A deletion-only hunk of an export still lists callers ─────────

D="$(new_repo deletion)"
mkdir -p "$D/src"
cat >"$D/src/api.ts" <<'EOF'
export function survivor() {
  return 1
}
export function departed() {
  return 2
}
EOF
cat >"$D/src/consumer.ts" <<'EOF'
import { survivor, departed } from './api'
export const both = [survivor, departed]
EOF
git -C "$D" add src
git -C "$D" commit -qm init

# The whole export goes; the hunk has `-` lines and no `+` lines at all, so the
# new side has nothing to point at. The old-side parse is the only way its
# callers reach the reviewer.
awk '/^export function departed\(\) \{$/ {skip = 3} skip > 0 {skip--; next} {print}' "$D/src/api.ts" >"$TMP/api.new" && mv "$TMP/api.new" "$D/src/api.ts"
git -C "$D" diff >"$TMP/deleted-export.diff"
out="$(bash "$PACK" --repo "$D" --diff-file "$TMP/deleted-export.diff" src/api.ts 2>/dev/null)"
check_has "a deleted export is named from the old side" "departed — callers:" "$out"
check_has "and its caller is listed" "src/consumer.ts" "$out"
check_lacks "the surviving sibling is not named" "survivor — callers" "$out"
git -C "$D" checkout -q -- src/api.ts

# A deletion-only hunk INSIDE a surviving export names that export.
awk '/^export function survivor\(\) \{$/ {print; getline; next} {print}' "$D/src/api.ts" >"$TMP/api.new" && mv "$TMP/api.new" "$D/src/api.ts"
git -C "$D" diff >"$TMP/body-deletion.diff"
out="$(bash "$PACK" --repo "$D" --diff-file "$TMP/body-deletion.diff" src/api.ts 2>/dev/null)"
check_has "a deletion inside a body names the enclosing export" "survivor — callers:" "$out"
git -C "$D" checkout -q -- src/api.ts

# ── 14. Parser present vs. parser absent ──────────────────────────────
#
# BLAST_RADIUS_PARSER_ROOTS="" removes every root the symbol parser looks under,
# so the import genuinely fails to resolve and the REAL fallback path runs —
# not a flag that simulates one.

ed_ 's/^  return 2$/  return 22/' "$R/src/a.ts"
git -C "$R" diff >"$TMP/arrow-body.diff"

with_parser="$(BLAST_RADIUS_PARSER_ROOTS="" bash "$PACK" --repo "$R" --diff-file "$TMP/arrow-body.diff" src/a.ts 2>"$TMP/fallback.err")"
check_has "a missing parser WARNs on stderr" "falling back to regex" "$(cat "$TMP/fallback.err")"
check_has "…and says how to install the parser" "npm i -g typescript web-tree-sitter tree-sitter-bash" "$(cat "$TMP/fallback.err")"
check_has "…and where it looked" "looked in:" "$(cat "$TMP/fallback.err")"
check_has "a missing parser still prints the import graph" "imported-by:" "$with_parser"
check_has "and still names the file" "src/a.ts" "$with_parser"

# The distinction the real parser buys: the regex walk-up cannot tell that
# `export const arrowThing = () =>` owns line 6.
if [[ "$HAVE_TS" -eq 1 ]]; then
  real="$(pack --diff-file "$TMP/arrow-body.diff" src/a.ts 2>&1)"
  check_has "the real parser names the arrow const" "arrowThing — callers:" "$real"
  check_lacks "and loads without a fallback warning" "falling back to regex" "$real"
else
  skipped=$((skipped + 2))
fi
git -C "$R" checkout -q -- src/a.ts

# ── An `export { ... }` statement carries no export MODIFIER ──────────
#
# A barrel file is nothing but these, so a parser that only looks for the
# `export` keyword as a modifier finds no symbols in one at all and its
# consumers never reach the reviewer. Needs the real parser.

if [[ "$HAVE_TS" -eq 1 ]]; then
B="$(new_repo barrel)"
mkdir -p "$B/src"
cat >"$B/src/impl.ts" <<'EOF'
export function realWork() {
  return 1
}
export function otherWork() {
  return 2
}
EOF
cat >"$B/src/index.ts" <<'EOF'
export { realWork } from './impl'
export { otherWork as renamedWork } from './impl'
EOF
cat >"$B/src/uses-barrel.ts" <<'EOF'
import { realWork, renamedWork } from './index'
export const total = realWork() + renamedWork()
EOF
git -C "$B" add src
git -C "$B" commit -qm init

out="$(bash "$PACK" --repo "$B" src/index.ts 2>/dev/null)"
check_has "a re-export names the exported symbol" "realWork" "$out"
check_has "and finds its consumer" "src/uses-barrel.ts" "$out"
# The name that travels is the one a CALLER writes, which is the alias.
check_has "an aliased re-export names the ALIAS" "renamedWork" "$out"
check_lacks "not the local name behind it" "    otherWork " "$out"

# A local export list, with no `from` clause.
cat >"$B/src/local-list.ts" <<'EOF'
function helperThing() {
  return 3
}
export { helperThing }
EOF
cat >"$B/src/uses-local.ts" <<'EOF'
import { helperThing } from './local-list'
export const v = helperThing()
EOF
out="$(bash "$PACK" --repo "$B" src/local-list.ts 2>/dev/null)"
check_has "a local export list names the symbol" "helperThing" "$out"
check_has "and finds its consumer" "src/uses-local.ts" "$out"

# A DELETED re-export, and a multiline export whose `from` clause moves: symbols
# are ranged on the statement, not the specifier.

cat >"$B/src/deletable.ts" <<'EOF'
export { realWork } from './impl'
export { otherWork } from './impl'
EOF
cat >"$B/src/uses-deletable.ts" <<'EOF'
import { otherWork } from './deletable'
export const d = otherWork()
EOF
git -C "$B" add src
git -C "$B" commit -qm barrel-two

grep -v "otherWork" "$B/src/deletable.ts" >"$TMP/deletable.new"
mv "$TMP/deletable.new" "$B/src/deletable.ts"
git -C "$B" diff >"$TMP/deleted-reexport.diff"
out="$(bash "$PACK" --repo "$B" --diff-file "$TMP/deleted-reexport.diff" src/deletable.ts 2>/dev/null)"
check_has "a DELETED re-export is still named" "otherWork — callers:" "$out"
check_has "and its consumer is listed" "src/uses-deletable.ts" "$out"
git -C "$B" checkout -q -- src/deletable.ts

cat >"$B/src/multiline.ts" <<'EOF'
export {
  realWork,
  otherWork,
} from './impl'
EOF
cat >"$B/src/uses-multiline.ts" <<'EOF'
import { realWork } from './multiline'
export const m = realWork()
EOF
git -C "$B" add src
git -C "$B" commit -qm barrel-multiline

# Only the `from` clause moves — a line that sits inside NO specifier.
cp "$B/src/impl.ts" "$B/src/impl-moved.ts"
ed_ "s|} from './impl'|} from './impl-moved'|" "$B/src/multiline.ts"
git -C "$B" diff >"$TMP/from-clause.diff"
out="$(bash "$PACK" --repo "$B" --diff-file "$TMP/from-clause.diff" src/multiline.ts 2>/dev/null)"
check_has "a moved from-clause names the re-exported symbol" "realWork — callers:" "$out"
check_has "and its consumer is listed" "src/uses-multiline.ts" "$out"
git -C "$B" checkout -q -- src/multiline.ts
rm -f "$B/src/impl-moved.ts"

else
  skipped=$((skipped + 10))
fi

# ── 6. Caps ───────────────────────────────────────────────────────────

C="$(new_repo caps)"
mkdir -p "$C/src"
{
  for i in $(seq 1 40); do
    printf 'export function widget%02d() {\n  return %d\n}\n' "$i" "$i"
  done
} >"$C/src/many.ts"
{
  for i in $(seq 1 12); do
    printf 'import { widget01 } from "../src/many"\nexport const c%02d = widget01\n' "$i" >"$C/src/caller$i.ts"
  done
}
git -C "$C" add src
git -C "$C" commit -qm init

out="$(bash "$PACK" --repo "$C" src/many.ts 2>/dev/null)"
check_has "over the symbol cap prints truncated-symbols" "truncated-symbols: 8" "$out"
check_has "over the caller cap prints truncated-callers" "truncated-callers:" "$out"
listed="$(grep -cE '^    widget[0-9]+ ' <<<"$out")"
check_eq "exactly the symbol cap is listed" "32" "$listed"
worst="$(grep -A 20 '^    widget01 ' <<<"$out" | grep -cE '^      src/caller')"
check_eq "exactly the caller cap is listed for one symbol" "8" "$worst"

out="$(BLAST_RADIUS_MAX_BYTES=900 bash "$PACK" --repo "$C" src/many.ts 2>/dev/null)"
check_has "over the byte cap prints truncated-bytes" "truncated-bytes:" "$out"
bytes="$(printf '%s' "$out" | wc -c)"
if [[ "$bytes" -le 1000 ]]; then ok; else bad "the byte cap is enforced — got $bytes bytes"; fi

# ── --files-file is the same list as the arguments ────────────────────

printf 'src/a.ts\n\nsrc/a.ts\n' >"$TMP/list.txt"
out="$(bash "$PACK" --repo "$R" --files-file "$TMP/list.txt" 2>/dev/null)"
check_eq "a repeated path is packed once" "1" "$(grep -c '^src/a\.ts$' <<<"$out")"
check_has "--files-file packs what it lists" "doThing" "$out"

# ── Portability: `..` resolution without GNU realpath, and no node ─────

E="$(new_repo escape)"
mkdir -p "$E/deep"
printf 'export function rootThing() {\n  return 1\n}\n' >"$E/root.ts"
printf "import { rootThing } from '../../root'\nexport const escaped = 1\n" >"$E/deep/escape.ts"
printf "import { rootThing } from '../root'\nexport const inside = rootThing\n" >"$E/deep/inside.ts"
imp="$(bash "$PACK" --repo "$E" root.ts 2>/dev/null | sed -n '/^  imported-by:/,/^  [a-z]/p')"
check_has "a specifier inside the repo resolves" "deep/inside.ts" "$imp"
check_lacks "a specifier climbing out of the repo does not" "deep/escape.ts" "$imp"

nonode="$TMP/nonode"; mkdir -p "$nonode"
for b in bash env git cat sed grep awk sort uniq head tr wc mktemp rm mkdir dirname basename paste cut; do
  f="$(command -v "$b" 2>/dev/null || true)"
  case "$f" in /*) ln -s "$f" "$nonode/$b" ;; esac
done
rc=0
out="$(PATH="$nonode" bash "$PACK" --repo "$E" root.ts 2>"$TMP/nonode.err")" || rc=$?
check_rc "no node installed still exits 0" 0 "$rc"
check_has "…and still packs the import graph" "deep/inside.ts" "$out"

# ── A git grep that FAILS is said, not read as "no callers" ──────────────
# The packer fails open by design, so it still exits 0 — but a pack built on a
# failed search must say so on stderr, or "no callers found" reads as a fact.
fakegit="$TMP/fakegit"; mkdir -p "$fakegit"
realgit="$(command -v git)"
cat >"$fakegit/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "\${FAKE_GIT_FAIL:-}" ]; then echo "fatal: simulated \$a failure" >&2; exit 128; fi
done
exec "$realgit" "\$@"
EOF
chmod +x "$fakegit/git"
rc=0
PATH="$fakegit:$PATH" FAKE_GIT_FAIL=grep bash "$PACK" --repo "$R" src/a.ts lib.sh >/dev/null 2>"$TMP/grepfail.err" || rc=$?
check_rc "a failed git grep still fails open (exit 0)" 0 "$rc"
check_has "…and says the search failed" "git grep failed" "$(cat "$TMP/grepfail.err")"

echo "blast-radius: $pass passed, $fail failed, $skipped skipped"
[[ "$fail" -eq 0 ]]
