#!/usr/bin/env bash
# shellcheck disable=SC2016  # stub bodies and fixtures are single-quoted on purpose: they expand when the stub runs, not here
# screenshot.test.sh — pin screenshot.sh's gates offline against a fake
# `playwright` package: usage exits (2), no usable Playwright (7), the happy
# path's PNGs + manifest.json + motion burst (0), identical shots across routes
# (6), an off-origin landing (7), a 4xx/5xx route (9) with /404 allowed its own
# code, a blank capture (8) and QA_INK_FLOOR=0 lifting it, --no-motion, and the
# CF-Access + act-as headers a stub `op` resolves. The fake records every
# context and navigation, so what the real browser WOULD have been asked is
# asserted. The script is run as a subprocess, never sourced.
#
# peers: ../screenshot.sh

# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/screenshot.sh"
TMP="$(mktemp -d -t screenshot-test-XXXXXX)" || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; rc=0; out=""
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
run() { rc=0; out="$("$@" 2>&1)" || rc=$?; }

# ── a Playwright the resolver accepts: browsers.json + INSTALLATION_COMPLETE ──
# lib.sh's resolver tries a hardcoded machine path first; pointing
# PLAYWRIGHT_BROWSERS_PATH at an empty cache that holds only revision 9999
# makes every real install fail the marker test and only this fake pass it.
NM="$TMP/node_modules"
mkdir -p "$NM/playwright-core" "$NM/playwright" "$TMP/browsers/chromium-9999"
printf '{"browsers":[{"name":"chromium","revision":"9999"}]}' > "$NM/playwright-core/browsers.json"
: > "$TMP/browsers/chromium-9999/INSTALLATION_COMPLETE"
printf '{"name":"playwright","type":"module","main":"index.js"}' > "$NM/playwright/package.json"
cat > "$NM/playwright/index.js" <<'JS'
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const log = (s) => appendFileSync(process.env.FAKE_LOG, s + "\n");
const statusMap = JSON.parse(process.env.FAKE_STATUS || "{}");
const landedMap = JSON.parse(process.env.FAKE_LANDED || "{}");
class Page {
  constructor() { this.route = "/"; this.current = ""; }
  async goto(url) {
    this.route = new URL(url).pathname;
    this.current = landedMap[this.route] ? landedMap[this.route] + this.route : url;
    log(`goto ${url}`);
    if (process.env.FAKE_THROW && this.route === process.env.FAKE_THROW) throw new Error("boom");
    const status = statusMap[this.route] ?? 200;
    return { status: () => status };
  }
  url() { return this.current; }
  // getAnimations / rewind pass no argument; inkFraction passes the base64 image.
  async evaluate(fn, arg) {
    if (arg !== undefined) return Number(process.env.FAKE_INK ?? "0.3");
    return [];
  }
  async screenshot(opts) {
    mkdirSync(dirname(opts.path), { recursive: true });
    const body = process.env.FAKE_SAME ? "same-bytes" : `shot ${this.route} ${opts.path}`;
    writeFileSync(opts.path, body);
    log(`shot ${opts.path} fullPage=${!!opts.fullPage} animations=${opts.animations} masks=${(opts.mask || []).join(",")}`);
  }
  async waitForTimeout() {}
  locator(sel) { return sel; }
}
class Ctx {
  constructor(o) { log(`context ${JSON.stringify(o)}`); }
  async newPage() { return new Page(); }
  async close() {}
}
export const chromium = {
  async launch() { log("launch"); return { async newContext(o) { return new Ctx(o); }, async close() { log("close"); } }; },
};
JS

# ── stubs: npm (root -g → the fake node_modules), op (1Password) ──
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/npm" <<'SH'
#!/usr/bin/env bash
[[ "$*" == "root -g" ]] || exit 1
[[ -n "${STUB_NO_PW:-}" ]] || printf '%s\n' "$FAKE_NM"
SH
cat > "$BIN/op" <<'SH'
#!/usr/bin/env bash
[[ "${STUB_OP:-}" == "ok" ]] || exit 1
case "$*" in
  *"item list"*) echo '[{"id":"item1","title":"probe","vault":{"id":"v1"}}]' ;;
  *"--fields client_id"*) echo "ID-1" ;;
  *"--fields client_secret"*) echo "SECRET-1" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$BIN/npm" "$BIN/op"
