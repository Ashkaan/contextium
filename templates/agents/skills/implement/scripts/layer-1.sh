#!/usr/bin/env bash
# layer-1.sh — Layer 1 of /implement Phase 4 (syntactic: lint, then typecheck).
#
# Reads newline-separated file list from stdin (output of resolve-scope.sh).
# Groups the files by PACKAGE — the nearest folder above each one that holds a
# package.json or a Makefile — and runs, by convention, with no settings file:
#   lint       the package's `lint` npm script, else its `make lint` target
#   typecheck  its `typecheck` or `check` npm script, else `make typecheck` /
#              `make check`
# A step a package does not declare is a WARN line and skipped, never a FAIL:
# a missing script is a gap in the package, not a defect this session made.
#
# Early-fail: if lint fails anywhere, do NOT typecheck — Layer 1 gates
# subsequent layers, and type errors mask runtime errors.
#
# Markdown and the records folders (journal/, projects/, knowledge/,
# decisions/) never select a package. A DELETED path still selects its package:
# deleting a file is exactly when you want its package checked.
#
# peers: resolve-scope.sh, layer-2.sh, layer-3.sh
#
# Output (stdout, TAP-ish):
#   PASS: layer-1 lint (apps/foo)
#   PASS: layer-1 typecheck (apps/foo)
#   WARN: layer-1 typecheck (tools/gen) — no typecheck/check script or make target; skipped
#   FAIL: layer-1 lint (apps/foo)             (its output on stderr)
#
# Exit:
#   0  all PASS (WARNs included)
#   1  any FAIL within layer

set -euo pipefail

err() { echo "$@" >&2; }

# Fix B: CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall
# back to git when unset (some callers leave it unset). Keep `|| true`
# inside the substitution so a failing rev-parse outside a repo doesn't trip
# `set -e` (exit 128) before the guard surfaces the documented exit code.
REPO_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$REPO_DIR" ]] || { err "CLAUDE_PROJECT_DIR unset and not inside a git repo"; exit 1; }
cd "$REPO_DIR"

# A read loop, not `mapfile`, which bash 3.2 (macOS) does not have.
files=()
while IFS= read -r f; do
  [[ -n "$f" ]] && files+=("$f")
done < <(grep -v '^$' || true)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "PASS: layer-1 (0 files)"
  exit 0
fi

# The package that owns a repo-relative path, or nothing.
pkg_of() {
  local d
  case "$1" in
    *.md|journal/*|projects/*|knowledge/*|decisions/*) return 0 ;;
  esac
  d="$(dirname "$1")"
  while :; do
    if [[ -f "$d/package.json" || -f "$d/Makefile" ]]; then printf '%s\n' "$d"; return 0; fi
    [[ "$d" == "." || "$d" == "/" ]] && return 0
    d="$(dirname "$d")"
  done
}

PKGS="$(for f in ${files[@]+"${files[@]}"}; do pkg_of "$f"; done | LC_ALL=C sort -u)"
if [[ -z "$PKGS" ]]; then
  echo "PASS: layer-1 (no package in scope)"
  exit 0
fi

# Does this package's OWN package.json declare the script? Read as JSON, not
# grepped: "lint" appearing in a dependency name would match a grep.
declares_script() {
  [[ -f "$1/package.json" ]] || return 1
  node -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit((p.scripts || {})[process.argv[2]] ? 0 : 1);
    } catch { process.exit(1); }
  ' "$1/package.json" "$2" 2>/dev/null
}
has_target() { [[ -f "$1/Makefile" ]] && grep -qE "^$2[[:space:]]*:" "$1/Makefile"; }

# run_step <step> <candidate names...> — every package; 1 when any FAILs.
run_step() {
  local step="$1" pkg label cmd cand out rc=0
  shift
  while IFS= read -r pkg; do
    [[ -n "$pkg" ]] || continue
    label="${pkg#./}"; [[ "$pkg" == "." ]] && label="(root)"
    cmd=""
    for cand in "$@"; do declares_script "$pkg" "$cand" && { cmd="npm run --silent $cand"; break; }; done
    if [[ -z "$cmd" ]]; then
      for cand in "$@"; do has_target "$pkg" "$cand" && { cmd="make --no-print-directory $cand"; break; }; done
    fi
    if [[ -z "$cmd" ]]; then
      echo "WARN: layer-1 $step ($label) — no $(printf '%s/' "$@" | sed 's#/$##') script or make target; skipped"
      continue
    fi
    # shellcheck disable=SC2086  # cmd is a fixed word list built above
    if out="$(cd "$pkg" && $cmd 2>&1)"; then
      echo "PASS: layer-1 $step ($label)"
    else
      echo "FAIL: layer-1 $step ($label)"
      printf '%s\n' "$out" | head -c 10240 >&2
      rc=1
    fi
  done <<<"$PKGS"
  return "$rc"
}

# ── lint, then typecheck ─────────────────────────────────────────────
run_step lint lint || exit 1        # early-fail: lint gates typecheck
run_step typecheck typecheck check
