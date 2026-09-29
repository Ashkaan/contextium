#!/usr/bin/env bash
# serve.sh — build + serve a repo for QA, in one of three states, and tear it
# down. A repo-agnostic, type-driven server (build → serve → health-poll) with
# OWNED-process teardown.
#
# Process ownership: the server is started in its own process group (setsid,
# or perl's setpgrp where setsid is missing, as on macOS); teardown signals
# ONLY that recorded group + removes only the ephemeral worktree this run
# created. It MUST NOT global-`pkill workerd`/`wrangler` — that would kill
# unrelated servers from other repos/sessions on a shared host.
#
# peers:
#   .agents/skills/qa/scripts/detect-app.sh
#   .agents/skills/qa/scripts/lib.sh
#   .agents/skills/qa/scripts/tests/serve-guards.test.sh
#
# Usage:
#   serve.sh up   --repo <dir> --mode before|after|live --run-id <id>
#                 [--port N] [--health-path /] [--live-url <url>]
#
# Port + listener ownership: with no --port, `up` scans UP from the default for
# a port with no listener, and never calls the server up until it has proven the
# listener belongs to the process group it spawned (or that the port was free
# immediately before spawning). Answering on a port is not evidence of owning it.
#   serve.sh down --runfile <path>
#
# `up` output (stdout, KEY=VALUE):
#   QA_URL=<base url>          QA_PORT=<port>        QA_LABEL=<evidence label>
#   QA_RUNFILE=<runfile path>  QA_PID=<server pid or empty for --live>
#   QA_PAGES=<%q-quoted space-separated routes discovered from the SERVED source;
#            empty when the source has no static routes — the SKILL then HALTs
#            unless an explicit `page` arg was passed>
# Exit: 0 ok; 2 usage; 3 detect unknown; 4 build failed; 5 server never up;
#       6 no derivable live URL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # sibling source, resolved at runtime
source "$SCRIPT_DIR/lib.sh"

DEFAULT_PORT=8813
SHOTS_ROOT="/tmp/qa-shots"
WORKTREE_ROOT="/tmp/qa-worktrees"

# ── shared arg state ─────────────────────────────────────────────────
SUB="${1:-}"; shift || true
REPO="" MODE="" RUN_ID="" PORT="" HEALTH_PATH="/" RUNFILE="" LIVE_URL="${QA_LIVE_URL:-}"

parse_up_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) REPO="${2:-}"; shift 2 ;;
      --mode) MODE="${2:-}"; shift 2 ;;
      --run-id) RUN_ID="${2:-}"; shift 2 ;;
      --port) PORT="${2:-}"; shift 2 ;;
      --health-path) HEALTH_PATH="${2:-}"; shift 2 ;;
      --live-url) LIVE_URL="${2:-}"; shift 2 ;;
      *) qa_err "serve up: unknown flag: $1"; exit 2 ;;
    esac
  done
}

# ── port ownership ───────────────────────────────────────────────────
# A health check that only proves "something answers on :PORT" is not a check —
# a stale server left behind by another repo answers 200 all day, and a /qa run
# that accepts it reviews the wrong application from end to end, while the
# label claims the right one. These two helpers make a run prove it owns the
# listener.
#
# `ss` on Linux, `lsof` where there is no `ss` (macOS). With neither, a port
# reads as free and no listener pid resolves — the run then accepts only a port
# it saw free the instant before spawning.

# qa_listener_pids PORT — the pids listening on PORT, one per line.
qa_listener_pids() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
  fi
}

# qa_port_free PORT — true when nothing is listening on PORT.
qa_port_free() {
  local hits
  if command -v ss >/dev/null 2>&1; then
    hits="$(ss -ltnH "sport = :$1" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    hits="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true)"
  else
    hits=""
  fi
  [[ -z "$hits" ]]
}

