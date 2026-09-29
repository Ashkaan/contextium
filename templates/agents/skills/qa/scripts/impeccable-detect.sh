#!/usr/bin/env bash
# impeccable-detect.sh — run the design detector against a rendered page.
#
# Called from step-2.6 and again from step-2.7 after fixes. It exists as a
# script rather than as a shell block quoted twice in SKILL.md because the
# install guard below is a fact, and a fact copied into two prose blocks drifts
# (one fact, one file).
#
# WHAT IT RUNS. The npm shim on PATH (`impeccable`), not `npx --yes
# impeccable@latest` and not the arch-specific engine binary. The shim resolves
# the platform engine itself; hardcoding an arch directory would make this file
# responsible for a path it would then have to keep correct.
#
# CURRENCY. Impeccable's rules move, and a stale copy stops learning what they
# learn. So before each run this compares the installed version
# (`impeccable --version`) with the latest published one (`npm view impeccable
# version`) and runs `npm install -g impeccable@latest` when the copy is
# missing OR older. Not `npx impeccable@latest`: that re-downloads the package
# on every invocation. Offline, the installed copy runs and the line says the
# check could not happen. A failed upgrade runs the installed copy and says so;
# a failed first install is `detector unavailable`. QA_NO_INSTALL=1 forbids
# installing (CI, offline machines).
#
# ONE ARTIFACT. The engine that scans the page is resolved by the shim out of
# the CLI package (`require.resolve("@impeccable/cli-<platform>")`). Never run
# the package's own `install` verb: it writes skill folders, hook manifests and
# subagents into every harness home. Impeccable is a tool here, not a skill;
# this script touches only the npm package.
#
# CHECKED vs COULD-NOT-CHECK. The detector has never been a gate and still is
# not — a crash must not fail a QA run. But "scanned, found nothing" and "never
# ran" used to print as the same silence, which is the actual defect: a broken
# install read exactly like a clean page. This prints `impeccable: clean` only
# when the engine ran and returned nothing, and `impeccable: detector
# unavailable — <reason>` on every path where it did not run.
#
# Usage: impeccable-detect.sh <target-repo> <url>
# Exit: always 0 — the caller is a non-gating step.

set -uo pipefail

TARGET="${1:?usage: impeccable-detect.sh <target-repo> <url>}"
URL="${2:?usage: impeccable-detect.sh <target-repo> <url>}"


unavailable() { echo "impeccable: detector unavailable — $1"; exit 0; }

# semver_lt A B — true when version A is older than B. Numeric per field
# (4.10.0 is newer than 4.9.0); a pre-release suffix is ignored.
semver_lt() {
  local a="${1%%[-+]*}" b="${2%%[-+]*}" i x y
  local IFS=.
  # shellcheck disable=SC2206  # split on dots, on purpose
  local -a av=($a) bv=($b)
  for i in 0 1 2; do
    x="${av[$i]:-0}"; y="${bv[$i]:-0}"
    x="${x//[!0-9]/}"; y="${y//[!0-9]/}"
    [ "${x:-0}" -lt "${y:-0}" ] && return 0
    [ "${x:-0}" -gt "${y:-0}" ] && return 1
  done
  return 1
}

installed_version() {
  impeccable --version 2>/dev/null | head -1 | sed -n 's/[^0-9]*\([0-9][0-9]*\(\.[0-9][0-9]*\)*\).*/\1/p'
}

install_latest() {
  [ "${QA_NO_INSTALL:-}" != "1" ] || return 1
  command -v npm >/dev/null 2>&1 || return 1
  npm install -g impeccable@latest >&2 2>&1
}

# ── The shim ──────────────────────────────────────────────────────────────
# Missing shim is the fresh-machine bootstrap case: nothing is installed at all.
latest="$(npm view impeccable version 2>/dev/null | tail -1)" || latest=""
if ! command -v impeccable >/dev/null 2>&1; then
  [ "${QA_NO_INSTALL:-}" != "1" ] || unavailable "not installed and QA_NO_INSTALL=1"
  echo "impeccable: shim not on PATH — installing" >&2
  install_latest || unavailable "npm install -g impeccable@latest failed"
  command -v impeccable >/dev/null 2>&1 || unavailable "npm install succeeded but no impeccable on PATH"
else
  have="$(installed_version)"
  if [ -z "$latest" ]; then
    echo "impeccable: could not read the latest version (npm view failed) — running ${have:-the installed copy}"
  elif [ -n "$have" ] && semver_lt "$have" "$latest"; then
    echo "impeccable: $have is older than the latest $latest — upgrading"
    if ! install_latest || semver_lt "$(installed_version)" "$latest"; then
      echo "impeccable: upgrade to $latest failed — running $(installed_version)"
    fi
  fi
fi

# ── Detect ────────────────────────────────────────────────────────────────
# cwd = target repo so its .impeccable ignore config (read from cwd) applies.
# CI=1 passes --no-sandbox — hosts that block Chrome's sandbox (containers, some
# Linux servers) abort the browser engine on launch without it.
#
# 2>&1 because the engine writes human-readable findings to STDERR, keeping
# stdout free for --json. Dropping stderr here would throw away every finding
# and print a confident empty result.
out="$( cd "${TARGET}" && CI=1 impeccable detect "${URL}" 2>&1 )"
rc=$?

# The exit codes, measured against the engine rather than taken from --help,
# which documents only 0 and 1:
#
#   0  scanned, no primary findings
#   1  a requested target could not be scanned
#   2  scanned, FOUND anti-patterns          ← not documented, and non-zero
#
# That third one is why this is a case statement and not `if rc -ne 0`. Treating
# every non-zero as a failure reports real contrast and text-size findings as
# "detector unavailable" — the exact inversion this script exists to prevent,
# and worse than silence.
case $rc in
  0)
    if [ -z "${out//[[:space:]]/}" ]; then
      echo "impeccable: clean"
    else
      # Advisory-only findings land here: listed, never counted, exit stays 0.
      echo "${out}" | tail -80
      echo "impeccable: clean (advisories only)"
    fi
    ;;
  2)
    echo "${out}" | tail -80
    ;;
  *)
    [ -n "${out//[[:space:]]/}" ] && echo "${out}" | tail -80
    unavailable "detect exited ${rc}"
    ;;
esac
exit 0
