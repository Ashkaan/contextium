#!/usr/bin/env bash
# blast-radius-symbols.test.sh — the symbol packer, against fixture files.
#
# Pins the line protocol blast-radius.sh drives: a FILE/LANG/NEWFILE/NEWLINES/
# OLDFILE/REMOVEDFILE request on stdin, a PARSER/SYMBOL/WARN response on stdout.
# Fixture TypeScript and bash files go in as temp-file paths, exactly as the
# shell caller passes them; the assertions are the symbol lists that come out.
# The typescript and tree-sitter cases need a node_modules holding
# `typescript`, `web-tree-sitter` and `tree-sitter-bash`: BLAST_RADIUS_TEST_ROOTS
# names one, else npm's global root is used; with neither, the suite stops and
# says which packages to install rather than reporting the regex fallback as a
# failure. The regex fallback runs with BLAST_RADIUS_PARSER_ROOTS="". The script
# is run as a subprocess with `node`, the way blast-radius.sh runs it — never
# imported.
#
# Run: bash .agents/skills/review/blast-radius-symbols.test.sh
#
# `set -uo pipefail` without `-e`, matching every other test script in this dir.
#
# peers:
#   .agents/skills/review/blast-radius-symbols.mjs
#   .agents/skills/review/blast-radius.test.sh   (the packer end to end)
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/blast-radius-symbols.mjs"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d)" || exit 1; trap 'rm -rf "$tmp"' EXIT

# The first of: BLAST_RADIUS_TEST_ROOTS, this repo's node_modules, npm's global
# root — whichever holds all three packages.
PARSER_ROOT=""
for cand in "${BLAST_RADIUS_TEST_ROOTS:-}" "$(git -C "$(dirname "$SUT")" rev-parse --show-toplevel 2>/dev/null)/node_modules" "$(npm root -g 2>/dev/null)"; do
  [[ -n "$cand" && -d "$cand/typescript" && -d "$cand/web-tree-sitter" && -d "$cand/tree-sitter-bash" ]] || continue
  PARSER_ROOT="$cand"; break
done
if [[ -z "$PARSER_ROOT" ]]; then
  echo "blast-radius-symbols.test.sh: no node_modules with typescript, web-tree-sitter and tree-sitter-bash —"
  echo "  npm i -g typescript@5 web-tree-sitter tree-sitter-bash, or set BLAST_RADIUS_TEST_ROOTS to one"
  exit 1
fi
export BLAST_RADIUS_PARSER_ROOTS="$PARSER_ROOT"
run() { node "$SUT" >"$tmp/out" 2>"$tmp/err"; echo $?; }
symbols() { grep '^SYMBOL ' "$tmp/out" | awk '{print $3}' | paste -sd' '; }
parser() { grep "^PARSER $1 " "$tmp/out" | awk '{print $3}'; }
warns() { grep -c '^WARN ' "$tmp/out"; }

cat >"$tmp/a.ts" <<'TS'
export const doThing = () => {
  return 1;
};
export function helper(x: number) {
  return x + 1;
}
export class Widget {
  render() {
    return "w";
  }
}
export interface Shape { a: number }
export type Tiny = 1;
export const ab = 2;
const hidden = 3;
export { hidden as revealed };
function local() {}
TS
cat >"$tmp/a.sh" <<'SH'
#!/usr/bin/env bash
greet() {
  echo hi
}
function farewell {
  echo bye
}
SH
printf 'export function gone(a: string) {\n  return a.trim();\n}\nexport function kept() {}\n' >"$tmp/old.ts"
printf '  return a.trim();\n}\n' >"$tmp/removed.txt"

# ── every symbol (NEWLINES all), real typescript parser ──────────────────
rc="$(printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES all\n' "$tmp/a.ts" | run)"
t "a well-formed request exits 0" 0 "$rc"
t "the typescript package is found under the machine's parser roots" typescript "$(parser src/a.ts)"
t "NEWLINES all names every exported symbol, sorted, methods included, non-exports and names under 4 chars (ab) dropped" \
  "Shape Tiny Widget doThing helper render revealed" "$(symbols)"
t "stderr is silent on success" "" "$(cat "$tmp/err")"

# ── changed lines select the enclosing declaration ───────────────────────
printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES 8\n' "$tmp/a.ts" | run >/dev/null
t "a line inside a method names the method AND its class" "Widget render" "$(symbols)"
printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES 2\n' "$tmp/a.ts" | run >/dev/null
t "a line inside an arrow-function const names the const (the regex walk-up's failure)" "doThing" "$(symbols)"
printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES 2,5,12\n' "$tmp/a.ts" | run >/dev/null
t "several lines union their symbols" "Shape doThing helper" "$(symbols)"
printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES 15\n' "$tmp/a.ts" | run >/dev/null
t "a line in a non-exported declaration names nothing" "" "$(symbols)"
printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES 16\n' "$tmp/a.ts" | run >/dev/null
t "a re-export names the EXPORTED alias, the token a caller writes" "revealed" "$(symbols)"
printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES x,,7\n' "$tmp/a.ts" | run >/dev/null
t "non-numeric NEWLINES entries are dropped, the numeric one still counts" "Widget" "$(symbols)"
printf 'FILE src/a.ts\nNEWFILE %s\nNEWLINES 4\n' "$tmp/a.ts" | run >/dev/null
t "LANG defaults to ts" "typescript" "$(parser src/a.ts)"

