#!/usr/bin/env bash
# interaction-check.sh — press every visible button on each page with the
# server held still, and flag what does not answer at once. The checks and why
# they exist are in interaction-check.mjs; this wrapper resolves Playwright and
# the CF-Access token the same way screenshot.sh does.
#
# peers:
#   .agents/skills/qa/scripts/interaction-check.mjs
#   .agents/skills/qa/scripts/lib.sh
#   .agents/skills/qa/scripts/tests/interaction-check.test.sh
#
# Usage:
#   interaction-check.sh --url <base> --pages "<route ...>" [--repo <target-dir>]
#                        [--auth-op-item <id> --auth-id-field F --auth-secret-field F]
#
# With --repo, a clean run (exit 0) writes the stamp mark-qa-done.sh --tree
# refuses to mark a served app without: $QA_DONE_DIR/interaction-<slug>-<tree>,
# where <tree> is `.agents/skills/review/code-review.sh --snapshot` of the repo holding
# the target — the same snapshot /implement passes to mark-qa-done as
# $POST_QA. An edit after the check moves the tree, so the stamp stops matching
# and the check has to run again.
# Output: `INTERACTION <route> <kind> <detail>` per finding, `SKIPPED …` per
#         opt-out, and one `interaction: …` summary (see interaction-check.mjs).
# Exit:   0 clean; 9 findings; 1 a route did not load; 2 usage; 7 Playwright
#         unavailable — `qa: skipped — Playwright unavailable (<reason>)` on
#         stderr, a skip and never a pass.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # sibling source, resolved at runtime
source "$SCRIPT_DIR/lib.sh"

URL="" PAGES="" REPO=""
AUTH_OP_ITEM="" AUTH_ID_FIELD="client_id" AUTH_SECRET_FIELD="client_secret"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --pages) PAGES="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --auth-op-item) AUTH_OP_ITEM="${2:-}"; shift 2 ;;
    --auth-id-field) AUTH_ID_FIELD="${2:-client_id}"; shift 2 ;;
    --auth-secret-field) AUTH_SECRET_FIELD="${2:-client_secret}"; shift 2 ;;
    *) qa_err "interaction-check: unknown flag: $1"; exit 2 ;;
  esac
done

[[ -n "$URL" && -n "${PAGES// /}" ]] || { qa_err "usage: interaction-check.sh --url U --pages '/ /about'"; exit 2; }

if [[ -n "$AUTH_OP_ITEM" ]] && ! qa_resolve_cf_access "$AUTH_OP_ITEM" "$AUTH_ID_FIELD" "$AUTH_SECRET_FIELD"; then
  qa_err "interaction-check: --auth-op-item set but service token unresolved from 1Password item $AUTH_OP_ITEM"
  exit 2
fi
export QA_CF_ACCESS_ID="${QA_CF_ACCESS_ID:-}" QA_CF_ACCESS_SECRET="${QA_CF_ACCESS_SECRET:-}"

NODE_MODULES="$(qa_playwright_node_modules "$REPO" || true)"
if [[ -z "$NODE_MODULES" ]]; then
  qa_err "qa: skipped — Playwright unavailable (see the line above); no interaction check ran"
  exit 7
fi
QA_PW_PARENT="$(dirname "$NODE_MODULES")"
export QA_PW_PARENT

rc=0
node "$SCRIPT_DIR/interaction-check.mjs" "$URL" "$PAGES" || rc=$?
if [[ "$rc" -eq 0 && -n "$REPO" ]]; then
  tree="$(cd "$REPO" && bash "$SCRIPT_DIR/../../review/code-review.sh" --snapshot)"
  stamp="$(qa_interaction_stamp_path "$REPO" "$tree")"
  mkdir -p "$(dirname "$stamp")"
  touch "$stamp"
  echo "interaction: stamped $(basename "$stamp")"
fi
exit "$rc"
