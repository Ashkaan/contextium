#!/usr/bin/env bash
# lib.sh — shared pure helpers for the /qa harness scripts.
#
# Sourced by detect-app.sh, serve.sh, screenshot.sh, a11y.sh. Holds the two
# pure functions tests/lib.test.sh pins (route-slug + page-resolve)
# plus small path/JSON helpers reused across scripts, so the logic lives in
# exactly one place.
#
# peers:
#   .agents/skills/qa/scripts/detect-app.sh
#   .agents/skills/qa/scripts/serve.sh
#   .agents/skills/qa/scripts/screenshot.sh
#   .agents/skills/qa/scripts/interaction-check.sh
#   .agents/skills/qa/scripts/ensure-playwright.sh
#   .agents/skills/qa/scripts/tests/lib.test.sh
#
# This file declares functions only — it has NO executable body, so sourcing it
# is side-effect-free.

set -euo pipefail

# qa_err MSG... — print to stderr (errors never pollute stdout pipelines).
qa_err() { echo "$@" >&2; }

# qa_repo_slug REPO_DIR — directory basename, with a short hash of the absolute
# path appended so two same-basename repos never collide. The
# hash is unconditional-but-stable: same path always yields the same slug, and
# different paths sharing a basename get distinct slugs.
qa_repo_slug() {
  local repo="$1" base abspath hash
  abspath="$(cd "$repo" 2>/dev/null && pwd || echo "$repo")"
  base="$(basename "$abspath")"
  hash="$(printf '%s' "$abspath" | cksum | cut -d' ' -f1)"
  printf '%s-%s' "$base" "$hash"
}

# qa_slug_route ROUTE — map a route to a filesystem-safe, collision-free token.
# Strips the leading slash, replaces every non [A-Za-z0-9-] char (including the
# query `?`, `=`, `&`, and path `/`) with `_`, collapses repeats, trims edge
# `_`, caps at 60 chars, and maps the empty/root route to `index`. Distinct
# routes (incl. distinct query strings) produce distinct names.
qa_slug_route() {
  local route="$1" slug
  slug="${route#/}"
  slug="$(printf '%s' "$slug" | tr -c 'A-Za-z0-9-' '_')"
  # collapse runs of `_`, trim leading/trailing `_`
  slug="$(printf '%s' "$slug" | sed -E 's/_+/_/g; s/^_+//; s/_+$//')"
  slug="${slug:0:60}"
  [[ -z "$slug" ]] && slug="index"
  printf '%s' "$slug"
}

# qa_resolve_pages EXPLICIT_PAGES DEFAULT_PAGES — resolve the page list.
# Precedence: explicit CLI args > the discovered/default set > the root `/`.
# Each argument is a single space-separated string; the result is printed
# space-separated. Never resolves to empty ("0 pages → default, never
# screenshot nothing").
qa_resolve_pages() {
  local explicit="$1" from_default="$2"
  if [[ -n "${explicit// /}" ]]; then
    printf '%s' "$explicit"
  elif [[ -n "${from_default// /}" ]]; then
    printf '%s' "$from_default"
  else
    printf '/'
  fi
}

# qa_spawn_group CMD... — exec CMD as the leader of a new process group, so a
# teardown can signal the group (negative pid) and reach every child it spawned.
# `setsid` where it exists (Linux); perl's setpgrp where it does not (macOS
# ships perl, not setsid). Called in the background (`qa_spawn_group … &`):
# both forms exec in place, so `$!` is the group leader's pid. With neither, it
# execs plainly and teardown falls back to signalling the one pid.
qa_spawn_group() {
  if command -v setsid >/dev/null 2>&1; then exec setsid "$@"; fi
  if command -v perl >/dev/null 2>&1; then
    exec perl -e 'setpgrp(0, 0) or die "setpgrp: $!\n"; exec { $ARGV[0] } @ARGV or die "exec: $!\n"' "$@"
  fi
  exec "$@"
}

# qa_change_hash REPO — a stable digest of a repo's uncommitted change-set. It
# keyed the done-marker an autonomous QA Stop hook used to read, so that hook
# fired once per distinct set of edits. No hook reads it now; `/implement`
# phase 4.8 gates on the TREE marker instead. Kept because mark-qa-done.sh
# still writes it and writing it costs nothing.
qa_change_hash() {
  local repo="$1"
  git -C "$repo" status --porcelain 2>/dev/null | cksum | cut -d' ' -f1
}

