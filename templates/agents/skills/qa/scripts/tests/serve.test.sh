#!/usr/bin/env bash
# shellcheck disable=SC2016  # stub bodies and fixtures are single-quoted on purpose: they expand when the stub runs, not here
# serve.test.sh — pin serve.sh up/down offline on a `static` fixture with stub
# `ss`, `curl` and `python3` on PATH: the runfile's contents and the server
# command that WOULD have run (argv + cwd recorded by the stub), the default
# port and the hop off a busy one, --port, --mode after's detached worktree and
# its removal on down, the cli/render refusal (2), an undetectable repo (3), a
# failed build (4), a server that never answers (5), a foreign listener (5),
# and --mode live's runfile derived from a pre-seeded Cloudflare registry cache
# with no `op` and no network. serve-guards.test.sh keeps the pure arg-error
# rows. The script is run as a subprocess, never sourced.
#
# peers: ../serve.sh, ./serve-guards.test.sh

# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/serve.sh"
TMP="$(mktemp -d -t serve-test-XXXXXX)" || exit 1
# serve.sh hardcodes /tmp/qa-shots and /tmp/qa-worktrees; the slug carries a
# cksum of this fixture's absolute path, so its run dirs are ours to remove.
cleanup() {
  [[ -n "${RUNFILE:-}" && -f "$RUNFILE" ]] && bash "$SCRIPT" down --runfile "$RUNFILE" >/dev/null 2>&1
  rm -rf /tmp/qa-shots/site-*"$(printf '%s' "$TMP/site" | cksum | cut -d' ' -f1)"* \
         /tmp/qa-shots/astro-*"$(printf '%s' "$TMP/astro" | cksum | cut -d' ' -f1)"* \
         /tmp/qa-worktrees/site-*"$(printf '%s' "$TMP/site" | cksum | cut -d' ' -f1)"* \
         "$TMP"
}
trap cleanup EXIT

pass=0; fail=0; rc=0; out=""; RUNFILE=""
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
run() { rc=0; out="$("$@" 2>&1)" || rc=$?; }
rf() { sed -n "s/^$1=//p" "$RUNFILE" | tr -d '"'; } # runfile value
runfile_of() { sed -n 's/^QA_RUNFILE="\(.*\)"$/\1/p' <<<"$out"; }
down() { run bash "$SCRIPT" down --runfile "$RUNFILE"; RUNFILE=""; }

# ── stubs ──
BIN="$TMP/bin"; mkdir -p "$BIN"
# ss: nothing listens, unless STUB_BUSY names ports (":8813 :8814") or "all";
# a busy port is held by pid 1 — never this run's process group.
cat > "$BIN/ss" <<'SH'
#!/usr/bin/env bash
all="$*"; port="${all##*sport = :}"
busy="${STUB_BUSY:-}"
if [[ "$busy" == "all" || " $busy " == *" :$port "* ]]; then
  echo "LISTEN 0 4096 *:$port *:* users:((\"other\",pid=1,fd=3))"