# ── the old side: a removed line located by TEXT names the deleted export ─
rc="$(printf 'FILE src/o.ts\nLANG ts\nOLDFILE %s\nREMOVEDFILE %s\n' "$tmp/old.ts" "$tmp/removed.txt" | run)"
t "old-side request exits 0" 0 "$rc"
t "a removed line inside a deleted function names it; the bare '}' line names nothing" "gone" "$(symbols)"
printf 'FILE src/o.ts\nLANG ts\nOLDFILE %s\n' "$tmp/old.ts" | run >/dev/null
t "OLDFILE without REMOVEDFILE names nothing" "" "$(symbols)"

# ── bash, through tree-sitter ────────────────────────────────────────────
printf 'FILE bin/a.sh\nLANG sh\nNEWFILE %s\nNEWLINES 3\n' "$tmp/a.sh" | run >/dev/null
t "bash parses with tree-sitter-bash" tree-sitter-bash "$(parser bin/a.sh)"
t "a line inside a bash function names that function only" "greet" "$(symbols)"
printf 'FILE bin/a.sh\nLANG sh\nNEWFILE %s\nNEWLINES all\n' "$tmp/a.sh" | run >/dev/null
t "both bash function forms are collected" "farewell greet" "$(symbols)"

# ── the regex fallback, when no parser root holds the package ────────────
rc="$(printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES all\n' "$tmp/a.ts" | BLAST_RADIUS_PARSER_ROOTS="" run)"
t "no parser roots still exits 0" 0 "$rc"
t "the response says regex" regex "$(parser src/a.ts)"
t "the fallback misses the method and the re-export, as the header warns" "Shape Tiny Widget doThing helper" "$(symbols)"
t "the fallback is announced" yes "$(grep -q '^WARN the typescript package did not load — falling back to regex' "$tmp/out" && echo yes)"
printf 'FILE bin/a.sh\nLANG sh\nNEWFILE %s\nNEWLINES all\n' "$tmp/a.sh" | BLAST_RADIUS_PARSER_ROOTS="" run >/dev/null
t "bash falls back to regex too" "regex farewell greet" "$(parser bin/a.sh) $(symbols)"
t "bash fallback names its missing parser" yes "$(grep -q '^WARN blast-radius-symbols: web-tree-sitter not found under any parser root' "$tmp/out" && echo yes)"

# ── several records, caller mistakes reported as WARN not as failure ─────
rc="$(printf 'FILE src/x.ts\nLANG ts\nNEWFILE /nonexistent/x.ts\nBOGUS 1\n\nFILE src/y.ts\nNEWFILE %s\nNEWLINES 1\n' "$tmp/a.ts" | run)"
t "an unreadable bytes file and an unknown key do not fail the run" 0 "$rc"
t "every record still gets a PARSER line" "2" "$(grep -c '^PARSER ' "$tmp/out")"
t "the readable record's symbols are unaffected" "doThing" "$(symbols)"
t "the unknown key is warned by name" yes "$(grep -qF 'WARN blast-radius-symbols: unknown request key "BOGUS"' "$tmp/out" && echo yes)"
t "the unreadable file is warned by path" yes "$(grep -qF 'WARN blast-radius-symbols: could not read new bytes /nonexistent/x.ts' "$tmp/out" && echo yes)"
t "WARN lines come after every PARSER/SYMBOL line" yes "$(awk '/^WARN/{w=1} !/^WARN/ && w{bad=1} END{print bad?"no":"yes"}' "$tmp/out")"
t "a key before the first FILE is ignored" 0 "$(printf 'LANG ts\nNEWLINES all\n' | run)"

# ── an empty request is an empty response ────────────────────────────────
rc="$(run </dev/null)"
t "empty stdin exits 0" 0 "$rc"
t "empty stdin writes nothing" "" "$(cat "$tmp/out")"

# ── A typescript package without the compiler API ────────────────────────
# TypeScript 7 (the native port) ships `typescript` with no createSourceFile:
# its main export is only a version. Loaded blindly it returned no symbols at
# all and said nothing; it must fall back to the regex walk and say why.
mkdir -p "$tmp/ts7/node_modules/typescript"
printf '{"name":"typescript","version":"7.0.2","main":"index.js"}\n' >"$tmp/ts7/node_modules/typescript/package.json"
printf 'module.exports = { version: "7.0.2" };\n' >"$tmp/ts7/node_modules/typescript/index.js"
rc="$(printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES all\n' "$tmp/a.ts" | BLAST_RADIUS_PARSER_ROOTS="$tmp/ts7/node_modules" run)"
t "a typescript with no compiler API: still exit 0" 0 "$rc"
t "…falls back to the regex walk" regex "$(parser src/a.ts)"
t "…and says which typescript it could not use" 1 "$(grep -c '^WARN .*typescript 7.0.2, .*createSourceFile' "$tmp/out")"
t "…while the regex walk still finds the exported symbols" yes "$(symbols | grep -q Widget && echo yes || echo no)"
# …and a later root with a working compiler API is still used.
REAL_TS_ROOT="$PARSER_ROOT"
printf 'FILE src/a.ts\nLANG ts\nNEWFILE %s\nNEWLINES all\n' "$tmp/a.ts" | BLAST_RADIUS_PARSER_ROOTS="$tmp/ts7/node_modules:$REAL_TS_ROOT" run >/dev/null
t "an unusable typescript in an earlier root does not hide a usable one later" typescript "$(parser src/a.ts)"

echo "blast-radius-symbols.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
