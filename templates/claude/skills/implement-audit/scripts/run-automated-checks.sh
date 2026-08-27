#!/usr/bin/env bash
# run-automated-checks.sh — the deterministic half of /implement-audit.
#
# Before spending a reviewer call on judgment, run the checks that need none.
# A linter finding is cheaper, faster and more certain than the same finding
# arrived at by a model, and every check that passes here is one the reviewer
# does not have to spend its output cap on.
#
# Nothing here is mandatory. A project with no test script and no linter gets
# SKIP lines, not failures — this must work in an empty repo on day one.
#
# USAGE
#   run-automated-checks.sh --session-base <SHA> [--repo-dir <path>]
#
# OUTPUT (stdout, one line per check, for the reviewer brief verbatim):
#   PASS: tests (npm test)
#   FAIL: shellcheck .claude/hooks/foo.sh:12 SC2086 quote to prevent globbing
#   SKIP: linter (no lint script in package.json)
#   SUMMARY: 2 PASS, 1 FAIL, 1 SKIP
#
# stderr: the full output of any check that failed.
#
# EXIT: 0 when nothing failed; 1 when any check FAILed.

set -euo pipefail

err() { echo "$@" >&2; }

SESSION_BASE=""
REPO_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-base) SESSION_BASE="${2:-}"; shift 2 ;;
    --repo-dir)     REPO_DIR="${2:-}"; shift 2 ;;
    -h|--help)      sed -n '2,25p' "$0" >&2; exit 0 ;;
    *)              err "unknown flag: $1"; exit 2 ;;
  esac
done

[[ -n "$REPO_DIR" && -e "$REPO_DIR/.git" ]] || { err "not a git repo: ${REPO_DIR:-(unset)}"; exit 2; }
cd "$REPO_DIR"

PASS=0; FAIL=0; SKIP=0
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
skip() { echo "SKIP: $*"; SKIP=$((SKIP + 1)); }

# ── What changed ─────────────────────────────────────────────────────
# Committed range plus uncommitted work plus untracked files. Untracked matters:
# a file the session created and never staged is invisible to `git diff HEAD`,
# and skipping it means a brand-new script goes unchecked while the run reports
# clean.
changed=""
if [[ -n "$SESSION_BASE" ]] && git rev-parse --verify "${SESSION_BASE}^{commit}" >/dev/null 2>&1; then
  changed="$(git diff --name-only "$SESSION_BASE" HEAD 2>/dev/null || true)"
fi
changed="$(printf '%s\n%s\n%s' \
  "$changed" \
  "$(git diff --name-only HEAD 2>/dev/null || true)" \
  "$(git ls-files --others --exclude-standard 2>/dev/null || true)" \
  | grep -v '^[[:space:]]*$' | sort -u || true)"

changed_matching() { [[ -n "$changed" ]] && grep -qE "$1" <<<"$changed"; }

# ── Tests ────────────────────────────────────────────────────────────
if [[ -f package.json ]] && grep -q '"test"[[:space:]]*:' package.json; then
  if out="$(npm test --silent 2>&1)"; then
    pass "tests (npm test)"
  else
    fail "tests (npm test) — see stderr"
    err "--- npm test ---"; err "$out"
  fi
else
  skip "tests (no test script in package.json)"
fi

# ── Linter ───────────────────────────────────────────────────────────
if [[ -f package.json ]] && grep -q '"lint"[[:space:]]*:' package.json; then
  if out="$(npm run lint --silent 2>&1)"; then
    pass "linter (npm run lint)"
  else
    fail "linter (npm run lint) — see stderr"
    err "--- npm run lint ---"; err "$out"
  fi
else
  skip "linter (no lint script in package.json)"
fi

# ── shellcheck, only on shell files this session touched ─────────────
if changed_matching '\.(sh|bash)$'; then
  if command -v shellcheck >/dev/null 2>&1; then
    sh_files="$(grep -E '\.(sh|bash)$' <<<"$changed" || true)"
    sh_out=""; sh_rc=0
    while IFS= read -r f; do
      [[ -n "$f" && -f "$f" ]] || continue
      if ! one="$(shellcheck -S warning "$f" 2>&1)"; then
        sh_rc=1
        sh_out="${sh_out}
${one}"
      fi
    done <<< "$sh_files"
    if [[ "$sh_rc" -eq 0 ]]; then
      pass "shellcheck ($(grep -c . <<<"$sh_files") file(s))"
    else
      fail "shellcheck — see stderr"
      err "--- shellcheck ---"; err "$sh_out"
    fi
  else
    skip "shellcheck (not installed)"
  fi
else
  skip "shellcheck (no shell files changed)"
fi

# ── The repo's own commit checks ─────────────────────────────────────
# These already exist and already encode this project's standards, so running
# them here catches a rejection before the commit rather than after.
if [[ -x .githooks/checks/check-secrets.sh ]]; then
  if out="$(bash .githooks/checks/check-secrets.sh 2>&1)"; then
    pass "secret scan"
  else
    fail "secret scan — see stderr"
    err "--- check-secrets ---"; err "$out"
  fi
else
  skip "secret scan (no .githooks/checks/check-secrets.sh)"
fi

echo "SUMMARY: ${PASS} PASS, ${FAIL} FAIL, ${SKIP} SKIP"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
