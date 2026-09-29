#!/usr/bin/env bash
# layer-2.sh — Layer 2 of /implement Phase 4 (unit + integration tests).
#
# Reads newline-separated file list from stdin. Groups the files by PACKAGE —
# the nearest folder above each one holding a package.json or a Makefile — and
# runs each package's tests, by convention, with no settings file:
#   the `test` npm script, else the `make test` target, else `node --test` over
#   the package's `*.test.{ts,js,mjs,cjs}` files where they sit.
# A file under `integrations/<name>/` or `packages/<name>/` with no package
# above it runs that folder's test files in place the same way.
#
# The in-place branch closes a hole, not a nicety: a layer that prints
# `WARN … skip` for a library with no test script reports PASS over test files
# it never executed.
#
# peers: layer-1.sh, layer-3.sh
#
# Output (stdout, TAP-ish):
#   PASS: layer-2 (no tests in scope)
#   PASS: layer-2 apps/foo (npm test)
#   PASS: layer-2 integrations/bar (N tests)
#   FAIL: layer-2 apps/foo — see stderr
#
# Exit:
#   0  all PASS
#   1  any FAIL

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

# The unit that owns a repo-relative path: its package, else its
# integrations/<name> or packages/<name> folder, else nothing. Markdown and the
# records folders own no tests.
unit_of() {
  local d
  case "$1" in
    *.md|journal/*|projects/*|knowledge/*|decisions/*) return 0 ;;
  esac
  d="$(dirname "$1")"
  while :; do
    if [[ -f "$d/package.json" || -f "$d/Makefile" ]]; then printf '%s\n' "$d"; return 0; fi
    [[ "$d" == "." || "$d" == "/" ]] && break
    d="$(dirname "$d")"
  done
  case "$1" in
    integrations/*/*|packages/*/*) printf '%s\n' "$(printf '%s' "$1" | cut -d/ -f1-2)" ;;
  esac
}

UNITS="$(for f in ${files[@]+"${files[@]}"}; do unit_of "$f"; done | LC_ALL=C sort -u)"
if [[ -z "$UNITS" ]]; then
  echo "PASS: layer-2 (no tests in scope)"
  exit 0
fi

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

any_fail=0

# Run test files in place, with no bundle.
#
# --experimental-test-module-mocks is NOT optional: without it a file calling
# mock.module() dies with "mock.module is not a function" and is reported as a
# FAILING TEST, which reads as a regression.
#
# --preserve-symlinks{,-main} because the skills a harness reads are often a
# symlink into the workbench, and a test reached through it must resolve its
# repo imports relative to the link, not the target.
run_tests_in_place() {
  local label="$1"; shift
  if node --test --experimental-strip-types --experimental-test-module-mocks \
       --preserve-symlinks --preserve-symlinks-main "$@" > /tmp/layer2-out.$$ 2>&1; then
    echo "PASS: layer-2 $label ($# tests)"
  else
    echo "FAIL: layer-2 $label"
    head -c 10240 /tmp/layer2-out.$$ >&2
    any_fail=1
  fi
  rm -f /tmp/layer2-out.$$
}

while IFS= read -r unit; do
  [[ -n "$unit" ]] || continue
  label="${unit#./}"; [[ "$unit" == "." ]] && label="(root)"
  cmd=""
  if declares_script "$unit" test; then cmd="npm test --silent"
  elif has_target "$unit" test; then cmd="make --no-print-directory test"; fi
  if [[ -n "$cmd" ]]; then
    # The package owns its own test script — its answer, not a guess.
    # shellcheck disable=SC2086  # cmd is a fixed word list built above
    if (cd "$unit" && $cmd 2>&1) > /tmp/layer2-out.$$ 2>&1; then
      echo "PASS: layer-2 $label (${cmd%% *} test)"
    else
      echo "FAIL: layer-2 $label"
      head -c 10240 /tmp/layer2-out.$$ >&2
      any_fail=1
    fi
    rm -f /tmp/layer2-out.$$
    continue
  fi
  unit_tests=()
  while IFS= read -r t; do
    [[ -n "$t" ]] && unit_tests+=("$t")
  done < <(find "$unit" -type f \( -name "*.test.ts" -o -name "*.test.js" -o -name "*.test.mjs" -o -name "*.test.cjs" \) \
             -not -path "*/node_modules/*" 2>/dev/null | LC_ALL=C sort)
  if [[ ${#unit_tests[@]} -eq 0 ]]; then
    echo "PASS: layer-2 $label (no tests in scope)"
    continue
  fi
  run_tests_in_place "$label" "${unit_tests[@]}"
done <<<"$UNITS"

[[ $any_fail -eq 0 ]]