fi
SH
# curl: the health probe answers unless STUB_DOWN is set
printf '#!/usr/bin/env bash\n[[ -z "${STUB_DOWN:-}" ]]\n' > "$BIN/curl"
# python3: the static server — record argv + cwd, then stay up (or die at once)
cat > "$BIN/python3" <<'SH'
#!/usr/bin/env bash
printf '%s\ncwd=%s\n' "$*" "$PWD" > "$STUB_SERVER_LOG"
[[ -n "${STUB_DIE:-}" ]] && exit 1
exec sleep 120
SH
# npm: the astro build fails loudly
printf '#!/usr/bin/env bash\necho "build: boom"; exit 1\n' > "$BIN/npm"
# op: never reachable offline
printf '#!/usr/bin/env bash\nexit 1\n' > "$BIN/op"
chmod +x "$BIN"/*
export PATH="$BIN:$PATH" STUB_SERVER_LOG="$TMP/server.log"

# ── fixtures ──
# a static site: dist/ to serve, src/pages/ for discover-routes, committed
SITE="$TMP/site"; mkdir -p "$SITE/dist" "$SITE/src/pages"
echo '<h1>hi</h1>' > "$SITE/dist/index.html"
: > "$SITE/src/pages/index.astro"; : > "$SITE/src/pages/about.astro"
git -C "$SITE" init -q && git -C "$SITE" add -A && git -C "$SITE" -c user.email=t@t -c user.name=t commit -q -m init
# a cli target, an undetectable one, an astro one whose build fails
CLI="$TMP/cli"; mkdir -p "$CLI"; printf '{"scripts":{"qa:cmd":"node ."}}' > "$CLI/package.json"
NONE="$TMP/none"; mkdir -p "$NONE"
ASTRO="$TMP/astro"; mkdir -p "$ASTRO"; printf '{"dependencies":{"astro":"5"}}' > "$ASTRO/package.json"

# ── refusals before any server ──
run bash "$SCRIPT" up --repo "$CLI" --mode before --run-id t
[[ "$rc" == 2 && "$out" == *"cli target has no server"* ]] && ok "cli target → 2" || no "cli" "rc=$rc $out"
run bash "$SCRIPT" up --repo "$NONE" --mode before --run-id t
[[ "$rc" == 3 && "$out" == *"unknown app type"* ]] && ok "undetectable repo → 3 with detect-app's reason" || no "undetectable" "rc=$rc $out"
run bash "$SCRIPT" up --repo "$ASTRO" --mode before --run-id t
[[ "$rc" == 4 && "$out" == *"build failed"* && "$out" == *"build: boom"* ]] && ok "failed build → 4 with the log tail" || no "build" "rc=$rc $out"
[[ ! -s "$STUB_SERVER_LOG" ]] && ok "no server started on those paths" || no "server started" "$(cat "$STUB_SERVER_LOG")"

# ── up --mode before on the static site ──
run bash "$SCRIPT" up --repo "$SITE" --mode before --run-id r1
RUNFILE="$(runfile_of)"
[[ "$rc" == 0 && -f "$RUNFILE" ]] && ok "static before → 0, runfile written" || no "static up" "rc=$rc $out"
[[ "$RUNFILE" == /tmp/qa-shots/site-*/r1/server.run ]] && ok "runfile under /tmp/qa-shots/<slug>/<run-id>/" || no "runfile path" "$RUNFILE"
[[ "$(rf QA_URL)" == "http://localhost:8813" && "$(rf QA_PORT)" == 8813 ]] && ok "default port 8813" || no "port" "$(cat "$RUNFILE")"
[[ "$(rf QA_LABEL)" == "working tree" && "$(rf QA_WORKTREE)" == "" && "$(rf QA_SOURCE_REPO)" == "$SITE" ]] && ok "before: working tree, no worktree" || no "label" "$(cat "$RUNFILE")"
[[ "$(rf QA_PAGES)" == '/\ /about\ ' ]] && ok "QA_PAGES from discover-routes, %q-quoted" || no "pages" "$(rf QA_PAGES)"
[[ "$(sed -n 1p "$STUB_SERVER_LOG")" == "-m http.server 8813" ]] && ok "server command: python3 -m http.server 8813" || no "server argv" "$(cat "$STUB_SERVER_LOG")"
[[ "$(sed -n 2p "$STUB_SERVER_LOG")" == "cwd=$SITE/dist" ]] && ok "served from dist/" || no "server cwd" "$(cat "$STUB_SERVER_LOG")"
[[ "$out" == *"starting static server on :8813"* ]] && ok "progress line names type and port" || no "progress" "$out"
pid="$(rf QA_PID)"
kill -0 "$pid" 2>/dev/null && ok "QA_PID is the live server" || no "pid" "$pid"
[[ "$(rf QA_LOGFILE)" == "$(dirname "$RUNFILE")/server.log" && -f "$(rf QA_LOGFILE)" ]] && ok "server.log beside the runfile" || no "logfile" "$(rf QA_LOGFILE)"

# ── down ──
down
[[ "$rc" == 0 && "$out" == *"torn down (pid=$pid, worktree=none)"* ]] && ok "down → 0, reports pid" || no "down" "rc=$rc $out"
kill -0 "$pid" 2>/dev/null && no "server killed" "pid $pid alive" || ok "server killed"

# ── --port and the hop off a busy default ──
run bash "$SCRIPT" up --repo "$SITE" --mode before --run-id r2 --port 9123
RUNFILE="$(runfile_of)"
[[ "$rc" == 0 && "$(rf QA_PORT)" == 9123 && "$(sed -n 1p "$STUB_SERVER_LOG")" == "-m http.server 9123" ]] && ok "--port 9123 used" || no "--port" "rc=$rc $out"
down
run env STUB_BUSY=":8813 :8814" bash "$SCRIPT" up --repo "$SITE" --mode before --run-id r3
RUNFILE="$(runfile_of)"
[[ "$rc" == 0 && "$(rf QA_PORT)" == 8815 && "$out" == *":8813 is busy — serving on :8815 instead"* ]] && ok "busy 8813/8814 → 8815" || no "hop" "rc=$rc $out"
down

# ── a server that never answers → 5 ──
run env STUB_DOWN=1 STUB_DIE=1 bash "$SCRIPT" up --repo "$SITE" --mode before --run-id r4
[[ "$rc" == 5 && "$out" == *"did not come up on :8813"* && "$out" == *"server never came up"* ]] && ok "dead server → 5" || no "dead" "rc=$rc $out"

