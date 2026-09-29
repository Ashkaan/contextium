#!/usr/bin/env bash
# sight-check-playwright.test.sh — the stamp without ImageMagick. On a PATH that
# holds no `magick`, `sight-check.sh stamp` must draw the codes with Playwright,
# and a reply carrying them must verify. Skips when no Playwright with its
# browser is already on the machine; a test never downloads one.
#
# Run: bash .agents/skills/qa/scripts/tests/sight-check-playwright.test.sh
#
# peers:
#   .agents/skills/qa/scripts/sight-check.sh
#   .agents/skills/qa/scripts/lib.sh

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SC="$DIR/sight-check.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}

export QA_NO_INSTALL=1
# shellcheck source=../lib.sh
if ! NM="$(bash -c 'source "$0"; qa_playwright_node_modules' "$DIR/lib.sh" 2>/dev/null)"; then
  echo "sight-check-playwright.test.sh: SKIP — no Playwright with an installed chromium"
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/sight-pw-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# A PATH with every tool the stamp uses, and no magick.
mkdir -p "$TMP/bin"
for tool in bash node npm find sort basename dirname cksum tr mkdir awk grep sed cat rm mv mktemp head tail wc; do
  p="$(command -v "$tool" 2>/dev/null)" && ln -s "$p" "$TMP/bin/$tool"
done
[[ ! -e "$TMP/bin/magick" ]] || { echo "FAIL: magick leaked into the test PATH"; exit 1; }

# Two real PNGs of different sizes, drawn by the same Playwright.
mkdir -p "$TMP/run"
(cd "$(dirname "$NM")" && node --input-type=module -e '
import { chromium } from "playwright";
const [out] = process.argv.slice(1);
const b = await chromium.launch();
for (const [name, w, h] of [["home-1440.png", 1440, 600], ["home-390.png", 390, 844]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent("<body style=\"margin:0;background:#fff\"><h1>Home</h1></body>");
  await p.screenshot({ path: out + "/" + name });
  await p.close();
}
await b.close();
' "$TMP/run") || { echo "FAIL: could not draw the fixture PNGs"; exit 1; }

pngdim() { node -e 'const b=require("fs").readFileSync(process.argv[1]);process.stdout.write(b.readUInt32BE(16)+"x"+b.readUInt32BE(20))' "$1"; }
before_1440="$(pngdim "$TMP/run/home-1440.png")"

out="$(PATH="$TMP/bin" bash "$SC" stamp --dir "$TMP/run" --codes "$TMP/codes" 2>"$TMP/err")"; rc=$?
t "stamp without magick exits 0" "0" "$rc"
t "it says which stamper ran" "1" "$(grep -c 'no ImageMagick — stamping with Playwright' "$TMP/err")"
t "it reports the codes file" "QA_SIGHT_CODES=$TMP/codes" "$(grep '^QA_SIGHT_CODES=' <<<"$out")"
t "one code per shot" "2" "$(grep -cE $'^home-[0-9]+\\.png\t[A-Z0-9]{6}$' "$TMP/codes")"
t "the strip is appended below: same width, 56px taller" "1440x656" "$(pngdim "$TMP/run/home-1440.png")"
t "the page itself is unchanged in width" "1440x600" "$before_1440"
t "the phone shot keeps its width" "390x900" "$(pngdim "$TMP/run/home-390.png")"
t "the codes are not in the run dir" "0" "$(grep -rlF "$(cut -f2 "$TMP/codes" | head -1)" "$TMP/run" 2>/dev/null | wc -l | tr -d ' ')"

awk -F'\t' '{ print $1 " = " $2 }' "$TMP/codes" >"$TMP/reply"
t "a reply carrying the codes verifies" "0" "$(PATH="$TMP/bin" bash "$SC" verify --codes "$TMP/codes" --response "$TMP/reply" >/dev/null 2>&1; echo $?)"
echo "the page looks fine" >"$TMP/blind"
t "a reply without them is a blind review" "6" "$(PATH="$TMP/bin" bash "$SC" verify --codes "$TMP/codes" --response "$TMP/blind" >/dev/null 2>&1; echo $?)"

# Neither stamper: still a halt, and it names both.
rc=0; err="$(PATH="$TMP/bin" QA_PLAYWRIGHT_DIR="$TMP/none" HOME="$TMP" \
  bash "$SC" stamp --dir "$TMP/run" --codes "$TMP/codes2" 2>&1 >/dev/null)" || rc=$?
t "no magick and no Playwright is exit 3" "3" "$rc"
t "and the halt names both" "1" "$(grep -c 'neither ImageMagick nor Playwright' <<<"$err")"

echo "sight-check-playwright.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