# qa_port_owned_by PORT PGID — 0 when a listener on PORT belongs to process
# group PGID (the group this run spawned); non-zero otherwise, including when
# no pid is exposed for the listener.
qa_port_owned_by() {
  local port="$1" pgid="$2" pids p g
  pids="$(qa_listener_pids "$port")"
  [[ -n "$pids" ]] || return 1
  for p in $pids; do
    g="$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')"
    [[ -n "$g" && "$g" == "$pgid" ]] && return 0
  done
  return 1
}

# ── teardown (down) ──────────────────────────────────────────────────
do_down() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --runfile) RUNFILE="${2:-}"; shift 2 ;;
      *) qa_err "serve down: unknown flag: $1"; exit 2 ;;
    esac
  done
  [[ -n "$RUNFILE" && -f "$RUNFILE" ]] || { qa_err "serve down: no runfile: $RUNFILE"; exit 2; }
  # shellcheck source=/dev/null
  source "$RUNFILE"
  if [[ -n "${QA_PID:-}" ]]; then
    # Signal the whole process group (negative PID) we own — never a global pkill.
    kill -TERM "-${QA_PID}" 2>/dev/null || kill -TERM "${QA_PID}" 2>/dev/null || true
    sleep 1
    kill -KILL "-${QA_PID}" 2>/dev/null || true
  fi
  if [[ -n "${QA_WORKTREE:-}" && -d "${QA_WORKTREE}" ]]; then
    git -C "${QA_SOURCE_REPO:-$QA_WORKTREE}" worktree remove --force "${QA_WORKTREE}" 2>/dev/null \
      || rm -rf "${QA_WORKTREE}"
  fi
  echo "qa: torn down (pid=${QA_PID:-none}, worktree=${QA_WORKTREE:-none})"
}

