#!/usr/bin/env bash
# impeccable-detect.test.sh — the install/upgrade guard and the output contract
# of impeccable-detect.sh, against stub `impeccable` and `npm` binaries on a
# PATH that holds nothing else (a real impeccable on the machine must not leak
# in). Offline; nothing is installed.
#
# Run: bash .agents/skills/qa/scripts/tests/impeccable-detect.test.sh
#
# peers:
#   .agents/skills/qa/scripts/impeccable-detect.sh

set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/impeccable-detect.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
has() { # has <label> <needle> <haystack>
  if grep -qF -- "$2" <<<"$3"; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL: $1"; echo "  missing : [$2]"; echo "  in      : [$3]"; fi
}
hasnt() { # hasnt <label> <needle> <haystack>
  if ! grep -qF -- "$2" <<<"$3"; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL: $1"; echo "  unwanted: [$2]"; echo "  in      : [$3]"; fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/impeccable-detect-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo"

# setup [installed-version|none] — a fresh PATH and state for one case.
# State files: latest (npm view's answer; absent = npm view fails),
# install_fail (npm install fails when present), rc + out (what detect does),
# calls (every npm invocation, one per line).
setup() {
  rm -rf "${TMP:?}/bin" "${TMP:?}/state"; mkdir -p "$TMP/bin" "$TMP/state"
  for tool in bash sed head tail cat chmod grep; do ln -s "$(command -v "$tool")" "$TMP/bin/$tool"; done
  echo 0 >"$TMP/state/rc"; : >"$TMP/state/out"; : >"$TMP/state/calls"
  [[ "$1" == none ]] || make_impeccable "$1"
  cat >"$TMP/bin/npm" <<NPM
#!$(command -v bash)
S="$TMP/state"
echo "\$*" >>"\$S/calls"
if [[ "\$1" == view ]]; then [[ -f "\$S/latest" ]] || exit 1; cat "\$S/latest"; exit 0; fi
if [[ "\$1" == install ]]; then
  [[ -f "\$S/install_fail" ]] && { echo "npm ERR! EACCES" >&2; exit 1; }
  bash "$TMP/make-impeccable" "\$(cat "\$S/latest" 2>/dev/null || echo 9.9.9)"; exit 0
fi
exit 1
NPM
  chmod +x "$TMP/bin/npm"
}
cat >"$TMP/make-impeccable" <<MAKE
#!/usr/bin/env bash
cat >"$TMP/bin/impeccable" <<STUB
#!$(command -v bash)
if [[ "\\\$1" == --version ]]; then echo "\$1"; exit 0; fi
if [[ "\\\$1" == detect ]]; then cat "$TMP/state/out" >&2; exit "\\\$(cat "$TMP/state/rc")"; fi
exit 1
STUB
chmod +x "$TMP/bin/impeccable"
MAKE
make_impeccable() { bash "$TMP/make-impeccable" "$1"; }
run() { PATH="$TMP/bin" bash "$SUT" "$TMP/repo" "http://localhost:1/" 2>&1; echo "rc=$?"; }
calls() { tr '\n' ';' <"$TMP/state/calls" 2>/dev/null; }

# 1. Current version: no install, the detector runs, a clean page says clean.
setup 4.1.0; echo 4.1.0 >"$TMP/state/latest"
out="$(run)"
t "current: the last line is the exit" "rc=0" "$(tail -1 <<<"$out")"
has "current: a clean page prints clean" "impeccable: clean" "$out"
t "current: npm only asked for the latest version" "view impeccable version;" "$(calls)"

# 2. Older than the latest: upgraded, then run.
setup 4.0.2; echo 4.1.0 >"$TMP/state/latest"
out="$(run)"
has "older: says what it is doing" "impeccable: 4.0.2 is older than the latest 4.1.0 — upgrading" "$out"
has "older: installs the latest" "install -g impeccable@latest" "$(calls)"
has "older: then runs the detector" "impeccable: clean" "$out"

# 2b. A numeric compare, not a string one: 4.10.0 is newer than 4.9.0.
setup 4.10.0; echo 4.9.0 >"$TMP/state/latest"
out="$(run)"
hasnt "4.10.0 is not older than 4.9.0" "upgrading" "$out"

# 3. Missing: installed, then run.
setup none; echo 4.1.0 >"$TMP/state/latest"
out="$(run)"
has "missing: installs" "install -g impeccable@latest" "$(calls)"
has "missing: then runs the detector" "impeccable: clean" "$out"

# 4. Missing and the install fails: a skip, said plainly, never clean.
setup none; echo 4.1.0 >"$TMP/state/latest"; : >"$TMP/state/install_fail"
out="$(run)"
has "missing + install fails: unavailable" "impeccable: detector unavailable — npm install -g impeccable@latest failed" "$out"
hasnt "missing + install fails: never clean" "impeccable: clean" "$out"
t "missing + install fails: still exit 0 (non-gating)" "rc=0" "$(tail -1 <<<"$out")"

# 5. Offline: the latest version cannot be read — run what is installed, and say so.
setup 4.0.2
out="$(run)"
has "offline: says the check could not run" "impeccable: could not read the latest version (npm view failed) — running 4.0.2" "$out"
hasnt "offline: no install attempted" "install" "$(calls)"
has "offline: the detector still runs" "impeccable: clean" "$out"

# 6. Older and the upgrade fails: run the old one, and say which.
setup 4.0.2; echo 4.1.0 >"$TMP/state/latest"; : >"$TMP/state/install_fail"
out="$(run)"
has "upgrade fails: named" "impeccable: upgrade to 4.1.0 failed — running 4.0.2" "$out"
has "upgrade fails: the detector still runs" "impeccable: clean" "$out"

# 7. QA_NO_INSTALL=1 forbids installing.
setup none; echo 4.1.0 >"$TMP/state/latest"
out="$(QA_NO_INSTALL=1 run)"
has "QA_NO_INSTALL + missing: unavailable" "impeccable: detector unavailable — not installed and QA_NO_INSTALL=1" "$out"
hasnt "QA_NO_INSTALL: npm install never called" "install" "$(calls)"

# 8. Findings (exit 2) are printed, and not called clean.
setup 4.1.0; echo 4.1.0 >"$TMP/state/latest"; echo 2 >"$TMP/state/rc"
echo "low-contrast: #999 on #fff at .hero p" >"$TMP/state/out"
out="$(run)"
has "findings: printed" "low-contrast: #999 on #fff" "$out"
hasnt "findings: not clean" "impeccable: clean" "$out"

# 9. A detector crash (exit 1) is unavailable, not clean.
setup 4.1.0; echo 4.1.0 >"$TMP/state/latest"; echo 1 >"$TMP/state/rc"
out="$(run)"
has "crash: unavailable with the code" "impeccable: detector unavailable — detect exited 1" "$out"

echo "impeccable-detect.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
