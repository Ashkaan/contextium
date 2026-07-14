#!/usr/bin/env bash
# check-secrets.sh — scan the staged diff for obvious secrets. Single source of
# truth for the secret scan, called by BOTH the Claude Code commit-gate hook and
# the tool-agnostic git pre-commit hook. Wires @rule:mechanisms-not-prose.
#
# Usage: check-secrets.sh   (no args; the git pre-commit hook runs it bare)
# Exit 0 = clean, 1 = a likely secret is staged.
set -uo pipefail

git rev-parse --git-dir >/dev/null 2>&1 || exit 0
diff="$(git diff --cached 2>/dev/null || true)"
[[ -n "$diff" ]] || exit 0

fail() { echo "pre-commit: $*" >&2; exit 1; }

if printf '%s' "$diff" | grep -qE -- '-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----'; then
  fail "staged diff contains a PRIVATE KEY. Remove it before committing."
fi
if printf '%s' "$diff" | grep -qE '\bAKIA[0-9A-Z]{16}\b'; then
  fail "staged diff contains an AWS access key id. Remove it before committing."
fi
if printf '%s' "$diff" | grep -qiE '(api[_-]?key|secret|token|password)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/_+=-]{24,}["'"'"']'; then
  fail "staged diff looks like it contains a hard-coded secret. Use a secrets manager or env var."
fi

exit 0