# ── build + serve (up) ───────────────────────────────────────────────
do_up() {
  parse_up_args "$@"
  [[ -n "$REPO" && -d "$REPO" ]] || { qa_err "serve up: --repo must be a directory"; exit 2; }
  case "$MODE" in before|after|live) ;; *) qa_err "serve up: --mode must be before|after|live"; exit 2 ;; esac
  [[ -n "$RUN_ID" ]] || { qa_err "serve up: --run-id required"; exit 2; }
  REPO="$(cd "$REPO" && pwd)"

  local slug run_dir
  slug="$(qa_repo_slug "$REPO")"
  run_dir="$SHOTS_ROOT/$slug/$RUN_ID"
  mkdir -p "$run_dir"
  RUNFILE="$run_dir/server.run"

  # ── resolve the SERVED SOURCE up front ──────────────────────────────
  # For --after, create the clean HEAD worktree NOW, BEFORE detection + route
  # discovery, so both read the committed revision being served — not the dirty
  # working tree. Otherwise an uncommitted page or qa:* script would select a
  # type/route that HEAD lacks and make after-commit QA lie (404s, wrong shots).
  # --before / --live detect + discover against the working tree.
  local src="$REPO" worktree="" label="working tree"
  if [[ "$MODE" == "after" ]]; then
    mkdir -p "$WORKTREE_ROOT"
    worktree="$WORKTREE_ROOT/$slug-$RUN_ID"
    rm -rf "$worktree"
    git -C "$REPO" worktree add --quiet --detach "$worktree" HEAD
    src="$worktree"
    label="HEAD worktree"
  fi
  # Remove the --after worktree on any early exit below (fail-safe cleanup).
  cleanup_worktree() { [[ -n "$worktree" ]] && git -C "$REPO" worktree remove --force "$worktree" 2>/dev/null || true; }

  # Detect type + any qa:* escape-hatch command against the served source.
  local det; det="$(bash "$SCRIPT_DIR/detect-app.sh" "$src")" || { echo "$det" >&2; cleanup_worktree; exit 3; }
  local TYPE QA_SERVE SERVE_DIR
  TYPE="$(printf '%s\n' "$det" | sed -n 's/^TYPE=//p')"
  QA_SERVE="$(printf '%s\n' "$det" | sed -n 's/^QA_SERVE=//p')"
  SERVE_DIR="$(printf '%s\n' "$det" | sed -n 's/^SERVE_DIR=//p')"

  if [[ "$TYPE" == "cli" || "$TYPE" == "render" ]]; then
    qa_err "serve up: $TYPE target has no server — run it directly (see SKILL ${TYPE} path)"
    cleanup_worktree
    exit 2
  fi

  # Discover the routes to screenshot from the SAME source being served, so the
  # route list always matches the served bytes (for --after that is the HEAD
  # worktree, for --live the working tree — the closest local proxy for the
  # deployed site). Emitted as QA_PAGES; an explicit `page` arg overrides it in
  # the SKILL. Empty (no static routes) is passed through for the SKILL to HALT.
  local pages; pages="$(bash "$SCRIPT_DIR/discover-routes.sh" "$src" 2>/dev/null | tr '\n' ' ' || true)"

  # ── --live: hit the deployed URL; never build, never infer the URL ──
  if [[ "$MODE" == "live" ]]; then
    # An explicit --live-url (or QA_LIVE_URL) wins. Otherwise DERIVE the live
    # URL from the Cloudflare Pages API by matching this repo against each
    # project's source repo_name. This is a lookup in an authoritative registry,
    # NOT inference from the directory name — the two differ in practice (a repo
    # named site-web deploying to example.com), which is exactly why a name
    # heuristic would be wrong and the API is not.
    local live_url="$LIVE_URL"
    if [[ -z "$live_url" ]]; then
      live_url="$(qa_derive_live_url_from_cf "$(basename "$REPO")" || true)"
      [[ -n "$live_url" ]] && qa_err "serve up: live URL derived from CF Pages API -> $live_url"
    fi
    [[ -n "$live_url" ]] || {
      qa_err "serve up: --live needs a live URL — pass --live-url <url>, or set"
      qa_err "  CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID for a Cloudflare Pages"
      qa_err "  lookup (none matched repo '$(basename "$REPO")'). Or use --before to"
      qa_err "  build and serve the working tree instead."
      exit 6
    }
    # A Cloudflare-Access-gated site needs a service token so a headless GET
    # returns 200, not a login redirect. Name its 1Password item in
    # QA_ACCESS_OP_ITEM and /qa attaches it on every --live run — harmless extra
    # headers on an ungated site, the difference between 200 and a login wall on
    # a gated one. We pass the 1Password item REF (not the secret) downstream;
    # screenshot.sh resolves it just-in-time into request headers, so no token
    # value hits stdout or the runfile. (QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET in
    # the environment work too, with no 1Password at all.)
    local ap_item="${QA_ACCESS_OP_ITEM:-}" ap_idf="${QA_ACCESS_ID_FIELD:-client_id}" ap_secf="${QA_ACCESS_SECRET_FIELD:-client_secret}"
    {
      printf 'QA_URL=%s\n' "$live_url"
      printf 'QA_PORT=""\n'
      printf 'QA_LABEL="live URL %s"\n' "$live_url"
      printf 'QA_RUNFILE="%s"\n' "$RUNFILE"
      printf 'QA_SLUG=%s\n' "$slug"
      printf 'QA_PID=""\n'
      printf 'QA_AUTH_OP_ITEM=%s\n' "$ap_item"
      printf 'QA_AUTH_ID_FIELD=%s\n' "$ap_idf"
      printf 'QA_AUTH_SECRET_FIELD=%s\n' "$ap_secf"
      printf 'QA_PAGES=%q\n' "$pages"
    } | tee "$RUNFILE"
    return 0
  fi

  # Pick the port. An explicit --port is honoured as given; otherwise scan UP
  # from the default for one with NO listener, and record whether the chosen
  # port was verifiably free at start — that fact is half the ownership proof
  # below. Assuming the default is how a run lands on someone else's server.
  local port port_was_free="no" probe
  if [[ -n "$PORT" ]]; then
    port="$PORT"
    qa_port_free "$port" && port_was_free="yes"
    [[ "$port_was_free" == "yes" ]] \
      || qa_err "qa: --port $port already has a listener — ownership will be enforced"
  else
    port="$DEFAULT_PORT"
    for probe in $(seq "$DEFAULT_PORT" $((DEFAULT_PORT + 40))); do
      if qa_port_free "$probe"; then port="$probe"; port_was_free="yes"; break; fi
    done
    [[ "$port_was_free" == "yes" ]] \
      || qa_err "qa: no free port in ${DEFAULT_PORT}-$((DEFAULT_PORT + 40)) — using :$port anyway"
    [[ "$port" != "$DEFAULT_PORT" ]] && qa_err "qa: :$DEFAULT_PORT is busy — serving on :$port instead"
  fi

  # Served source resolved above ($src): working tree for --before, HEAD worktree
  # for --after.
  local build_dir="$src"
  local persist="$build_dir/.wrangler/qa-state"
  local logfile="$run_dir/server.log"

  # ── build (guarded; mirror qa.sh:22) ──
  local build_cmd="" serve_cmd="" serve_cwd="$build_dir"
  case "$TYPE" in
    astro-cf)
      build_cmd="npm run build"
      # A Cloudflare Astro repo is one of TWO shapes and they take different commands.
      # `main` in the wrangler config declares a WORKER entry -> `wrangler dev`. Without it
      # the project is Pages -> `wrangler pages dev dist`. Both shapes are common, and
      # detection cannot tell them apart from the astro+wrangler signals alone.
      #
      # Assuming Pages for both does not degrade — it HANGS. A Worker entry that exports a
      # Workflow or Durable Object is served through wrangler's pages-shim entrypoint, which
      # does not re-export it, so workerd refuses to boot with "Your Worker depends on the
      # following Workflows, which are not exported in your entrypoint file". The astro-dev
      # fallback below eventually catches it, but only after the pages attempt burns its full
      # health-check window, and the fallback has no CF bindings — so a whole QA pass runs
      # against a server that cannot read KV, for a repo that would have served fine.
      if qa_wrangler_declares_main "$build_dir"; then
        serve_cmd="npx wrangler dev --port $port --persist-to $persist"
      else
        serve_cmd="npx wrangler pages dev dist --port $port --persist-to $persist --compatibility-date 2025-09-01"
      fi
      ;;
    astro)
      build_cmd="npm run build"
      serve_cmd="npx astro preview --port $port --host"
      ;;
    vite)
      build_cmd="npm run build"
      serve_cmd="npx vite preview --port $port"
      ;;
    next)
      build_cmd="npm run build"
      serve_cmd="npx next start --port $port"
      ;;
    static)
      serve_cmd="python3 -m http.server $port"
      serve_cwd="$build_dir/${SERVE_DIR:-dist}"
      ;;
    node-server)
      # The repo's qa:serve script binds $PORT; pass the port /qa health-polls.
      # `env` is required: the command is run under `exec` below, and `exec` with
      # a leading VAR=VALUE treats the assignment as the PROGRAM NAME, so the
      # bare `PORT=$port ...` form failed every single node-server run.
      serve_cmd="env PORT=$port $QA_SERVE"
      ;;
    *)
      qa_err "serve up: cannot serve type=$TYPE"; exit 3 ;;
  esac

  if [[ -n "$build_cmd" ]]; then
    echo "qa: building ($TYPE)…" >&2
    if ! (cd "$build_dir" && eval "$build_cmd" >"$run_dir/build.log" 2>&1); then
      qa_err "qa: build failed — tail of $run_dir/build.log:"
      tail -n 20 "$run_dir/build.log" >&2
      cleanup_worktree
      exit 4
    fi
  fi

  # ── no local-KV seed: a --before build of a KV-backed site renders
  #    empty/no-data states by design. For DATA-correctness QA of those sites,
  #    use --live (real KV) or read production KV directly. ──

  # ── start the server in its OWN process group, health-poll, and
  #    for astro-cf fall back to `astro dev` when workerd won't boot. ──
  # astro-cf primary is `wrangler pages dev` (real CF bindings); workerd fails to
  # start in some sandboxes, so `astro dev` (Vite, serves source, no build/KV
  # bindings) is queued as a second attempt. It loses local KV — pages fall back
  # to code defaults; verify real DATA via KV directly, not this server.
  local pid pgid up="no" attempt idx=0 used_fallback="no"
  local -a serve_cmds=("$serve_cmd")
  if [[ "$TYPE" == "astro-cf" ]]; then
    serve_cmds+=("npx astro dev --port $port --host")
  fi
  if [[ "$TYPE" == "next" ]]; then
    # `next start` needs a production build and refuses on `output: export`;
    # `next dev` serves source and always works. Same shape as the astro-cf
    # workerd fallback: a second attempt, not a different code path.
    serve_cmds+=("npx next dev --port $port")
  fi
  for attempt in "${serve_cmds[@]}"; do
    idx=$((idx + 1))
    echo "qa: starting $TYPE server on :$port ($attempt)…" >&2
    qa_spawn_group bash -c "cd '$serve_cwd' && exec $attempt" >"$logfile" 2>&1 &
    pid=$!
    # The child leads its own process group, so its PGID is its own PID — read
    # it back rather than assuming, and fall back to $pid if it has already
    # exited.
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [[ -n "$pgid" ]] || pgid="$pid"
    up="no"
    for _ in $(seq 1 40); do
      if curl -s -o /dev/null "http://localhost:$port${HEALTH_PATH}"; then
        # Something answers. Prove it is OURS before calling the server up:
        # either the listener is in the process group we just spawned, or the
        # port was verifiably free the moment before we spawned it.
        if qa_port_owned_by "$port" "$pgid"; then
          up="yes"
        elif [[ "$port_was_free" == "yes" ]]; then
          qa_err "qa: listener pid on :$port not resolvable — accepted (port was free at start)"
          up="yes"
        else
          qa_err "qa: :$port answers but the listener is NOT this run's process group"
          qa_err "  — refusing it; that is how a QA pass grades a different repo's app."
          up="foreign"
        fi
        break
      fi
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if [[ "$up" == "yes" ]]; then
      [[ "$idx" -gt 1 ]] && used_fallback="yes"
      break
    fi
    if [[ "$up" == "foreign" ]]; then
      qa_err "qa: stop the process holding :$port, or pass --port <free-port>."
    else
      qa_err "qa: '$attempt' did not come up on :$port — tail of $logfile:"
      tail -n 5 "$logfile" >&2
    fi
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  if [[ "$up" != "yes" ]]; then
    qa_err "qa: server never came up on :$port (all attempts failed)"
    cleanup_worktree
    exit 5
  fi
  if [[ "$used_fallback" == "yes" ]]; then
    case "$TYPE" in
      astro-cf) label="$label (astro dev fallback — no CF bindings)" ;;
      next) label="$label (next dev fallback — dev server, not a production build)" ;;
      *) label="$label (fallback server)" ;;
    esac
  fi

  {
    printf 'QA_URL=http://localhost:%s\n' "$port"
    printf 'QA_PORT=%s\n' "$port"
    printf 'QA_LABEL="%s"\n' "$label"
    printf 'QA_RUNFILE="%s"\n' "$RUNFILE"
    printf 'QA_SLUG=%s\n' "$slug"
    printf 'QA_PID=%s\n' "$pid"
    printf 'QA_WORKTREE="%s"\n' "$worktree"
    printf 'QA_SOURCE_REPO="%s"\n' "$REPO"
    printf 'QA_LOGFILE="%s"\n' "$logfile"
    printf 'QA_PAGES=%q\n' "$pages"
  } | tee "$RUNFILE"
}

case "$SUB" in
  up) do_up "$@" ;;
  down) do_down "$@" ;;
  *) qa_err "usage: serve.sh up|down ..."; exit 2 ;;
esac
