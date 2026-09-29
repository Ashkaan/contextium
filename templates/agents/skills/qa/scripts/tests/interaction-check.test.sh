#!/usr/bin/env bash
# interaction-check.test.sh — interaction-check.sh against a fixture site served
# on a free local port: it must flag a click that changes nothing, a click that
# only disables its button, and a page that renders nothing while its data
# loads, and pass the ones that answer at once.
#
# Needs a Playwright with an installed chromium (the same one screenshot.sh
# uses); without it the suite reports SKIP rather than a pass.
#
# peers:
#   .agents/skills/qa/scripts/interaction-check.sh
#   .agents/skills/qa/scripts/interaction-check.mjs

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/interaction-check.sh"
# shellcheck disable=SC1091  # sibling source
source "$SCRIPT_DIR/lib.sh"

pass=0
fail=0
ok() { echo "  ok: $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $1" >&2; fail=$((fail + 1)); }

# A test never downloads a browser: with no Playwright already on the machine
# this suite skips rather than installing one.
export QA_NO_INSTALL=1
if ! qa_playwright_node_modules >/dev/null 2>&1; then
  echo "interaction-check.test.sh: SKIP — no Playwright with an installed chromium"
  exit 0
fi

SITE="$(mktemp -d)"
mkdir -p "$SITE/good" "$SITE/silent" "$SITE/disables" "$SITE/blank" "$SITE/loading"

# Answers at the click: the label changes before any server reply.
cat >"$SITE/good/index.html" <<'HTML'
<!doctype html><html><body><h1>Good</h1>
<button id="b" onclick="this.textContent='Saving…'; fetch('/api/save',{method:'POST'})">Save</button>
</body></html>
HTML

# Sends the request and changes nothing until the server answers.
cat >"$SITE/silent/index.html" <<'HTML'
<!doctype html><html><body><h1>Silent</h1>
<button id="b" onclick="fetch('/api/save',{method:'POST'}).then(()=>{this.textContent='Saved.'})">Save</button>
</body></html>
HTML

# Greys the button out and nothing else — not feedback: a visitor reads it as broken.
cat >"$SITE/disables/index.html" <<'HTML'
<!doctype html><html><body><h1>Disables</h1>
<button id="b" onclick="this.disabled=true; fetch('/api/save',{method:'POST'})">Save</button>
</body></html>
HTML

# Renders nothing at all until its data arrives.
cat >"$SITE/blank/index.html" <<'HTML'
<!doctype html><html><body><div id="root"></div>
<script>fetch('/api/data').then(r=>r.text()).then(t=>{document.getElementById('root').textContent=t})</script>
</body></html>
HTML

# Shows a loading state while the same data is on its way.
cat >"$SITE/loading/index.html" <<'HTML'
<!doctype html><html><body><div id="root">Loading bookings…</div>
<script>fetch('/api/data').then(r=>r.text()).then(t=>{document.getElementById('root').textContent=t})</script>
</body></html>
HTML
mkdir -p "$SITE/api" && echo "data" >"$SITE/api/data"
mkdir -p "$SITE/confirm" "$SITE/theme" "$SITE/hoverattr" "$SITE/greys" "$SITE/socket" "$SITE/overlay" "$SITE/iframe" "$SITE/optout"

# A delete behind a confirm: the dialog IS the feedback (reviewer false positive).
cat >"$SITE/confirm/index.html" <<'HTML'
<!doctype html><html><body><h1>Confirm</h1>
<button onclick="if(!confirm('Delete?'))return; fetch('/api/save',{method:'POST'})">Delete</button>
</body></html>
HTML

# A theme toggle changes <html>, not <body> (reviewer false positive).
cat >"$SITE/theme/index.html" <<'HTML'
<!doctype html><html data-theme="light"><body><h1>Theme</h1>
<button onclick="document.documentElement.dataset.theme='dark'">Dark mode</button>
</body></html>
HTML

# Sets an attribute on hover and saves silently: the hover is not feedback.
cat >"$SITE/hoverattr/index.html" <<'HTML'
<!doctype html><html><body><h1>Hover</h1>
<button onpointerenter="this.setAttribute('data-hover','')" onclick="fetch('/api/save',{method:'POST'})">Save</button>
</body></html>
HTML

