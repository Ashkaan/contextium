#!/usr/bin/env bash
# serve-guards.test.sh — guard-path tests for serve.sh that do NOT spin a real
# server: the "--live without a live URL → refuse" row + arg-validation
# usage exits. The happy-path serve (real build + server) is manual E2E
# (too heavy to unit-test).
#
# peers: ../serve.sh

# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/serve.sh"

pass=0; fail=0
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

run() { # → "RC|combined-output"
  local rc=0 out
  out="$("$@" 2>&1)" || rc=$?
  printf '%s|%s' "$rc" "$out"
}

# --live on a detectable repo whose basename matches no CF Pages project → exit
# 6. (The positive --live path is derive-from-CF + real screenshots — E2E,
# not a hermetic guard test. The astro dep makes detect-app pass so we
# reach the derive; a mktemp basename never matches a project, so the derive
# returns nothing and serve refuses with "live URL".)
r="$(mktemp -d)"; printf '{"dependencies":{"astro":"5"}}' > "$r/package.json"
got="$(run "$SCRIPT" up --repo "$r" --mode live --run-id t1)"
[[ "${got%%|*}" == "6" && "${got#*|}" == *"live URL"* ]] \
  && ok "live, no CF match → exit 6" || no "live, no CF match" "got: $got"

# --live with an explicit --live-url needs no registry: the URL is emitted as given.
r="$(mktemp -d)"; printf '{"dependencies":{"astro":"5"}}' > "$r/package.json"
got="$(run "$SCRIPT" up --repo "$r" --mode live --run-id t4 --live-url https://example.com)"
[[ "${got%%|*}" == "0" && "${got#*|}" == *"QA_URL=https://example.com"* ]] \
  && ok "live with --live-url → that URL" || no "live with --live-url" "got: $got"
[[ "${got#*|}" == *"QA_AUTH_OP_ITEM="$'\n'* ]] \
  && ok "no access item named → none sent" || no "no access item named" "got: $got"
got="$(QA_LIVE_URL=https://example.org QA_ACCESS_OP_ITEM=item123 run "$SCRIPT" up --repo "$r" --mode live --run-id t5)"
[[ "${got#*|}" == *"QA_URL=https://example.org"* && "${got#*|}" == *"QA_AUTH_OP_ITEM=item123"* ]] \
  && ok "QA_LIVE_URL + QA_ACCESS_OP_ITEM from the environment" || no "live env" "got: $got"
got="$(run "$SCRIPT" up --repo "$r" --mode live --run-id t6)"
[[ "${got#*|}" == *"--live-url"* ]] && ok "the refusal names --live-url" || no "refusal names --live-url" "got: $got"

# ── port ownership without ss (macOS): the lsof path ──
# The helpers are lifted out of serve.sh and run under a PATH holding a stub
# lsof and no ss. The stub reports LISTEN_PID as the listener on port 4242.
T="$(mktemp -d)"
mkdir -p "$T/bin"
for t in bash grep cut sort ps tr sleep; do ln -s "$(command -v "$t")" "$T/bin/$t"; done
cat >"$T/bin/lsof" <<'LSOF'
#!/usr/bin/env bash
[[ "$*" == *"-iTCP:4242 "* ]] && echo "$LISTEN_PID"
exit 0
LSOF
chmod +x "$T/bin/lsof"
FUNCS="$T/funcs.sh"
sed -n '/^qa_listener_pids() {/,/^}/p; /^qa_port_free() {/,/^}/p; /^qa_port_owned_by() {/,/^}/p' "$SCRIPT" >"$FUNCS"
bash -c 'source "$0"; qa_spawn_group sleep 20 >/dev/null 2>&1 & echo $!' "$DIR/lib.sh" >"$T/pid"
sleep 0.3
LP="$(cat "$T/pid")"
lsof_run() { PATH="$T/bin" LISTEN_PID="$LP" bash -c "source '$FUNCS'; $1"; }
lsof_run 'qa_port_free 4242' && no "lsof: busy port" "read as free" || ok "lsof: a listened port is not free"
lsof_run 'qa_port_free 4243' && ok "lsof: a quiet port is free" || no "lsof: quiet port" "read as busy"
lsof_run "qa_port_owned_by 4242 $LP" && ok "lsof: our group owns the listener" || no "lsof: owned" "not owned"
lsof_run 'qa_port_owned_by 4242 1' && no "lsof: foreign group" "read as ours" || ok "lsof: another group does not"
rm "$T/bin/lsof"
lsof_run 'qa_port_free 4242' && ok "neither ss nor lsof: reads free" || no "no tools" "read as busy"
kill "$LP" 2>/dev/null || true
rm -rf "$T"

# bad --mode → exit 2
r="$(mktemp -d)"
got="$(run "$SCRIPT" up --repo "$r" --mode sideways --run-id t3)"
[[ "${got%%|*}" == "2" ]] && ok "bad mode → exit 2" || no "bad mode" "got: $got"

# missing --run-id → exit 2
got="$(run "$SCRIPT" up --repo "$r" --mode before)"
[[ "${got%%|*}" == "2" ]] && ok "missing run-id → exit 2" || no "missing run-id" "got: $got"

# down with missing runfile → exit 2
got="$(run "$SCRIPT" down --runfile /nonexistent/server.run)"
[[ "${got%%|*}" == "2" ]] && ok "down missing runfile → exit 2" || no "down missing runfile" "got: $got"

# unknown subcommand → exit 2
got="$(run "$SCRIPT" sideways)"
[[ "${got%%|*}" == "2" ]] && ok "unknown subcommand → exit 2" || no "unknown subcommand" "got: $got"

echo
echo "serve.sh guards: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