# ── a foreign listener answers the probe → refused, 5 ──
run env STUB_BUSY=all bash "$SCRIPT" up --repo "$SITE" --mode before --run-id r5
[[ "$rc" == 5 && "$out" == *"no free port in 8813-8853"* && "$out" == *"NOT this run's process group"* && "$out" == *"pass --port <free-port>"* ]] \
  && ok "foreign listener → refused, 5" || no "foreign" "rc=$rc $out"
pgrep -f 'sleep 120' >/dev/null && no "foreign attempt cleaned up" "stub server still running" || ok "foreign attempt's server killed"

# ── --mode after: a detached worktree of HEAD, removed on down ──
run bash "$SCRIPT" up --repo "$SITE" --mode after --run-id r6
RUNFILE="$(runfile_of)"
wt="$(rf QA_WORKTREE)"
[[ "$rc" == 0 && "$wt" == /tmp/qa-worktrees/site-*-r6 && -d "$wt/dist" ]] && ok "after → worktree at /tmp/qa-worktrees/<slug>-<run-id>" || no "after" "rc=$rc $out"
[[ "$(rf QA_LABEL)" == "HEAD worktree" && "$(sed -n 2p "$STUB_SERVER_LOG")" == "cwd=$wt/dist" ]] && ok "served from the worktree's dist/" || no "after cwd" "$(cat "$STUB_SERVER_LOG")"
git -C "$SITE" worktree list | grep -q "$wt" && ok "worktree registered on the source repo" || no "worktree list" "$(git -C "$SITE" worktree list)"
down
[[ "$rc" == 0 && ! -d "$wt" && "$out" == *"worktree=$wt"* ]] && ok "down removes the worktree" || no "worktree removed" "rc=$rc $out $(ls "$wt" 2>&1)"

# ── --mode live from a seeded registry cache: no server, no op, no network ──
# The registry is asked with wrangler's own credentials; fake ones here, and the
# freshly seeded cache means nothing is refreshed.
export QA_CF_PAGES_CACHE="$TMP/pages.json" QA_CF_WORKERS_DOMAINS_CACHE="$TMP/workers.json"
export CLOUDFLARE_API_TOKEN=test-token CLOUDFLARE_ACCOUNT_ID=test-account
cat > "$QA_CF_PAGES_CACHE" <<'JSON'
{"success":true,"result":[{"name":"site","domains":["site.pages.dev","www.example.com"],"source":{"config":{"repo_name":"site"}}}]}
JSON
# The Access service-token item is opt-in: QA_ACCESS_OP_ITEM names it.
run env QA_ACCESS_OP_ITEM="<access-item>" bash "$SCRIPT" up --repo "$SITE" --mode live --run-id r7
RUNFILE="$(runfile_of)"
[[ "$rc" == 0 && "$(rf QA_URL)" == "https://www.example.com" && "$(rf QA_PID)" == "" ]] && ok "live: URL from the Pages registry, no pid" || no "live pages" "rc=$rc $out"
[[ "$(rf QA_AUTH_OP_ITEM)" == "<access-item>" && "$(rf QA_AUTH_ID_FIELD)" == client_id ]] && ok "live: the named Access item in the runfile" || no "live auth" "$(cat "$RUNFILE")"
[[ ! -s "$STUB_SERVER_LOG" || "$(sed -n 1p "$STUB_SERVER_LOG")" != *r7* ]] && ok "live starts no server" || no "live server" "$(cat "$STUB_SERVER_LOG")"
! grep -q QA_AUTH_ACT_AS "$RUNFILE" && ok "no PROBE_ACTS_AS → no act-as line" || no "act-as" "$(cat "$RUNFILE")"
RUNFILE=""
# the Workers registry, via the repo's wrangler.toml, with PROBE_ACTS_AS
printf '{"success":true,"result":[]}' > "$QA_CF_PAGES_CACHE"
cat > "$QA_CF_WORKERS_DOMAINS_CACHE" <<'JSON'
{"success":true,"result":[{"hostname":"portal.example.com","service":"site-worker","environment":"production"}]}
JSON
printf 'name = "site-worker"\n[vars]\nPROBE_ACTS_AS = "cli_abc Probe@Example.com"\n' > "$SITE/wrangler.toml"
run bash "$SCRIPT" up --repo "$SITE" --mode live --run-id r8
RUNFILE="$(runfile_of)"
[[ "$(rf QA_AUTH_OP_ITEM)" == "" ]] && ok "live: no QA_ACCESS_OP_ITEM → no Access item" || no "access item" "$(cat "$RUNFILE")"
[[ "$rc" == 0 && "$(rf QA_URL)" == "https://portal.example.com" ]] && ok "live: URL from the Workers registry via wrangler name" || no "live workers" "rc=$rc $out"
[[ "$(rf QA_AUTH_ACT_AS)" == "probe@example.com" ]] && ok "live: PROBE_ACTS_AS email, lower-cased" || no "act-as" "$(cat "$RUNFILE")"
RUNFILE=""

echo
echo "serve.sh: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