# qa_derive_live_url_from_cf REPO_BASENAME — resolve a repo to its deployed URL
# by looking it up in the Cloudflare Pages project registry. Prints the URL on
# success, prints nothing and returns 1 otherwise.
#
# This is a REGISTRY LOOKUP, not inference: it matches on each project's
# `source.config.repo_name` (what CF actually builds from) and returns the
# project's own custom domain. Repo dir name and domain diverge in practice
# (a repo named site-web deploying to example.com), so a string heuristic would be wrong here
# and this is not. Satisfies no guessing by consulting the authoritative
# source rather than assuming, and keeps `/qa --live` usable in a repo that has
# never been configured.
#
# Cached for 6h at /tmp/qa-cf-pages-cache.json — the project list changes on the
# order of months, and the whole point is to stay fast enough to sit in the
# default path.
#
# Credentials are wrangler's own: CLOUDFLARE_API_TOKEN (Pages read) and
# CLOUDFLARE_ACCOUNT_ID. Without them there is no registry to ask, and this
# returns 1 — the caller then needs --live-url, never a guessed URL.
qa_derive_live_url_from_cf() {
  local repo_name="$1"
  local cache="/tmp/qa-cf-pages-cache.json"
  local account="${CLOUDFLARE_ACCOUNT_ID:-}"

  if [[ ! -s "$cache" ]] || [[ -n "$(find "$cache" -mmin +360 2>/dev/null)" ]]; then
    local token="${CLOUDFLARE_API_TOKEN:-}"
    [[ -n "$token" && -n "$account" ]] || return 1
    # Write to a per-run sibling, then rename into place. `curl -o "$cache"`
    # truncated the shared file in place, so a second session reading it
    # mid-download parsed half a JSON document, found no match, and resolved the
    # wrong live URL. rename(2) is atomic within a filesystem, so a concurrent
    # reader sees either the old complete file or the new one, never a partial.
    local tmp
    tmp="$(mktemp "${cache}.XXXXXX")" || return 1
    if ! curl -sf -m 15 -H "Authorization: Bearer $token" \
        "https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects" \
        -o "$tmp" 2>/dev/null; then
      rm -f "$tmp"
      return 1
    fi
    mv -f "$tmp" "$cache" || { rm -f "$tmp"; return 1; }
  fi

  local url
  # No top-level `return` here — that is a SyntaxError in `node -e`, and with
  # stderr suppressed it fails silently as "no match".
  url="$(node -e '
    const fs = require("fs");
    let out = "";
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const want = process.argv[2];
      for (const p of d.result || []) {
        const repo = ((p.source || {}).config || {}).repo_name;
        if (repo !== want) continue;
        const dom = (p.domains || []).find((x) => !x.endsWith(".pages.dev"));
        if (dom) { out = "https://" + dom; break; }
      }
    } catch {}
    process.stdout.write(out);
  ' "$cache" "$repo_name")" || return 1

  [[ -n "$url" ]] || return 1
  printf '%s' "$url"
}

# Does this repo's wrangler config declare a Worker entry (`main`)?
#
# It is the one signal that separates the two shapes of Cloudflare Astro project, which take
# different serve commands: `main` present -> a Worker (`wrangler dev`); absent -> Pages
# (`wrangler pages dev dist`). detect-app.sh cannot tell them apart, because both carry the
# same astro + wrangler dependency signals.
#
# Anchored at line start so a `//`-commented or `#`-commented `main` in a JSONC/TOML config
# does not count, and so a nested `main` inside some other block cannot masquerade as the
# top-level key. Checks jsonc, json, then toml — first config found wins, matching how
# wrangler itself resolves.
qa_wrangler_declares_main() {
  local repo="$1" cfg
  for cfg in wrangler.jsonc wrangler.json wrangler.toml; do
    [[ -f "$repo/$cfg" ]] || continue
    grep -qE '^[[:space:]]*("main"[[:space:]]*:|main[[:space:]]*=)' "$repo/$cfg" && return 0
    return 1
  done
  return 1
}

