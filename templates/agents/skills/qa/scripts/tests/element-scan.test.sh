#!/usr/bin/env bash
# element-scan.test.sh — pin element-scan.mjs on fixture JSX/HTML: a
# multi-line opening tag comes back flattened on one line with its start line
# number; a `>` inside an arrow-function attribute or a string does not end the
# tag; a tag named in a comment line is skipped; several tags and several files
# scan in one call. The script is run as a subprocess, never sourced.
#
# peers: ../element-scan.mjs

# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/element-scan.mjs"
TMP="$(mktemp -d -t element-scan-test-XXXXXX)" || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; rc=0; out=""
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
run() { rc=0; out="$("$@" 2>&1)" || rc=$?; }
count() { grep -c . <<<"$out" || true; }

# ── usage ──
run node "$SCRIPT"
[[ "$rc" == 2 && "$out" == *"usage:"* ]] && ok "no args → 2" || no "no args" "rc=$rc $out"
run node "$SCRIPT" input
[[ "$rc" == 2 && "$out" == *"usage:"* ]] && ok "tag but no file → 2" || no "no file" "rc=$rc $out"

# an unreadable file is skipped, not fatal
run node "$SCRIPT" input "$TMP/missing.tsx"
[[ "$rc" == 0 && -z "$out" ]] && ok "missing file → 0, no output" || no "missing file" "rc=$rc $out"

# ── the fixture: the formatted-JSX shape a line grep misses ──
cat > "$TMP/Form.tsx" <<'TSX'
// <input type="date"> is mentioned here in a comment and must not count
export function Form({ onChange }) {
  return (
    <form>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value > 3 ? ">" : "")}
        placeholder="a > b"
      />
      <select className="w-full"><option>x</option></select>
      <inputs-are-not-input />
      <textarea rows={3}>
        text
      </textarea>
    </form>
  );
}
TSX

run node "$SCRIPT" input "$TMP/Form.tsx"
[[ "$rc" == 0 ]] && ok "scan → 0" || no "scan rc" "rc=$rc $out"
[[ "$(count)" == 1 ]] && ok "one <input> found, comment and <inputs-…> skipped" || no "input count" "$out"
expected="$TMP/Form.tsx	5	<input type=\"date\" value={value} onChange={(e) => onChange(e.target.value > 3 ? \">\" : \"\")} placeholder=\"a > b\" />"
[[ "$out" == "$expected" ]] && ok "tag flattened to one line, closed past the > in braces and strings, start line 5" \
  || no "flattened tag" "$out"

# several tags in one call, in document order
run node "$SCRIPT" input,select,textarea "$TMP/Form.tsx"
[[ "$(count)" == 3 ]] && ok "three tags → three rows" || no "three tags" "$out"
[[ "$(sed -n 2p <<<"$out")" == "$TMP/Form.tsx	11	<select className=\"w-full\">" ]] && ok "<select> row stops at its own >" \
  || no "select row" "$(sed -n 2p <<<"$out")"
[[ "$(sed -n 3p <<<"$out")" == *"	13	<textarea rows={3}>" ]] && ok "<textarea> opening tag only" \
  || no "textarea row" "$(sed -n 3p <<<"$out")"

# ── plain HTML, several files, an HTML comment line ──
cat > "$TMP/page.html" <<'HTML'
<!doctype html>
<!-- <button>ignored</button> -->
<body>
  <button
    class="primary"
    disabled>Go</button>
  <button>Two</button>
</body>
HTML
run node "$SCRIPT" button "$TMP/page.html" "$TMP/Form.tsx"
[[ "$(count)" == 2 ]] && ok "html: two <button>s, comment skipped, tsx has none" || no "html buttons" "$out"
[[ "$(sed -n 1p <<<"$out")" == "$TMP/page.html	4	<button class=\"primary\" disabled>" ]] && ok "html multi-line tag flattened, line 4" \
  || no "html row 1" "$(sed -n 1p <<<"$out")"
[[ "$(sed -n 2p <<<"$out")" == "$TMP/page.html	7	<button>" ]] && ok "html second tag, line 7" || no "html row 2" "$(sed -n 2p <<<"$out")"

# a tag that never closes is not a tag
printf '<input type="date"\n%s\n' "$(head -c 4100 /dev/zero | tr '\0' 'x')" > "$TMP/open.tsx"
run node "$SCRIPT" input "$TMP/open.tsx"
[[ "$rc" == 0 && -z "$out" ]] && ok "unclosed tag past 4000 chars → nothing" || no "unclosed" "rc=$rc $out"

echo
echo "element-scan.mjs: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
