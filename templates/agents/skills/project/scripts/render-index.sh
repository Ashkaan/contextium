#!/usr/bin/env bash
# render-index.sh
#
# The ENTIRE blank-mode `/project` render, as finished markdown on stdout:
#
#   1. the compact priority-sorted project index (project-index.generate.ts)
#   2. the lapsed-monitor-window block (check-staleness.sh --expired-only),
#      already turned into prose lines — not the raw EXPIRED:/NOWINDOW: rows
#   3. the closing "which one to start?" prompt
#
# WHY THIS EXISTS: blank-mode /project has no judgment in it. As two Bash
# calls, their output had to be re-assembled and re-typed into the agent's
# reply — a long skill read plus kilobytes of verbatim retyping, for two
# scripts that together cost half a second. This composes them once so the render is a
# copy (or a plain terminal command with no model in the loop at all).
#
# Composition only: no formatting decision lives here that was not already
# specified in SKILL.md § "Lapsed monitor windows". Zero lapsed windows print
# NOTHING — the block's absence is the all-clear.
#
# Usage:
#   .agents/skills/project/scripts/render-index.sh
#
# Exit code: 0 unless the index generator itself fails (then its status).
#
# peers:
#   .agents/generators/project-index.generate.ts
#   .agents/skills/project/scripts/check-staleness.sh
#   .agents/skills/project/scripts/render-index.test.sh
#   .agents/skills/project/SKILL.md  (step-0.5-render-index + scripts table)

set -euo pipefail

# ONE CHECKOUT FOR BOTH HALVES. The generator indexes the projects of the repo
# it sits in, and check-staleness.sh scans the session's write root. Run from
# the skills home link (the landed checkout) while a session writes in its own
# worktree, taking the generator from THIS script's repo would render one tree's
# index above another tree's lapsed windows. So the root is resolved once,
# through the same resolver check-staleness.sh uses, and both halves read it:
# the generator is that root's `.agents/generators/`, and the scan is pinned to
# it with CONTEXT_WRITE_ROOT. `--no-create`: rendering the index is not a
# reason to create a worktree. CONTEXT_CODE_REPO overrides the root, for a test.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_REPO="${CONTEXT_CODE_REPO:-$(bash "$SCRIPT_DIR/../../implement/scripts/session-write-root.sh" --no-create 2>/dev/null || true)}"
if [[ -z "$CODE_REPO" ]]; then
  echo "render-index: could not resolve the session's write root (set CONTEXT_CODE_REPO)" >&2
  exit 1
fi
GENERATOR="$CODE_REPO/.agents/generators/project-index.generate.ts"
if [[ ! -f "$GENERATOR" ]]; then
  echo "render-index: no project-index generator at $GENERATOR (set CONTEXT_CODE_REPO)" >&2
  exit 1
fi
cd "$CODE_REPO" || exit 1

# The generator is TypeScript: Node runs it from 22.6 on (with
# `--experimental-strip-types`; newer Node strips types by default and still
# accepts the flag). An older Node would fail with a parser error, so the floor
# is checked here and named.
NODE_V="$(node --version 2>/dev/null || true)"
_nv="${NODE_V#v}"; _maj="${_nv%%.*}"; _rest="${_nv#*.}"; _min="${_rest%%.*}"
if ! [[ "$_maj" =~ ^[0-9]+$ && "$_min" =~ ^[0-9]+$ ]] || [[ "$_maj" -lt 22 ]] || [[ "$_maj" -eq 22 && "$_min" -lt 6 ]]; then
  echo "render-index: blank /project needs Node 22.6 or newer to run the index generator (found ${NODE_V:-no node})" >&2
  exit 1
fi
# A non-zero exit still carries a view worth showing: the generator names the
# projects it could not read on its first line and renders the rest. Print that
# and stop, so /project shows the warning and the partial index rather than
# nothing at all.
INDEX_RC=0
INDEX=$(node --experimental-strip-types "$GENERATOR" --compact) || INDEX_RC=$?
if [[ "$INDEX_RC" -ne 0 ]]; then
  # Only a render whose first line is the generator's drop line is a partial
  # index worth showing; anything else is an error, and its output is not an
  # index however it looks.
  if [[ "$(printf '%s\n' "$INDEX" | head -n 1)" == '**'*' project(s) could not be read'* ]]; then
    printf '%s\n' "$INDEX"
    echo "render-index: the project index is incomplete (generator exit $INDEX_RC) — see the first line above" >&2
  else
    echo "render-index: the project index generator failed (exit $INDEX_RC)" >&2
  fi
  exit "$INDEX_RC"
fi

# `Completed — N` sits LAST in the finished render, below Lapsed, so it is held
# back here and re-printed at the end. The generator emits it as its own final
# line; that positional coupling is CHECKED rather than assumed — a generator
# change that moves or renames the line fails loud instead of silently dropping
# the count or splitting the Monitoring table in half.
COMPLETED=$(printf '%s\n' "$INDEX" | tail -n 1)
if [[ "$COMPLETED" != '**Completed — '* ]]; then
  echo "render-index: expected the generator's last line to be the Completed heading, got: $COMPLETED" >&2
  exit 1
fi
printf '%s\n' "$INDEX" | sed '$d'

# Newest lapse LAST, so the block reads oldest-neglect-first; windows with no
# date at all sort after every dated one (they have no lapse age to rank by).
LAPSED=$(
  CONTEXT_WRITE_ROOT="$CODE_REPO" bash "$SCRIPT_DIR/check-staleness.sh" --expired-only |
    awk -F: '
      /^EXPIRED:/ {
        split($3, u, "=")
        split($4, d, "=")
        printf "%d\t- %s — ended %s (%s days ago)\n", d[2], $2, u[2], d[2]
      }
      /^NOWINDOW:/ {
        printf "-1\t- %s — monitor with no monitoring-until date\n", $2
      }
    ' | sort -rn | cut -f2-
) || {
  # `set -o pipefail` above makes the substitution carry check-staleness.sh's
  # exit; without this an empty LAPSED from a failed scan rendered as "no lapsed
  # projects" and the index shipped without them.
  echo "render-index: check-staleness.sh --expired-only failed; not rendering a lapsed list from nothing" >&2
  exit 1
}

# Zero lapsed prints NOTHING — no heading, no all-clear line.
if [[ -n "$LAPSED" ]]; then
  # shellcheck disable=SC2016  # backticks here are markdown code spans, not command substitution
  printf '**Lapsed — %d**\n%s\n\n`/project <slug>` to close or extend.\n\n' \
    "$(printf '%s\n' "$LAPSED" | wc -l)" "$LAPSED"
fi

printf '%s\n' "$COMPLETED"

# shellcheck disable=SC2016  # backticks here are markdown code spans, not command substitution
printf '\nWhich one to start? Type `/project [slug]`.\n'
