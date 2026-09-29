#!/usr/bin/env bash
# shellcheck disable=SC2016  # stub bodies and fixtures are single-quoted on purpose: they expand when the stub runs, not here
# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
# caller-contract.eval.test.sh — peer of caller-contract.eval.sh. Run: bash .agents/skills/review/evals/caller-contract.eval.test.sh
#
# Pins the eval's own machinery without spending its vendor call: the two-commit
# fixture it assembles, the `--pack-only` half (the blast-radius pack names the
# untouched caller), and the three grades of the rerun — PASS when the review
# names the caller, FAIL when it does not, INCONCLUSIVE when the chain never
# answers. The reviewer is a stub: `CODEX_BIN`/`GROK_BIN` point at a script
# that dumps the prompt it was handed and prints whatever this suite told it to,
# a fixture policy and resolver keep policy-chain.sh off the live catalog, and
# `codex`/`grok` on PATH are stubs that exit 1 so nothing real can be reached
# even if an override were ignored. The eval is run as a subprocess, never
# sourced.
set -uo pipefail
# `timeout` is GNU coreutils, absent on stock macOS. perl stands in, and like
# GNU timeout it runs the command in its own process group and kills the whole
# group at the deadline: a child left alive would hold the output pipe open.
tmo() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"; return; fi
  perl -e 'my $t = shift; my $p = fork; die "fork: $!" unless defined $p;
    if (!$p) { setpgrp(0, 0); exec @ARGV or exit 127 }
    $SIG{ALRM} = sub { kill "KILL", -$p; exit 124 }; alarm $t; waitpid($p, 0);
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$@"
}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/caller-contract.eval.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d)" || exit 1; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
for v in codex grok; do
  printf '#!/usr/bin/env bash\necho "%s stub on PATH: refused $*" >&2\nexit 1\n' "$v" >"$tmp/bin/$v"
done
chmod +x "$tmp/bin/codex" "$tmp/bin/grok"
export PATH="$tmp/bin:$PATH"

cat >"$tmp/policy.json" <<'EOF'
{
  "rows": {
    "adversarial-review": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    }
  }
}
EOF
printf '#!/usr/bin/env bash\necho "$2"\n' >"$tmp/resolve-model.sh"
chmod +x "$tmp/resolve-model.sh"

# The reviewer under this suite's control: dumps its prompt to SEEN, counts its
# calls, then prints REPLY (or exits 1 when REPLY is absent).
SEEN="$tmp/seen.txt"; CALLS="$tmp/calls"; REPLY="$tmp/reply.txt"
cat >"$tmp/reviewer.sh" <<EOF
#!/usr/bin/env bash
cat >"$SEEN"
echo x >>"$CALLS"
[[ -f "$REPLY" ]] || exit 1
cat "$REPLY"
EOF
chmod +x "$tmp/reviewer.sh"
export POLICY_JSON="$tmp/policy.json" POLICY_CHAIN_RESOLVER="$tmp/resolve-model.sh"
export CODEX_BIN="$tmp/reviewer.sh" GROK_BIN="$tmp/reviewer.sh"

run() { rm -f "$SEEN" "$CALLS"; tmo 300 bash "$SUT" "$@" >"$tmp/stdout" 2>"$tmp/stderr"; echo $?; }
calls() { [[ -f "$CALLS" ]] && wc -l <"$CALLS" | tr -d ' ' || echo 0; }
out_has() { grep -qF -- "$1" "$tmp/stdout" && echo yes || { echo "missing: $1"; sed 's/^/    stdout: /' "$tmp/stdout" | head -8; }; }
err_has() { grep -qF -- "$1" "$tmp/stderr" && echo yes || { echo "missing: $1"; sed 's/^/    stderr: /' "$tmp/stderr" | head -8; }; }
seen_has() { grep -qF -- "$1" "$SEEN" && echo yes || echo "missing from prompt: $1"; }

# ── 1. --pack-only: the deterministic half, no reviewer reached ───────────
rc="$(run --pack-only)"
t "pack-only exits 0" 0 "$rc"
t "pack-only reports the pack naming the caller" yes "$(out_has "PASS: the pack names src/consumer.ts as a caller of getUser")"
t "pack-only says no vendor call was spent" yes "$(out_has "caller-contract: PASS (pack-only; no vendor call spent)")"
t "pack-only never calls the reviewer" 0 "$(calls)"
t "pack-only leaves the rerun banner unprinted" "" "$(grep -F "spending one vendor call" "$tmp/stdout")"

# ── 2. the rerun, reviewer names the caller ───────────────────────────────
printf '[must-fix] src/consumer.ts:4 greet() still calls getUser(id) with one argument — pass a LookupOptions — throws on options.includeArchived\n' >"$REPLY"
rc="$(run)"
t "a review naming the caller grades PASS (exit 0)" 0 "$rc"
t "the PASS line names the broken caller" yes "$(out_has "caller-contract: PASS — the review named the broken caller.")"
t "the review stdout is echoed for the reader" yes "$(out_has "--- review stdout ---")"
t "the reviewer was called once" 1 "$(calls)"
t "the prompt the reviewer saw carried the untouched caller by name" yes "$(seen_has "src/consumer.ts")"
t "the prompt carried the changed signature" yes "$(seen_has "options: LookupOptions")"
t "the pack half still ran first" yes "$(out_has "PASS: the pack names src/consumer.ts as a caller of getUser")"

# A mention in passing is enough: the grade is about what reached the prompt.
printf '[nit] consumer greeting text could be friendlier\nNO_FINDINGS\n' >"$REPLY"
rc="$(run)"
t "a passing mention of the caller still grades PASS" 0 "$rc"

# ── 3. the rerun, reviewer misses the caller ──────────────────────────────
printf 'NO_FINDINGS\n' >"$REPLY"
rc="$(run)"
t "a clean review grades FAIL (exit 1)" 1 "$rc"
t "the FAIL names the file the review missed" yes "$(err_has "caller-contract: FAIL — the review did not name src/consumer.ts.")"
t "the FAIL warns that one miss is one sample" yes "$(err_has "a single miss is one sample, not a regression.")"
t "the reviewer was still called" 1 "$(calls)"
printf '[should-fix] src/api.ts:10 the option should default to false\n' >"$REPLY"
rc="$(run)"
t "a finding about the changed file alone is still FAIL" 1 "$rc"

# ── 4. the rerun, no reviewer answers ─────────────────────────────────────
rm -f "$REPLY"
rc="$(run)"
t "an exhausted chain grades INCONCLUSIVE (exit 2), not FAIL" 2 "$rc"
t "INCONCLUSIVE says the review did not complete" yes "$(err_has "INCONCLUSIVE: the review did not complete")"
t "INCONCLUSIVE says it is not a failing grade" yes "$(err_has "failing grade")"
t "both chain slots were tried before giving up" 2 "$(calls)"
t "no PASS line was printed for the rerun" "" "$(grep -F "the review named" "$tmp/stdout")"

# ── 5. the fixture is rebuilt fresh each run and cleaned up ───────────────
before="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'caller-contract-eval-*' 2>/dev/null | wc -l | tr -d ' ')"
rc="$(run --pack-only)"
after="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'caller-contract-eval-*' 2>/dev/null | wc -l | tr -d ' ')"
t "the scratch repo is removed on exit" "$before" "$after"

echo "caller-contract.eval.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