# qa_playwright_node_modules [APP_DIR] — print the node_modules dir holding a
# `playwright` whose chromium revision is installed, or return 1. Shared by
# screenshot.sh and interaction-check.sh.
#
# With APP_DIR, the app's own copy comes first: every node_modules from the app
# up to its repo root (the first ancestor holding `.git`), so a hoisted
# workspace install counts. An app that ships Playwright must never be skipped
# because the machine has none of its own.
#
# When no copy on the machine has its browser, ensure-playwright.sh installs one
# into its own cache on first use. When that is impossible (offline, no npm,
# QA_NO_INSTALL=1) it prints `qa: skipped — Playwright unavailable (<reason>)`
# on stderr and this returns 1: the caller reports a skip, never a pass.
qa_playwright_node_modules() {
  local app="${1:-}" candidates=() d
  if [[ -n "$app" && -d "$app" ]]; then
    d="$(cd "$app" && pwd)"
    while :; do
      [[ -d "$d/node_modules" ]] && candidates+=("$d/node_modules")
      [[ -e "$d/.git" || "$d" == "/" ]] && break
      d="${d%/*}"; [[ -n "$d" ]] || d="/"
    done
  fi
  local g; g="$(npm root -g 2>/dev/null || true)"
  [[ -n "$g" ]] && candidates+=("$g")
  local c
  for c in "$HOME"/.npm/_npx/*/node_modules; do
    [[ -d "$c/playwright" ]] && candidates+=("$c")
  done
  # node picks the first candidate whose chromium revision is installed.
  node - ${candidates[@]+"${candidates[@]}"} <<'NODE' && return 0
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
  || path.join(os.homedir(), ".cache", "ms-playwright");
for (const dir of process.argv.slice(2)) {
  try {
    const bj = path.join(dir, "playwright-core", "browsers.json");
    if (!fs.existsSync(bj)) continue;
    const j = JSON.parse(fs.readFileSync(bj, "utf8"));
    const ch = (j.browsers || []).find((b) => b.name === "chromium");
    if (!ch) continue;
    const rev = ch.revision;
    // The browser dir layout differs by version (chrome-linux vs chrome-linux64),
    // so test the layout-independent INSTALLATION_COMPLETE marker instead.
    const full = path.join(cache, `chromium-${rev}`, "INSTALLATION_COMPLETE");
    const shell = path.join(cache, `chromium_headless_shell-${rev}`, "INSTALLATION_COMPLETE");
    if (fs.existsSync(full) || fs.existsSync(shell)) { process.stdout.write(dir); process.exit(0); }
  } catch {}
}
process.exit(1);
NODE
  local here mod
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local -a ensure_args=()
  [[ -z "$app" || ! -d "$app" ]] || ensure_args=(--app "$app")
  mod="$(bash "$here/ensure-playwright.sh" ${ensure_args[@]+"${ensure_args[@]}"} | sed -n 's/^PLAYWRIGHT_MODULE=//p')" || return 1
  [[ -n "$mod" ]] || return 1
  dirname "$mod"
}

# qa_resolve_cf_access OP_ITEM ID_FIELD SECRET_FIELD — export the CF-Access
# service-token pair as QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET, or return 1 when
# either is unresolved. The values travel in the environment, never on argv.
qa_resolve_cf_access() {
  local item="$1" id_field="$2" secret_field="$3" vault
  # A 1Password service account must name the vault, so look up which vault
  # holds this item rather than naming one.
  vault="$(op item list --format json 2>/dev/null | jq -r --arg id "$item" 'first(.[] | select(.id == $id or .title == $id) | .vault.id) // empty' || true)"
  QA_CF_ACCESS_ID="$(op item get "$item" --vault "$vault" --fields "$id_field" --reveal 2>/dev/null || true)"
  QA_CF_ACCESS_SECRET="$(op item get "$item" --vault "$vault" --fields "$secret_field" --reveal 2>/dev/null || true)"
  export QA_CF_ACCESS_ID QA_CF_ACCESS_SECRET
  [[ -n "$QA_CF_ACCESS_ID" && -n "$QA_CF_ACCESS_SECRET" ]]
}

# qa_interaction_stamp_path REPO_DIR TREE — where interaction-check.sh records a
# clean run for a tree, and where mark-qa-done.sh --tree looks for it. One
# formula, here, so the writer and the reader cannot disagree about the key.
qa_interaction_stamp_path() {
  local repo="$1" tree="$2"
  printf '%s/interaction-%s-%s\n' "${QA_DONE_DIR:-/tmp/qa-done}" "$(qa_repo_slug "$repo")" "$tree"
}