# Only fades the button: a class change alone is not feedback.
cat >"$SITE/greys/index.html" <<'HTML'
<!doctype html><html><head><style>.dim{opacity:.5}</style></head><body><h1>Greys</h1>
<button onclick="this.className='dim'; fetch('/api/save',{method:'POST'})">Save</button>
</body></html>
HTML

# Writes over a WebSocket, which page.route cannot see.
cat >"$SITE/socket/index.html" <<'HTML'
<!doctype html><html><body><h1>Socket</h1>
<button onclick="this.textContent='Deleting…'; const w=new WebSocket('ws://'+location.host+'/ws'); w.onopen=()=>w.send('DELETE')">Delete</button>
</body></html>
HTML

# A fixed overlay covers the only button, so it can never be pressed.
cat >"$SITE/overlay/index.html" <<'HTML'
<!doctype html><html><body><h1>Overlay</h1>
<button onclick="this.textContent='Saving…'">Save</button>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.4)">Accept cookies</div>
</body></html>
HTML

# The embedded-widget shape: a heading, and a large iframe that has not loaded.
# 192.0.2.1 is TEST-NET-1, reserved and unroutable, so the frame never arrives.
cat >"$SITE/iframe/index.html" <<'HTML'
<!doctype html><html><body><main><h1>Book a call</h1>
<iframe src="http://192.0.2.1/booking" width="800" height="600"></iframe></main>
</body></html>
HTML

# A control whose response is off screen, declared as such.
cat >"$SITE/optout/index.html" <<'HTML'
<!doctype html><html><body><h1>Opt out</h1>
<button data-qa-feedback="copies to the clipboard" onclick="navigator.clipboard?.writeText('x')">Copy</button>
</body></html>
HTML

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
SERVER_LOG="$(mktemp)"
(cd "$SITE" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>"$SERVER_LOG") &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null; rm -rf "$SITE" "$SERVER_LOG"' EXIT
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/good/" >/dev/null 2>&1 && break; sleep 0.1; done

run() { # <pages> -> sets OUT and RC
  RC=0
  OUT="$(bash "$SCRIPT" --url "http://127.0.0.1:$PORT" --pages "$1" 2>&1)" || RC=$?
}

echo "── a click that answers at once passes"
run "/good/"
if [[ "$RC" -eq 0 ]]; then ok "exit 0"; else bad "want exit 0, got $RC: $OUT"; fi

echo "── a click that changes nothing until the server answers is a finding"
run "/silent/"
if [[ "$RC" -eq 9 ]]; then ok "exit 9"; else bad "want exit 9, got $RC: $OUT"; fi
if grep -q "INTERACTION /silent/ no-feedback" <<<"$OUT"; then ok "names the route and the button"; else bad "no no-feedback line: $OUT"; fi

echo "── a click that only disables its button is a finding"
run "/disables/"
if [[ "$RC" -eq 9 ]]; then ok "exit 9"; else bad "want exit 9, got $RC: $OUT"; fi

echo "── a page that renders nothing while its data loads is a finding"
run "/blank/"
if [[ "$RC" -eq 9 ]]; then ok "exit 9"; else bad "want exit 9, got $RC: $OUT"; fi
if grep -q "INTERACTION /blank/ blank-while-loading" <<<"$OUT"; then ok "names the route"; else bad "no blank line: $OUT"; fi

echo "── a page that shows a loading state passes"
run "/loading/"
if [[ "$RC" -eq 0 ]]; then ok "exit 0"; else bad "want exit 0, got $RC: $OUT"; fi

echo "── a confirm dialog counts as feedback"
run "/confirm/"
if [[ "$RC" -eq 0 ]]; then ok "exit 0"; else bad "want exit 0, got $RC: $OUT"; fi

echo "── a theme toggle on <html> counts as feedback"
run "/theme/"
if [[ "$RC" -eq 0 ]]; then ok "exit 0"; else bad "want exit 0, got $RC: $OUT"; fi

echo "── an attribute the hover set is not feedback"
run "/hoverattr/"
if [[ "$RC" -eq 9 ]]; then ok "exit 9"; else bad "want exit 9, got $RC: $OUT"; fi

echo "── a button that only fades is not feedback"
run "/greys/"
if [[ "$RC" -eq 9 ]]; then ok "exit 9"; else bad "want exit 9, got $RC: $OUT"; fi

