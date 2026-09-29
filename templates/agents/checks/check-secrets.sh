#!/usr/bin/env bash
# check-secrets.sh — scan a change for obvious secrets: a private key block, a
# cloud access key id, a hard-coded token. The single copy of the scan; land.sh
# runs it before it commits (AGENTS.md § Standards → Fix lint at the source
# holds for what it finds: remove the secret, never exclude the file).
#
# Usage:
#   check-secrets.sh                 the staged diff
#   check-secrets.sh --since <ref>   everything this branch changed since it
#                                    left <ref>, committed or not, plus
#                                    untracked files — what a close will commit
# Exit: 0 clean · 1 a likely secret · 2 caller error
set -uo pipefail

git rev-parse --git-dir >/dev/null 2>&1 || exit 0

fail() { echo "check-secrets: $*" >&2; exit 1; }

# A diff git cannot produce is an error, never an empty (clean) change.
unreadable() { echo "check-secrets: could not read the change ($1), so it was not scanned" >&2; exit 2; }

if [[ "${1:-}" == "--since" ]]; then
  [[ -n "${2:-}" ]] || { echo "check-secrets: --since needs a ref" >&2; exit 2; }
  base="$(git merge-base HEAD "$2" 2>/dev/null)" || { echo "check-secrets: cannot find where HEAD left $2" >&2; exit 2; }
  diff="$(git diff "$base")" || unreadable "git diff $base"
  untracked="$(git ls-files -z --others --exclude-standard | tr '\0' '\n')" || unreadable "git ls-files"
  while IFS= read -r f; do
    [[ -n "$f" && -f "$f" ]] || continue
    body="$(sed 's/^/+/' "$f")" || unreadable "$f"
    diff="$diff"$'\n'"$body"
  done <<<"$untracked"
else
  diff="$(git diff --cached)" || unreadable "git diff --cached"
fi
# Only the lines the change ADDS: a removed line is the fix for a leak, and a
# context line was there before this change.
diff="$(printf '%s\n' "$diff" | grep '^+' | grep -vE '^\+\+\+ (b/|/dev/null)' || true)"
[[ -n "$diff" ]] || exit 0

if printf '%s' "$diff" | grep -qE -- '-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----'; then
  fail "the change contains a PRIVATE KEY. Remove it before committing."
fi
if printf '%s' "$diff" | grep -qE '\bAKIA[0-9A-Z]{16}\b'; then
  fail "the change contains an AWS access key id. Remove it before committing."
fi
if printf '%s' "$diff" | grep -qiE '(api[_-]?key|secret|token|password)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/_+=-]{24,}["'"'"']'; then
  fail "the change looks like it contains a hard-coded secret. Use a secrets manager or env var."
fi

exit 0