export PATH="$BIN:$PATH" HOME="$TMP/home" FAKE_NM="$NM" FAKE_LOG="$TMP/fake.log"
export PLAYWRIGHT_BROWSERS_PATH="$TMP/browsers" QA_SHOTS_ROOT="$TMP/shots"
mkdir -p "$HOME"
BASE=(--url http://localhost:8813 --repo-slug app-1 --run-id r1)
OUT="$QA_SHOTS_ROOT/app-1/r1"
reset() { : > "$FAKE_LOG"; rm -rf "$QA_SHOTS_ROOT"; }

# ── usage ──
run bash "$SCRIPT"
[[ "$rc" == 2 && "$out" == *"usage: screenshot.sh"* ]] && ok "no args → 2" || no "no args" "rc=$rc $out"
run bash "$SCRIPT" --url http://x --repo-slug s
[[ "$rc" == 2 && "$out" == *"usage:"* ]] && ok "missing --run-id → 2" || no "missing run-id" "rc=$rc $out"
run bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --bogus
[[ "$rc" == 2 && "$out" == *"unknown flag: --bogus"* ]] && ok "unknown flag → 2" || no "unknown flag" "rc=$rc $out"
run env STUB_OP=fail bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --auth-op-item item1
[[ "$rc" == 2 && "$out" == *"service token unresolved from 1Password item item1"* ]] && ok "auth unresolved → 2" || no "auth unresolved" "rc=$rc $out"
[[ ! -e "$QA_SHOTS_ROOT" ]] && ok "usage exits create no run dir" || no "run dir" "$(ls -R "$QA_SHOTS_ROOT")"

# ── no Playwright, and installing one forbidden → 7, said plainly ──
# (Playwright installs on first use; QA_NO_INSTALL=1 keeps this test offline.)
reset
run env STUB_NO_PW=1 QA_NO_INSTALL=1 bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"}
[[ "$rc" == 7 && "$out" == *"qa: skipped — Playwright unavailable"* ]] && ok "no playwright → 7" || no "no playwright" "rc=$rc $out"
[[ ! -s "$FAKE_LOG" ]] && ok "no browser launched" || no "launched" "$(cat "$FAKE_LOG")"

# ── happy path ──
reset
run bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/ /about" --viewports "1440,390" --masks ".clock,.ad"
[[ "$rc" == 0 && "$out" == *"qa: shots + manifest → $OUT"* ]] && ok "happy path → 0, names the run dir" || no "happy rc" "rc=$rc $out"
for f in index-1440.png index-390.png about-1440.png about-390.png; do
  [[ -f "$OUT/$f" ]] && ok "wrote $f" || no "missing $f" "$(ls "$OUT" 2>&1)"
done
[[ -f "$OUT/manifest.json" ]] && ok "manifest.json written" || no "manifest" "$(ls "$OUT")"
rows="$(jq -r 'length' "$OUT/manifest.json")"
[[ "$rows" == 4 ]] && ok "manifest has 4 rows (2 routes × 2 widths)" || no "manifest rows" "$rows"
jq -e '.[] | select(.route=="/about" and .width==390 and .status==200 and .ink==0.3 and (.sha|length)==16 and .bytes>0 and .landedOrigin=="http://localhost:8813")' \
  "$OUT/manifest.json" >/dev/null && ok "manifest row: route · width · status · sha · ink · bytes · origin" || no "manifest row" "$(cat "$OUT/manifest.json")"
[[ "$out" == *"/about"*"390"*"$OUT/about-390.png"*"200"* ]] && ok "stdout table row for /about @390" || no "table" "$out"
grep -q '^goto http://localhost:8813/about$' "$FAKE_LOG" && ok "route joined onto base" || no "goto" "$(grep goto "$FAKE_LOG")"
grep -q '"viewport":{"width":390,"height":1600},"deviceScaleFactor":1,"reducedMotion":"no-preference"' "$FAKE_LOG" \
  && ok "context: width, scale 1, motion NOT reduced" || no "context" "$(grep context "$FAKE_LOG" | head -1)"
grep -q "shot $OUT/index-1440.png fullPage=true animations=disabled masks=.clock,.ad" "$FAKE_LOG" \
  && ok "settled still: fullPage, animations disabled, masks applied" || no "still" "$(grep 'shot .*index-1440.png ' "$FAKE_LOG")"
[[ -f "$OUT/motion/manifest.json" && "$(find "$OUT/motion" -maxdepth 1 -name '*.png' | wc -l | tr -d ' ')" == 16 ]] && ok "motion: manifest + 4-frame burst per route × width" \
  || no "motion" "$(ls -R "$OUT/motion" 2>&1)"
grep -q "shot $OUT/motion/index-1440-t0000.png fullPage=false animations=allow" "$FAKE_LOG" && ok "burst frames allow animations" || no "burst" "$(grep t0000 "$FAKE_LOG")"
[[ "$out" == *"motion: 0/4 route×viewport captures declared animations; 4 showed frame-to-frame change"* ]] && ok "motion summary line" || no "motion summary" "$out"
! grep -q extraHTTPHeaders "$FAKE_LOG" && ok "no auth → no headers" || no "headers" "$(grep context "$FAKE_LOG" | head -1)"

# --no-motion, --reduced-motion, default pages + viewports
reset
run bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --no-motion --reduced-motion
[[ "$rc" == 0 && ! -e "$OUT/motion" ]] && ok "--no-motion → no motion dir" || no "no-motion" "rc=$rc $(ls "$OUT")"
[[ "$(jq -r 'map(.width)|join(",")' "$OUT/manifest.json")" == "1440,820,390" && "$(jq -r '.[0].route' "$OUT/manifest.json")" == "/" ]] \
  && ok "defaults: / at 1440,820,390" || no "defaults" "$(cat "$OUT/manifest.json")"
grep -q '"reducedMotion":"reduce"' "$FAKE_LOG" && ok "--reduced-motion → reduce" || no "reduced" "$(grep context "$FAKE_LOG" | head -1)"

# ── gate: identical shots across routes → 6 ──
reset
run env FAKE_SAME=1 bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/ /about" --viewports 1440 --no-motion
[[ "$rc" == 6 && "$out" == *"IDENTICAL SHOTS"* && "$out" == *"1440px: /, /about rendered byte-identical"* ]] && ok "identical shots → 6" || no "collision" "rc=$rc $out"
run env FAKE_SAME=1 bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/" --viewports 1440,390 --no-motion
[[ "$rc" == 0 ]] && ok "one route, identical across widths is not a collision" || no "single route" "rc=$rc $out"

# ── gate: off-origin landing → 7 (wins over collisions) ──
reset
run env FAKE_LANDED='{"/login":"https://auth.example.com"}' FAKE_SAME=1 bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/ /login" --viewports 1440 --no-motion
[[ "$rc" == 7 && "$out" == *"REDIRECTED OFF-ORIGIN"* && "$out" == *"/login landed on https://auth.example.com"* && "$out" == *"Expected origin: http://localhost:8813"* ]] \
  && ok "off-origin → 7, reported before the collision" || no "off-origin" "rc=$rc $out"

# ── gate: unsuccessful response → 9; /404 may answer 404; no response is -1 ──
reset
run env FAKE_STATUS='{"/admin":403,"/404":404}' bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/ /admin /404" --viewports 1440 --no-motion
[[ "$rc" == 9 && "$out" == *"UNSUCCESSFUL RESPONSES"* && "$out" == *"/admin @1440: HTTP 403"* && "$out" != *"/404 @1440"* && "$out" == *"--auth-act-as"* ]] \
  && ok "403 → 9 with the act-as hint; /404 answering 404 is allowed" || no "status gate" "rc=$rc $out"
run env FAKE_THROW=/ bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/" --viewports 1440 --no-motion
[[ "$rc" == 9 && "$out" == *"/ @1440: HTTP no response"* ]] && ok "navigation error → status -1 → 9" || no "no response" "rc=$rc $out"

# ── gate: blank capture → 8; QA_INK_FLOOR=0 lifts it ──
reset
run env FAKE_INK=0 bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/" --viewports 1440 --no-motion
[[ "$rc" == 8 && "$out" == *"BLANK CAPTURES"* && "$out" == *"/ @1440  0.0% non-background"* && "$out" == *"Floor is 0.020%"* ]] \
  && ok "ink 0 → 8 at the 0.02% floor" || no "blank" "rc=$rc $out"
run env FAKE_INK=0 QA_INK_FLOOR=0 bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/" --viewports 1440 --no-motion
[[ "$rc" == 0 ]] && ok "QA_INK_FLOOR=0 accepts the blank" || no "floor override" "rc=$rc $out"

# ── auth: token pair from op + act-as, sent as headers, absent from argv ──
reset
run env STUB_OP=ok bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/" --viewports 1440 --no-motion --auth-op-item item1 --auth-act-as a@b.co
[[ "$rc" == 0 ]] && ok "auth run → 0" || no "auth run" "rc=$rc $out"
grep -q '"extraHTTPHeaders":{"CF-Access-Client-Id":"ID-1","CF-Access-Client-Secret":"SECRET-1","X-Portal-Act-As":"a@b.co"}' "$FAKE_LOG" \
  && ok "CF-Access pair + act-as as extraHTTPHeaders" || no "auth headers" "$(grep context "$FAKE_LOG")"
reset
run bash "$SCRIPT" ${BASE[@]+"${BASE[@]}"} --pages "/" --viewports 1440 --no-motion --auth-act-as a@b.co
! grep -q 'X-Portal-Act-As' "$FAKE_LOG" && ok "act-as without a token is not sent" || no "act-as alone" "$(grep context "$FAKE_LOG")"

echo
echo "screenshot.sh: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
