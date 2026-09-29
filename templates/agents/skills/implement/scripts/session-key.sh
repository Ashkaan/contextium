#!/usr/bin/env bash
# session-key.sh — turn a raw harness session id into the single key used for
# BOTH the worktree directory name (`session-<key>`) and the session marker
# filename (`.claude-session-<key>`).
#
# Why this is one shared script and not a per-caller inline expression
# (single source of truth):
#   - The raw id reaches `find -name` in the marker lookup. An id containing a
#     glob metacharacter (`*`, `?`, `[`) would make that lookup match the WRONG
#     worktree, which silently routes a session's edits into another session's
#     tree — the exact corruption this whole mechanism exists to prevent.
#   - Ids like `cse_01HFo2Jk` carry uppercase and `_`, both of which fail
#     SLUG_REGEX, so setup-worktree.sh's slug gate would reject them.
# Create, detect, merge, and sweep all key off this one function, so they cannot
# disagree about which worktree belongs to which session.
#
# peers:
#   .agents/skills/implement/scripts/session-key.test.sh
#   .agents/skills/implement/scripts/setup-worktree.sh
#   .agents/skills/implement/scripts/session-write-root.sh
#
# Usage:
#   session-key.sh <raw-session-id>     — print the key on stdout
#   session-key.sh --max-key-len        — print MAX_KEY_LEN (SSOT for tests)
#
# Exit:
#   0 — key printed
#   2 — empty input, or input with no usable characters at all

set -euo pipefail

err() { echo "$@" >&2; }

# SLUG_REGEX (setup-worktree.sh) allows 64 chars total: 1 leading [a-z] + 63.
# The worktree name is "session-" + key, so the key ceiling is 64 - 8 = 56.
readonly SESSION_PREFIX="session-"
readonly MAX_KEY_LEN=56

if [[ "${1:-}" == "--max-key-len" ]]; then
  printf '%s\n' "$MAX_KEY_LEN"
  exit 0
fi

raw="${1:-}"

if [[ -z "$raw" ]]; then
  err "session-key: raw session id required"
  exit 2
fi

# Lowercase, then collapse every run of characters outside [a-z0-9-] into a
# single `-`. Doing it as one squeeze (rather than replace-then-collapse) keeps
# `a__b` and `a_b` mapping to the same `a-b`.
key="${raw,,}"
key="$(printf '%s' "$key" | tr -cs 'a-z0-9-' '-')"

# Collapse runs of `-` introduced by the squeeze meeting literal hyphens
# (`a_-_b` → `a---b` → `a-b`), then strip the ends.
while [[ "$key" == *--* ]]; do
  key="${key//--/-}"
done
key="${key#-}"
key="${key%-}"

if [[ -z "$key" ]]; then
  err "session-key: \"$raw\" has no characters usable in a slug"
  exit 2
fi

# ── Disambiguate whenever the mapping was lossy ────────────────────────────
# Sanitizing is many-to-one: `a_b`, `a__b`, and `a*b` all reduce to `a-b`, so
# three distinct sessions would share one marker name and one worktree — the
# exact index-sharing this mechanism exists to end, reintroduced by its own
# key function.
#
# So when the key is not byte-identical to the raw id, a short digest of the RAW
# id is appended, which makes the result injective again. When it IS identical —
# every normal UUID session id, which is already lowercase hex and hyphens —
# nothing is appended, so existing worktrees on disk keep resolving and the
# identity property the other callers rely on is preserved.
if [[ "$key" != "$raw" ]]; then
  digest="$(printf '%s' "$raw" | sha256sum | cut -c1-8)"
  # Reserve room for "-<8 hex>" inside the key ceiling before truncating.
  readable_max=$(( MAX_KEY_LEN - 9 ))
  if (( ${#key} > readable_max )); then
    key="${key:0:readable_max}"
    key="${key%-}"
  fi
  key="${key}-${digest}"
elif (( ${#key} > MAX_KEY_LEN )); then
  # Identical to the raw id but over the ceiling: truncation would ALSO be
  # lossy, so the same digest rule applies.
  digest="$(printf '%s' "$raw" | sha256sum | cut -c1-8)"
  readable_max=$(( MAX_KEY_LEN - 9 ))
  key="${key:0:readable_max}"
  key="${key%-}"
  key="${key}-${digest}"
fi

# Defensive: the composed name is what every caller actually uses, so validate
# THAT, not the key alone. A failure here is a bug in this script, not bad input.
composed="${SESSION_PREFIX}${key}"
if [[ ! "$composed" =~ ^[a-z][a-z0-9-]{0,63}$ ]]; then
  err "session-key: BUG — composed name \"$composed\" fails the slug regex"
  exit 2
fi

printf '%s\n' "$key"
