#!/usr/bin/env bash
# detect-app.sh — classify a repo (or an app folder in one) into a serveable app type and
# emit the facts serve.sh needs. Detection reads package.json (deps + scripts)
# + on-disk markers ONLY — /qa is zero-config, so there is no per-repo .qa.json.
# Detection NEVER invents a serve/run command for
# Node-server / CLI / render targets — those declare themselves with a
# `qa:serve` / `qa:cmd` / `qa:render` script in their own package.json; only the
# convention-covered web shapes (Astro / Vite / static) get a default. A target
# that matches neither convention nor a qa:* script exits 3 (`unknown`).
#
# peers:
#   .agents/skills/qa/scripts/serve.sh
#   .agents/skills/qa/scripts/discover-routes.sh
#   .agents/skills/qa/scripts/lib.sh
#   .agents/skills/qa/scripts/tests/detect-app.test.sh
#
# Usage:   detect-app.sh <repo-dir>
# Output:  KEY=VALUE lines on stdout, one per line. Parse each with a line-anchored
#          `sed -n 's/^KEY=//p'` (as serve.sh does) — NOT
#          `eval`/`source`: the command values intentionally contain spaces
#          (`QA_SERVE=npm run qa:serve`), so the stream is not shell-sourceable.
#            TYPE=astro-cf|astro|next|vite|static|node-server|cli|render|unknown
#            QA_SERVE=<`npm run qa:serve`, or empty>
#            QA_CMD=<`npm run qa:cmd`, or empty>
#            QA_RENDER=<`npm run qa:render`, or empty>
#            SERVE_DIR=<static dir basename when TYPE=static, else empty>
#            SIGNALS=<comma list of detected signals>
# Exit:    0 detected; 2 usage; 3 unknown / needs-qa:*-script (signals on stderr)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # sibling source, resolved at runtime
source "$SCRIPT_DIR/lib.sh"

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  qa_err "usage: detect-app.sh <repo-dir>"
  exit 2
fi
if [[ ! -d "$REPO" ]]; then
  qa_err "detect-app: not a directory: $REPO"
  exit 2
fi

PKG="$REPO/package.json"

# pkg_script FILE KEY — print a package.json scripts[KEY] value, or empty. The
# qa:* scripts are the zero-config escape hatch: a target that can't be served
# by convention (render output, a CLI, a bespoke server) declares HOW to run in
# its own package.json instead of a sidecar config file.
pkg_script() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || { printf ''; return 0; }
  node -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const s = (p.scripts || {})[process.argv[2]];
      process.stdout.write(s ? String(s) : "");
    } catch { process.stdout.write(""); }
  ' "$file" "$key" 2>/dev/null || printf ''
}

qa_render_s="$(pkg_script "$PKG" "qa:render")"
qa_cmd_s="$(pkg_script "$PKG" "qa:cmd")"
qa_serve_s="$(pkg_script "$PKG" "qa:serve")"

# Emitted commands are the npm invocation of the declared script.
qa_render_cmd=""; [[ -n "$qa_render_s" ]] && qa_render_cmd="npm run qa:render"
qa_cmd_cmd="";    [[ -n "$qa_cmd_s"    ]] && qa_cmd_cmd="npm run qa:cmd"
qa_serve_cmd="";  [[ -n "$qa_serve_s"  ]] && qa_serve_cmd="npm run qa:serve"

emit() {
  printf 'TYPE=%s\n' "$1"
  printf 'QA_SERVE=%s\n' "${qa_serve_cmd}"
  printf 'QA_CMD=%s\n' "${qa_cmd_cmd}"
  printf 'QA_RENDER=%s\n' "${qa_render_cmd}"
  printf 'SERVE_DIR=%s\n' "${2:-}"
  printf 'SIGNALS=%s\n' "${3:-}"
}

# ── qa:* escape-hatch scripts win over convention ────────────────────
# A `render` script is the universal hatch: the repo declares how to produce
# PNG(s) into $QA_OUT for anything that isn't a served web page (TRMNL Liquid,
# HTML-to-image). It wins over cmd/serve — it IS the visual.
if [[ -n "$qa_render_s" ]]; then
  emit render "" "package.json:qa:render"
  exit 0
fi
if [[ -n "$qa_cmd_s" ]]; then
  emit cli "" "package.json:qa:cmd"
  exit 0
fi
if [[ -n "$qa_serve_s" ]]; then
  emit node-server "" "package.json:qa:serve"
  exit 0
fi

# ── package.json-driven convention detection ─────────────────────────
deps=""
has_bin="no"
if [[ -f "$PKG" ]]; then
  deps="$(node -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const all = Object.assign({}, p.dependencies, p.devDependencies);
      process.stdout.write(Object.keys(all).join(" "));
    } catch { process.stdout.write(""); }
  ' "$PKG" 2>/dev/null || printf '')"
  has_bin="$(node -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(p.bin ? "yes" : "no");
    } catch { process.stdout.write("no"); }
  ' "$PKG" 2>/dev/null || printf 'no')"
fi

has_dep() { printf '%s ' "$deps" | grep -qiE "(^| )$1( |$)"; }

has_astro="no"; has_dep "astro" && has_astro="yes"
has_next="no"
if has_dep "next" || compgen -G "$REPO/next.config.*" >/dev/null 2>&1; then
  has_next="yes"
fi
has_vite="no"; has_dep "vite" && has_vite="yes"
has_wrangler="no"
if has_dep "wrangler" || printf '%s' "$deps" | grep -qi "@cloudflare" \
  || [[ -f "$REPO/wrangler.toml" || -f "$REPO/wrangler.jsonc" \
        || -f "$REPO/wrangler.json" ]]; then
  has_wrangler="yes"
fi

signals="astro=$has_astro,next=$has_next,vite=$has_vite,wrangler=$has_wrangler,bin=$has_bin"

if [[ "$has_astro" == "yes" && "$has_wrangler" == "yes" ]]; then
  emit astro-cf "" "$signals"
  exit 0
fi
if [[ "$has_astro" == "yes" ]]; then
  emit astro "" "$signals"
  exit 0
fi
# Next MUST be tested before vite/static: a Next repo ships a `dist`/`public`
# dir and often bundles vite-family devDeps, so the fallbacks below would
# misclassify it as `static` and serve prebuilt bytes instead of the app.
if [[ "$has_next" == "yes" ]]; then
  emit next "" "$signals"
  exit 0
fi
if [[ "$has_vite" == "yes" ]]; then
  emit vite "" "$signals"
  exit 0
fi

# Static: a prebuilt output dir, no build toolchain detected.
if [[ -d "$REPO/dist" ]]; then
  emit static "dist" "$signals,static=dist"
  exit 0
fi
if [[ -d "$REPO/public" ]]; then
  emit static "public" "$signals,static=public"
  exit 0
fi

# CLI / library / Node-server without a qa:* script: refuse to guess a command.
if [[ "$has_bin" == "yes" ]]; then
  qa_err "detect-app: CLI/library target ($signals) — add a \`qa:cmd\` script to package.json"
  emit unknown "" "$signals,needs=package.json:qa:cmd"
  exit 3
fi

qa_err "detect-app: unknown app type ($signals) — add a package.json qa:* script (\`qa:serve\` or \`qa:cmd\` or \`qa:render\`)"
emit unknown "" "$signals"
exit 3
