#!/usr/bin/env bash
# a11y.sh — OPTIONAL accessibility layer for /qa (`--a11y`). Runs axe-core
# (Deque) per page/viewport via @axe-core/playwright and prints a violation
# count per page. axe catches ~57% of WCAG issues automatically — treated as an
# ADVISORY signal, NOT a hard gate (a rule engine covering half the standard
# cannot certify it);
# it does NOT do overlap/collision detection (that is the visual-review
# subagent's job).
#
# The axe deps are NOT vendored in this repo.
# they install on first use into an off-repo cache at ~/.local/lib/qa-a11y/.
#
# peers:
#   .agents/skills/qa/scripts/screenshot.sh
#   .agents/skills/qa/scripts/lib.sh
#
# Usage:  a11y.sh --url <base> --pages "<route ...>" [--viewports W,W,W]
# Exit:   0 ran (advisory — never fails on violations); 2 usage;
#         8 axe deps unavailable / install failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # sibling source, resolved at runtime
source "$SCRIPT_DIR/lib.sh"

CACHE_DIR="$HOME/.local/lib/qa-a11y"
URL="" PAGES="" VIEWPORTS="1440"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --pages) PAGES="${2:-}"; shift 2 ;;
    --viewports) VIEWPORTS="${2:-}"; shift 2 ;;
    *) qa_err "a11y: unknown flag: $1"; exit 2 ;;
  esac
done

[[ -n "$URL" ]] || { qa_err "usage: a11y.sh --url U --pages '...'"; exit 2; }
PAGES="$(qa_resolve_pages "$PAGES" "")"

# ── install axe deps off-repo on first use ───────────────────────────
# Serialized on a lock: CACHE_DIR is one shared directory, and two sessions
# hitting their first --a11y run at once had both npm installs writing the same
# node_modules tree, interleaving into a broken half-install that then failed for
# both. The lock makes the second one wait and find the work already done, which
# is why the -d test is re-checked inside it.
#
# `flock` where it exists (Linux); a `mkdir` lock where it does not (macOS has
# no flock). mkdir is atomic on every filesystem, so it serializes the same way.
a11y_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 202>"${CACHE_DIR}.lock"
    flock -w 300 202
    return
  fi
  local i=0
  until mkdir "${CACHE_DIR}.lockdir" 2>/dev/null; do
    i=$((i + 1)); [[ $i -lt 300 ]] || return 1; sleep 1
  done
}
a11y_unlock() {
  if command -v flock >/dev/null 2>&1; then flock -u 202; else rmdir "${CACHE_DIR}.lockdir" 2>/dev/null || true; fi
}
if [[ ! -d "$CACHE_DIR/node_modules/@axe-core/playwright" ]]; then
  # QA_NO_INSTALL=1 (offline machines, CI) forbids every first-use install.
  if [[ "${QA_NO_INSTALL:-}" == "1" ]]; then
    qa_err "a11y: @axe-core/playwright is not installed and QA_NO_INSTALL=1 — skipping a11y layer"
    exit 8
  fi
  mkdir -p "$CACHE_DIR"
  if ! a11y_lock; then
    qa_err "a11y: another run has held the install lock for 5m — skipping a11y layer"
    exit 8
  fi
  if [[ ! -d "$CACHE_DIR/node_modules/@axe-core/playwright" ]]; then
    echo "qa: installing @axe-core/playwright into $CACHE_DIR (first --a11y run)…" >&2
    if ! (cd "$CACHE_DIR" && npm install --no-save --silent \
          @axe-core/playwright playwright >/dev/null 2>&1); then
      a11y_unlock
      qa_err "a11y: could not install @axe-core/playwright — skipping a11y layer"
      exit 8
    fi
  fi
  a11y_unlock
fi

# ESM `import` ignores NODE_PATH; run node from CACHE_DIR so its node_modules
# (playwright + @axe-core/playwright) resolves the bare specifiers up-tree.
# shellcheck disable=SC2016  # node program is intentionally unexpanded by bash
( cd "$CACHE_DIR" && node --input-type=module -e '
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const [base, pagesCsv, viewportsCsv] = process.argv.slice(1);
const pages = pagesCsv.split(/\s+/).filter(Boolean);
const widths = viewportsCsv.split(",").map((w) => parseInt(w.trim(), 10)).filter(Boolean);

const browser = await chromium.launch();
for (const route of pages) {
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: 1600 } });
    const page = await ctx.newPage();
    const url = base.replace(/\/$/, "") + (route.startsWith("/") ? route : "/" + route);
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      const results = await new AxeBuilder({ page }).analyze();
      const n = results.violations.length;
      const ids = results.violations.map((v) => v.id).join(", ");
      process.stdout.write(`a11y ${route} @${width}: ${n} violation(s)${ids ? " [" + ids + "]" : ""}\n`);
    } catch (e) {
      process.stdout.write(`a11y ${route} @${width}: error — ${e.message}\n`);
    }
    await ctx.close();
  }
}
await browser.close();
' "$URL" "$PAGES" "$VIEWPORTS" )

echo "qa: a11y is advisory (~57% WCAG coverage) — not a hard gate" >&2