echo "── a button no click can reach is a finding, not a silent pass"
run "/overlay/"
if [[ "$RC" -eq 9 ]]; then ok "exit 9"; else bad "want exit 9, got $RC: $OUT"; fi
if grep -q "INTERACTION /overlay/ unpressed" <<<"$OUT"; then ok "names it unpressed"; else bad "no unpressed line: $OUT"; fi

echo "── a large iframe still loading is blank while loading"
run "/iframe/"
if [[ "$RC" -eq 9 ]]; then ok "exit 9"; else bad "want exit 9, got $RC: $OUT"; fi
if grep -q "INTERACTION /iframe/ blank-while-loading an iframe" <<<"$OUT"; then ok "names the iframe"; else bad "no iframe line: $OUT"; fi

echo "── an opted-out control is listed, not failed"
run "/optout/"
if [[ "$RC" -eq 0 ]]; then ok "exit 0"; else bad "want exit 0, got $RC: $OUT"; fi
if grep -q 'SKIPPED /optout/ "Copy" copies to the clipboard' <<<"$OUT"; then ok "lists it with its reason"; else bad "no SKIPPED line: $OUT"; fi

echo "── a route that does not load fails the run"
RC=0
OUT="$(bash "$SCRIPT" --url "http://127.0.0.1:1" --pages "/" 2>&1)" || RC=$?
if [[ "$RC" -eq 1 ]]; then ok "exit 1"; else bad "want exit 1, got $RC: $OUT"; fi

echo "── a WebSocket write never connects"
run "/socket/"
if grep -q '"GET /ws' "$SERVER_LOG"; then bad "the socket reached the server"; else ok "no socket reached the server"; fi

echo "── mark-qa-done --tree refuses a served app until the check passes on that tree"
APP="$(mktemp -d)"
git -C "$APP" init -q && git -C "$APP" config user.email t@t && git -C "$APP" config user.name t
cp "$SITE/good/index.html" "$APP/index.html"
git -C "$APP" add -A && git -C "$APP" commit -qm app
DONE="$(mktemp -d)"
TREE="$(cd "$APP" && bash "$SCRIPT_DIR/../../review/code-review.sh" --snapshot)"
RC=0; QA_DONE_DIR="$DONE" bash "$SCRIPT_DIR/mark-qa-done.sh" --tree "$TREE" "$APP" >/dev/null 2>&1 || RC=$?
if [[ "$RC" -eq 3 ]]; then ok "refused before the check"; else bad "want exit 3, got $RC"; fi
RC=0; QA_DONE_DIR="$DONE" bash "$SCRIPT" --url "http://127.0.0.1:$PORT" --pages "/good/" --repo "$APP" >/dev/null 2>&1 || RC=$?
if [[ "$RC" -eq 0 ]]; then ok "the check passed and stamped"; else bad "check exit $RC"; fi
RC=0; QA_DONE_DIR="$DONE" bash "$SCRIPT_DIR/mark-qa-done.sh" --tree "$TREE" "$APP" >/dev/null 2>&1 || RC=$?
if [[ "$RC" -eq 0 ]]; then ok "marked after the check"; else bad "want exit 0, got $RC"; fi
echo change >>"$APP/index.html"
TREE2="$(cd "$APP" && bash "$SCRIPT_DIR/../../review/code-review.sh" --snapshot)"
RC=0; QA_DONE_DIR="$DONE" bash "$SCRIPT_DIR/mark-qa-done.sh" --tree "$TREE2" "$APP" >/dev/null 2>&1 || RC=$?
if [[ "$RC" -eq 3 ]]; then ok "an edit after the check needs the check again"; else bad "want exit 3, got $RC"; fi
rm -rf "$APP" "$DONE"

echo "── no write the check holds ever reaches the server"
# http.server logs every request it receives to stderr, a POST included (it
# answers 501). The pages above POST on every click, so an unheld write shows here.
if grep -q '"POST /api/save' "$SERVER_LOG"; then
  bad "a held POST reached the server: $(grep -c '"POST' "$SERVER_LOG") time(s)"
else
  ok "no POST reached the server"
fi
if grep -q '"GET /good/' "$SERVER_LOG"; then ok "the log is being read (the page GETs are in it)"; else bad "server log is empty — the check above proves nothing"; fi

echo "interaction-check.test.sh: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
