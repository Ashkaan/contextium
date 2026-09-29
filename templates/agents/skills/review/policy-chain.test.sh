#!/usr/bin/env bash
# policy-chain.test.sh — one case per boundary row of the chain walker.
#
# Every case is driven by STUBS, never a live vendor, so the result never
# depends on anyone's quota or auth state — which is the whole point of testing
# a fallback path.
#
# Rows 13 (max diff), 15 (--fixture) and 16 (CODEX_REVIEW_REPO) are properties
# of the CALLER, not the walker — the helper never resolves a repo or budgets a
# diff. They are exercised through code-review.sh at the bottom of this file.
#
# Run: bash .agents/skills/review/policy-chain.test.sh
#
# `set -uo pipefail` without `-e`, matching every other test script in this dir
# (policy-review.test.sh, find-peers.test.sh, and the rest). A suite whose whole
# job is driving EXPECTED failures cannot run under `-e`: the first expected
# non-zero would abort the run, and a suite that exits early reports as a pass by
# silence — the failure mode the tests exist to catch. Every fallible command
# below is individually guarded (`|| RUN_RC=$?`, `|| true`, `|| echo ""`), so a
# genuine error still surfaces as a FAIL line rather than a silent skip.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel)"

# The vendor stubs and the planted-bug fixture live beside this suite, under
# tests/. A missing folder does not resolve, and the fixture-backed cases FAIL
# loudly — which is correct. A silent skip would report a green suite for
# assertions that never ran.
STUBS="${SCRIPT_DIR}/tests/stubs"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/policy-chain-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  echo "FAIL: $*" >&2
}

check_rc() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected rc=$expect, got rc=$got"; fi
}

check_has() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then ok; else bad "$name — missing '$needle' in: $hay"; fi
}

check_lacks() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then bad "$name — unexpected '$needle' in: $hay"; else ok; fi
}

check_eq() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected '$expect', got '$got'"; fi
}

# ── Fixtures ──────────────────────────────────────────────────────────
#
# A stand-in policy, so no case depends on the live table drifting.

POLICY="$TMP/policy.json"
cat >"$POLICY" <<'EOF'
{
  "rows": {
    "adversarial-review": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "one-slot": {
      "mode": "no-backup",
      "chain": [{ "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "claude-tail": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "claude", "model": "opus", "tracks": "opus[1m]" }]
    },
    "bogus-vendor": {
      "mode": "single",
      "chain": [{ "vendor": "nosuchvendor", "model": "x", "tracks": "x" }]
    },
    "unpinned": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "unresolvable": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "unresolvable-{v}" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "panel": {
      "mode": "panel",
      "voices": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    }
  }
}
EOF

PROMPT="$TMP/prompt.txt"

# Model resolution reads a vendor's live catalog; these cases stub the vendor,
# so they stub the resolver too (POLICY_CHAIN_RESOLVER, policy-chain.sh). It
# resolves the fixture families the way a real catalog would and fails a
# family named `unresolvable-{v}`.
cat >"$TMP/resolve-model.sh" <<'RESOLVER'
#!/usr/bin/env bash
case "$2" in
  "gpt-{v}-sol") echo gpt-6-sol ;;
  "grok-{v}") echo grok-4.7 ;;
  unresolvable-*) echo "no $2 in the $1 catalog" >&2; exit 1 ;;
  *) echo "$2" ;;
esac
RESOLVER
chmod +x "$TMP/resolve-model.sh"
export POLICY_CHAIN_RESOLVER="$TMP/resolve-model.sh"
printf 'review this artifact\n' >"$PROMPT"

EMPTY_PROMPT="$TMP/empty.txt"
: >"$EMPTY_PROMPT"

# Stubs the shared set does not cover: one that names itself so a stream can be
# attributed to a slot, one that records its argv, one that emits an
# unterminated final line.
mkstub() {
  local path="$1"
  shift
  printf '#!/usr/bin/env bash\nset -uo pipefail\n%s\n' "$*" >"$path"
  chmod +x "$path"
}
mkstub "$TMP/say-codex.sh" 'echo "[must-fix] from codex"'
mkstub "$TMP/say-grok.sh" 'printf "{\"text\":\"[must-fix] from grok\"}\n"'
mkstub "$TMP/record-args.sh" "printf '%s\\n' \"\$@\" > '$TMP/argv.txt'; echo '{\"text\":\"ok\"}'"
mkstub "$TMP/no-trailing-newline.sh" 'printf "[nit] last line with no newline"'
mkstub "$TMP/echo-prompt-bytes.sh" 'wc -c < /dev/stdin'

# The helper is sourced into THIS shell, exactly as a caller sources it.
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/policy-chain.sh"
# ...which turns `set -e` on. A test whose whole job is to drive failing cases
# cannot run under it — the first expected non-zero would abort the run and
# report as a pass-by-silence. Restore this file's own posture.
set +e

export POLICY_JSON="$POLICY"
export POLICY_CHAIN_SLOT_TIMEOUT_S=5

# run <task-kind> <prompt-file> — captures stdout and stderr separately so the
# "stdout carries vendor output ONLY" contract is assertable.
RUN_OUT=""
RUN_ERR=""
RUN_RC=0
run() {
  local errf="$TMP/run.err"
  RUN_RC=0
  RUN_OUT="$(policy_run_chain "$@" 2>"$errf")" || RUN_RC=$?
  RUN_ERR="$(cat "$errf")"
}

echo "policy-chain: § 4 boundary rows"

# ── 1a — unknown task-kind ────────────────────────────────────────────
CODEX_BIN="$TMP/say-codex.sh" run no-such-kind "$PROMPT"
check_rc "1a unknown task-kind" 2 "$RUN_RC"
check_has "1a names the row" "no-such-kind" "$RUN_ERR"
check_has "1a lists known rows" "known rows:" "$RUN_ERR"

# ── 2 — a one-slot row exhausts with no "trying next slot" ────────────
GROK_BIN="$STUBS/stub-fail.sh" run one-slot "$PROMPT"
check_rc "2 one-slot exhaustion" 1 "$RUN_RC"
check_lacks "2 no next-slot line on a one-slot row" "trying next slot" "$RUN_ERR"
check_has "2 exhaustion is named" "every vendor in the 'one-slot' chain failed" "$RUN_ERR"

# ── 3 — empty prompt file, before any vendor is invoked ───────────────
rm -f "$TMP/argv.txt"
CODEX_BIN="$TMP/record-args.sh" run adversarial-review "$EMPTY_PROMPT"
check_rc "3 empty prompt" 2 "$RUN_RC"
if [[ -f "$TMP/argv.txt" ]]; then
  bad "3 a vendor was invoked on an empty prompt"
else
  ok
fi

# A prompt file that does not exist at all is the same class of caller error.
run adversarial-review "$TMP/does-not-exist.txt"
check_rc "3b missing prompt file" 2 "$RUN_RC"

# ── 4 — every slot fails; one stderr line per slot ────────────────────
CODEX_BIN="$STUBS/stub-fail.sh" GROK_BIN="$STUBS/stub-fail.sh" run adversarial-review "$PROMPT"
check_rc "4 total exhaustion" 1 "$RUN_RC"
check_eq "4 nothing on stdout" "" "$RUN_OUT"
check_eq "4 one failure line per slot" 2 "$(grep -c "failed (exit" <<<"$RUN_ERR")"
check_has "4 names codex" "codex failed" "$RUN_ERR"
check_has "4 names grok" "grok failed" "$RUN_ERR"
# Only the non-final slot promises a next one. A "trying next slot" on the LAST
# slot is a diagnostic that lies about what happens next.
check_eq "4 only the non-final slot promises a next" 1 "$(grep -c "trying next slot" <<<"$RUN_ERR")"

# ── 5 — first slot's CLI absent; the walk continues ───────────────────
CODEX_BIN="$TMP/nonexistent-binary" GROK_BIN="$TMP/say-grok.sh" run adversarial-review "$PROMPT"
check_rc "5 absent primary falls through" 0 "$RUN_RC"
check_has "5 absence is named" "codex CLI absent" "$RUN_ERR"
check_has "5 grok answered" "answered: grok/grok" "$RUN_ERR"
check_eq "5 grok's text reaches stdout" "[must-fix] from grok" "$RUN_OUT"

# ── 6 — first slot exits non-zero; the walk continues ─────────────────
CODEX_BIN="$STUBS/stub-fail.sh" GROK_BIN="$TMP/say-grok.sh" run adversarial-review "$PROMPT"
check_rc "6 failed primary falls through" 0 "$RUN_RC"
check_has "6 failure reason carries the exit code" "codex failed (exit 3)" "$RUN_ERR"

# ── 7 — a timed-out slot falls through; all-timeout returns 124 ───────
CODEX_BIN="$STUBS/stub-hang.sh" GROK_BIN="$TMP/say-grok.sh" run adversarial-review "$PROMPT"
check_rc "7a hung primary falls through" 0 "$RUN_RC"
check_has "7a timeout is named as a timeout" "codex timed out after 5s" "$RUN_ERR"

CODEX_BIN="$STUBS/stub-hang.sh" GROK_BIN="$STUBS/stub-hang.sh" run adversarial-review "$PROMPT"
check_rc "7b every slot timed out" 124 "$RUN_RC"

# A timeout followed by a plain failure is NOT 124 — the code reports the LAST
# failure, so a caller cannot mistake a dead vendor for a slow one.
CODEX_BIN="$STUBS/stub-hang.sh" GROK_BIN="$STUBS/stub-fail.sh" run adversarial-review "$PROMPT"
check_rc "7c timeout then failure is 1, not 124" 1 "$RUN_RC"

# ── 8 — the walk stops on first success; streams never concatenate ────
CODEX_BIN="$TMP/say-codex.sh" GROK_BIN="$TMP/say-grok.sh" run adversarial-review "$PROMPT"
check_rc "8 first slot answers" 0 "$RUN_RC"
check_eq "8 only the first slot's output" "[must-fix] from codex" "$RUN_OUT"
check_lacks "8 the second slot never ran" "from grok" "$RUN_OUT"
check_has "8 answered line names codex" "answered: codex/codex" "$RUN_ERR"

# ── 9 — a slot exits 0 with an empty body: success here, the CALLER's
#        contract decides whether an empty review is a clean one ───────
CODEX_BIN="$STUBS/stub-empty.sh" run adversarial-review "$PROMPT"
check_rc "9 empty-but-zero is not chain fallthrough" 0 "$RUN_RC"
check_eq "9 stdout is empty" "" "$RUN_OUT"

# ── 10 — policy.json missing ──────────────────────────────────────────
POLICY_JSON="$TMP/absent.json" run adversarial-review "$PROMPT"
check_rc "10 missing policy" 2 "$RUN_RC"
check_has "10 says where the table ships" "it ships beside policy-chain.sh" "$RUN_ERR"

# ── 11 — the policy is read at CALL time, never cached ────────────────
# A stale policy.json is a real hazard (pre-commit only regenerates when the
# policy files are STAGED), so the helper must never memoize the table: the
# same process, asked twice, must see an edit made in between.
STALE="$TMP/stale.json"
cat >"$STALE" <<'EOF'
{ "rows": { "adversarial-review": { "mode": "single", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }] } } }
EOF
POLICY_JSON="$STALE" CODEX_BIN="$TMP/say-codex.sh" run adversarial-review "$PROMPT"
check_has "11 reads the row before the edit" "answered: codex/codex" "$RUN_ERR"
cat >"$STALE" <<'EOF'
{ "rows": { "adversarial-review": { "mode": "single", "chain": [{ "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }] } } }
EOF
POLICY_JSON="$STALE" GROK_BIN="$TMP/say-grok.sh" run adversarial-review "$PROMPT"
check_has "11 sees the edited row in the same process" "answered: grok/grok" "$RUN_ERR"

# ── 12 — the chain reaches a claude slot ──────────────────────────────
CODEX_BIN="$STUBS/stub-fail.sh" run claude-tail "$PROMPT"
check_rc "12 claude slot returns 3" 3 "$RUN_RC"
check_has "12 tells the caller to dispatch its agent" "dispatch the Claude agent instead" "$RUN_ERR"

# ── 14 — a large prompt is piped, never placed on argv ────────────────
# ~256 KB, well past the point where argv dies "Argument list too long"
# (exit 126).
BIG="$TMP/big-prompt.txt"
head -c 262144 /dev/urandom | base64 | head -c 262144 >"$BIG"
CODEX_BIN="$TMP/echo-prompt-bytes.sh" run adversarial-review "$BIG"
check_rc "14 a 256KB prompt runs" 0 "$RUN_RC"
if [[ "${RUN_OUT//[[:space:]]/}" -ge 262144 ]]; then ok; else bad "14 the whole prompt did not reach the vendor: $RUN_OUT"; fi

# ── 16 — the helper resolves no repo of its own ───────────────────────
# Run with cwd outside any git checkout. A helper that shelled out to
# `git rev-parse` for its policy path would die here; repo resolution stays
# caller-owned.
(
  cd "$TMP" || exit 1
  git rev-parse --show-toplevel >/dev/null 2>&1 && exit 0 # inside a repo: skip
  exit 42
) >/dev/null 2>&1
if [[ $? -eq 42 ]]; then
  pushd "$TMP" >/dev/null || true
  CODEX_BIN="$TMP/say-codex.sh" run adversarial-review "$PROMPT"
  popd >/dev/null || true
  check_rc "16 works outside a git repo" 0 "$RUN_RC"
else
  echo "note: $TMP is inside a git checkout; skipping the no-repo case" >&2
fi

# ── 16b — the table is the one shipped beside the script ─────────────
# No POLICY_JSON: the helper reads policy.json from its own folder, whatever
# the caller's cwd, inside a repo or not.
mkdir -p "$TMP/copy/a/b"
cp "${SCRIPT_DIR}/policy-chain.sh" "$TMP/copy/a/b/policy-chain.sh"
rc=0
out="$(cd / && env -u POLICY_JSON bash -c "source $TMP/copy/a/b/policy-chain.sh; _policy_chain_policy_path" 2>&1)" || rc=$?
check_rc "16b resolves with no repo and no POLICY_JSON" 0 "$rc"
check_eq "16b the policy.json beside the script" "$TMP/copy/a/b/policy.json" "$out"

# The shipped table carries the rows every caller names, pins no model, and
# keeps the panel as voices.
SHIPPED="${SCRIPT_DIR}/policy.json"
check_eq "16c shipped rows" "adversarial-review judgment panel repo-investigation" \
  "$(jq -r '.rows | keys | join(" ")' "$SHIPPED")"
check_eq "16c the shipped table pins no model" "" \
  "$(jq -r '[.rows[] | (.chain // .voices)[] | .tracks] | map(select(. != "")) | join(",")' "$SHIPPED")"
check_eq "16c the panel is voices, the reviews are chains" "voices chain chain chain" \
  "$(jq -r '[.rows.panel, .rows["adversarial-review"], .rows.judgment, .rows["repo-investigation"]] | map(if .voices then "voices" else "chain" end) | join(" ")' "$SHIPPED")"

# ── 17 — every vendor down at once: no false green anywhere ───────────
CODEX_BIN="$TMP/nonexistent-binary" GROK_BIN="$TMP/nonexistent-binary" run adversarial-review "$PROMPT"
check_rc "17 all vendors absent" 1 "$RUN_RC"
check_eq "17 nothing on stdout" "" "$RUN_OUT"

# ── An unsupported vendor exhausts cleanly rather than crashing ───────
run bogus-vendor "$PROMPT"
check_rc "unsupported vendor exhausts" 1 "$RUN_RC"
check_has "unsupported vendor is named" "unsupported vendor" "$RUN_ERR"

# ── A panel row exposes `voices`, not `chain` — the reader handles both
CODEX_BIN="$TMP/say-codex.sh" run panel "$PROMPT"
check_rc "panel row resolves through voices" 0 "$RUN_RC"

# ── § 9 failure mode: the answer-only Grok invocation is allowlist-scoped ──
#
# It used to be denylist-scoped, and these rows used to assert the four denied
# names were present. They now assert the opposite, because the protection
# changed shape: this path runs under `bypassPermissions`, which
# ignores `--disallowed-tools` entirely, so a denied name appearing on the
# command line would be a claim of safety that is not enforced. What holds now
# is the allowlist, and it holds only while it is NON-EMPTY — `--tools ''` was
# measured granting a file write and a shell command, 2/2.
rm -f "$TMP/argv.txt"
GROK_BIN="$TMP/record-args.sh" run one-slot "$PROMPT"
check_rc "answer-only case ran" 0 "$RUN_RC"
ARGV="$(cat "$TMP/argv.txt" 2>/dev/null || echo "")"
check_has "grok answer-only run is allowlist-scoped" "--tools" "$ARGV"
check_has "grok answer-only allowlist is non-empty" "list_dir" "$ARGV"
check_lacks "grok answer-only run carries no unenforced denylist" "--disallowed-tools" "$ARGV"
check_lacks "grok answer-only run does not allowlist a shell" "run_terminal_command" "$ARGV"
check_lacks "grok answer-only run does not allowlist search_replace" "search_replace" "$ARGV"
check_lacks "grok answer-only run does not allowlist spawn_subagent" "spawn_subagent" "$ARGV"
# The mode is half the protection and half the fix; asserting the allowlist
# without it would pass against a `dontAsk` run that cancels a quarter of the
# time and enforces the allowlist not at all.
check_has "grok answer-only run uses bypassPermissions" "bypassPermissions" "$ARGV"
check_lacks "grok answer-only run never uses dontAsk" "dontAsk" "$ARGV"
check_has "grok answer-only run takes no web hop" "--disable-web-search" "$ARGV"
check_has "grok prompt arrives as a file, not argv" "--prompt-file" "$ARGV"
# Grok CLI 1.0.0 truncates a large prompt and offloads it to a session file
# unless told not to. Review and SPEC-audit prompts are exactly the large ones,
# and a half-delivered prompt comes back as narration this script then reports
# as a dead slot — so the flag is a correctness requirement, not a nicety.
check_has "grok prompt is sent verbatim (1.0.0 truncates large prompts)" "--verbatim" "$ARGV"
# When the table names a model, the CLI is told it.
check_has "grok is told the slot's pinned model" "grok-4.7" "$ARGV"
check_eq "and told it as -m" "-m" "$(grep -B1 -x -- 'grok-4.7' <<<"$ARGV" | head -1)"

# --verbatim alone is not enough: 1.0.0's default system prompt makes it a
# planning agent and its default effort resolves to xhigh, both of which
# self-cancel on a large prompt (8/8). All three or none.
check_has "grok run pins reasoning effort (default xhigh self-cancels)" "--reasoning-effort" "$ARGV"
check_has "grok run overrides the agent system prompt" "--system-prompt-override" "$ARGV"
check_lacks "grok prompt text is not on argv" "review this artifact" "$ARGV"
# Without --verbatim the CLI truncates a large --prompt-file and offloads the
# remainder to a file, forcing an agent loop whose narration lands in `.text`.
# On this path that means a review returning first-turn narration and no
# findings, which reads exactly like a clean pass.
check_has "grok run sends the prompt verbatim" "--verbatim" "$ARGV"
# Planning off on every grok call: the CLI's own --no-plan.
check_has "grok run disables plan mode" "--no-plan" "$ARGV"

# ── The repo-reading Grok invocation (code review, SPEC audit) ─────────
#
# Off `dontAsk` too: that mode cancels repo-reading agent runs, and runs that
# call no tool at all, so no Grok path keeps it. The allowlist is the caller's and must
# arrive intact — under bypassPermissions it is the only scoping enforced.
rm -f "$TMP/argv.txt"
POLICY_CHAIN_GROK_TOOLS="read_file,list_dir,grep" GROK_BIN="$TMP/record-args.sh" run one-slot "$PROMPT"
check_rc "repo-reading case ran" 0 "$RUN_RC"
ARGV="$(cat "$TMP/argv.txt" 2>/dev/null || echo "")"
check_has "grok repo-reading run uses bypassPermissions" "bypassPermissions" "$ARGV"
check_lacks "grok repo-reading run never uses dontAsk" "dontAsk" "$ARGV"
check_eq "grok repo-reading run carries the caller's allowlist" "read_file,list_dir,grep" \
  "$(grep -A1 -x -- '--tools' <<<"$ARGV" | tail -1)"
check_lacks "grok repo-reading run carries no unenforced denylist" "--disallowed-tools" "$ARGV"
check_has "grok repo-reading run takes no web hop" "--disable-web-search" "$ARGV"

rm -f "$TMP/argv.txt"
CODEX_BIN="$TMP/record-args.sh" run adversarial-review "$PROMPT"
ARGV="$(cat "$TMP/argv.txt" 2>/dev/null || echo "")"
check_eq "codex is told the slot's pinned model as -m" "-m" "$(grep -B1 -x -- 'gpt-6-sol' <<<"$ARGV" | head -1)"

# A slot with no pin runs the CLI's own default model: no -m at all.
rm -f "$TMP/argv.txt"
CODEX_BIN="$TMP/record-args.sh" GROK_BIN="$TMP/say-grok.sh" run unpinned "$PROMPT"
check_rc "an unpinned slot runs" 0 "$RUN_RC"
ARGV="$(cat "$TMP/argv.txt" 2>/dev/null || echo "")"
check_has "the unpinned codex slot ran" "exec" "$ARGV"
check_lacks "and was given no model flag" "-m" "$ARGV"

# A family that does not resolve is refused: named, not run, and the chain
# walks on.
rm -f "$TMP/argv.txt"
CODEX_BIN="$TMP/record-args.sh" GROK_BIN="$TMP/say-grok.sh" run unresolvable "$PROMPT"
check_rc "an unresolvable family does not end the chain" 0 "$RUN_RC"
check_has "the unresolvable family is named" "could not resolve unresolvable-{v}" "$RUN_ERR"
check_eq "its backup answered" "[must-fix] from grok" "$RUN_OUT"
if [[ -f "$TMP/argv.txt" ]]; then
  bad "the unresolvable codex slot was run anyway"
else
  ok
fi

# The DEFAULT resolver has no catalog: an exact id passes through verbatim, and
# a `{v}` family is refused rather than guessed at.
EXACT="$TMP/exact.json"
cat >"$EXACT" <<'EOF'
{ "rows": {
  "exact": { "mode": "single", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-6-sol" }] },
  "family": { "mode": "single", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "" }] }
} }
EOF
rm -f "$TMP/argv.txt"
POLICY_JSON="$EXACT" POLICY_CHAIN_RESOLVER="" CODEX_BIN="$TMP/record-args.sh" run exact "$PROMPT"
ARGV="$(cat "$TMP/argv.txt" 2>/dev/null || echo "")"
check_eq "the default resolver passes an exact id as -m" "-m" "$(grep -B1 -x -- 'gpt-6-sol' <<<"$ARGV" | head -1)"
rm -f "$TMP/argv.txt"
POLICY_JSON="$EXACT" POLICY_CHAIN_RESOLVER="" CODEX_BIN="$TMP/record-args.sh" GROK_BIN="$TMP/say-grok.sh" run family "$PROMPT"
check_has "the default resolver refuses a family" "needs a resolver" "$RUN_ERR"
check_eq "and the chain walks on" "[must-fix] from grok" "$RUN_OUT"

# ── The author leaves a review row ────────────────────────────────────
# `.agents/harness` records `agent=` — the family that writes the code. A
# review row (`.chain`) skips that vendor; a panel (`.voices`) keeps it; the
# claude slot is never skipped, because it means "dispatch your own agent".
HARNESS="$TMP/harness"
printf 'harness=t3\nagent=codex\n' >"$HARNESS"
CONTEXTIUM_HARNESS_FILE="$HARNESS" CODEX_BIN="$TMP/say-codex.sh" GROK_BIN="$TMP/say-grok.sh" run adversarial-review "$PROMPT"
check_rc "author skip: the row still answers" 0 "$RUN_RC"
check_eq "author skip: codex wrote the code, so grok reviews" "[must-fix] from grok" "$RUN_OUT"
check_has "author skip: it says why" "codex left out of 'adversarial-review': it wrote the code" "$RUN_ERR"
CONTEXTIUM_HARNESS_FILE="$HARNESS" CODEX_BIN="$TMP/say-codex.sh" run panel "$PROMPT"
check_eq "author skip: a panel keeps the author's seat" "[must-fix] from codex" "$RUN_OUT"
printf 'agent=grok\n' >"$HARNESS"
CONTEXTIUM_HARNESS_FILE="$HARNESS" GROK_BIN="$TMP/say-grok.sh" run one-slot "$PROMPT"
check_rc "author skip: a row holding only the author exhausts" 1 "$RUN_RC"
printf 'agent=claude\n' >"$HARNESS"
CONTEXTIUM_HARNESS_FILE="$HARNESS" CODEX_BIN="$STUBS/stub-fail.sh" run claude-tail "$PROMPT"
check_rc "author skip: the claude slot still returns 3" 3 "$RUN_RC"
printf 'agent=antigravity\n' >"$HARNESS"
EXACT_G="$TMP/gemini.json"
printf '%s\n' '{ "rows": { "r": { "mode": "single", "chain": [{ "vendor": "gemini", "model": "gemini", "tracks": "" }, { "vendor": "codex", "model": "codex", "tracks": "" }] } } }' >"$EXACT_G"
POLICY_JSON="$EXACT_G" CONTEXTIUM_HARNESS_FILE="$HARNESS" CODEX_BIN="$TMP/say-codex.sh" run r "$PROMPT"
check_has "author skip: antigravity is the gemini family" "gemini left out of 'r'" "$RUN_ERR"
for a in cursor copilot; do
  printf 'agent=%s\n' "$a" >"$HARNESS"
  CONTEXTIUM_HARNESS_FILE="$HARNESS" CODEX_BIN="$TMP/say-codex.sh" run adversarial-review "$PROMPT"
  check_eq "author skip: agent=$a names no family, nothing skipped" "[must-fix] from codex" "$RUN_OUT"
done
CONTEXTIUM_HARNESS_FILE="$TMP/no-such-harness" CODEX_BIN="$TMP/say-codex.sh" run adversarial-review "$PROMPT"
check_eq "author skip: no harness file, the row as written" "[must-fix] from codex" "$RUN_OUT"

# ── Contextium: a review row with every vendor unavailable falls back ──
# A row marked `"fallback": "fresh-context"` returns 3 — the caller dispatches a
# fresh-context agent of its own and records it as NOT independent — instead of
# the plain exhaustion a row without the mark keeps.
FB="$TMP/fallback.json"
cat >"$FB" <<'EOF'
{ "rows": {
  "fb": { "mode": "single", "fallback": "fresh-context", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "" }, { "vendor": "grok", "model": "grok", "tracks": "" }] },
  "nofb": { "mode": "single", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "" }] }
} }
EOF
POLICY_JSON="$FB" CODEX_BIN="$TMP/nonexistent-binary" GROK_BIN="$TMP/nonexistent-binary" run fb "$PROMPT"
check_rc "fallback row, every vendor absent: 3" 3 "$RUN_RC"
check_has "…and it says the review is NOT independent" "fresh-context review, NOT independent" "$RUN_ERR"
POLICY_JSON="$FB" CODEX_BIN="$STUBS/stub-fail.sh" GROK_BIN="$STUBS/stub-fail.sh" run fb "$PROMPT"
check_rc "fallback row, every vendor failing: 3" 3 "$RUN_RC"
POLICY_JSON="$FB" CODEX_BIN="$STUBS/stub-hang.sh" GROK_BIN="$STUBS/stub-hang.sh" run fb "$PROMPT"
check_rc "fallback row, every vendor timing out: 3" 3 "$RUN_RC"
_fb_wants_finding() { grep -q '^\[' "$1"; }
mkstub "$TMP/fb-prose.sh" 'echo "Sure, I can help with that."'
POLICY_JSON="$FB" POLICY_CHAIN_VALIDATOR=_fb_wants_finding CODEX_BIN="$TMP/fb-prose.sh" GROK_BIN="$TMP/fb-prose.sh" run fb "$PROMPT"
check_rc "fallback row, vendors alive but wrong-shaped: still 125" 125 "$RUN_RC"
POLICY_JSON="$FB" CODEX_BIN="$TMP/say-codex.sh" run fb "$PROMPT"
check_rc "fallback row, a vendor answers: 0" 0 "$RUN_RC"
POLICY_JSON="$FB" CODEX_BIN="$TMP/nonexistent-binary" run nofb "$PROMPT"
check_rc "a row without the mark keeps plain exhaustion" 1 "$RUN_RC"
SHIPPED_FB="$(jq -r '[.rows | to_entries[] | select(.value.fallback == "fresh-context") | .key] | join(" ")' "${SCRIPT_DIR}/policy.json")"
check_eq "the shipped review rows carry the mark; panel and investigation do not" "adversarial-review judgment" "$SHIPPED_FB"

# ── A slot is capped even with no `timeout` on PATH (stock macOS) ──────
NOTIMEOUT="$TMP/notimeout"; mkdir -p "$NOTIMEOUT"
for b in bash env jq cat sed grep awk head tail tr wc mktemp rm mkdir dirname basename sleep kill printf; do
  f="$(command -v "$b" 2>/dev/null || true)"
  case "$f" in /*) ln -s "$f" "$NOTIMEOUT/$b" ;; esac
done
rc=0
PATH="$NOTIMEOUT" POLICY_JSON="$POLICY" POLICY_CHAIN_SLOT_TIMEOUT_S=2 POLICY_CHAIN_RESOLVER="$TMP/resolve-model.sh" \
  CODEX_BIN="$STUBS/stub-hang.sh" GROK_BIN="$STUBS/stub-hang.sh" \
  "$NOTIMEOUT/bash" -c "source '${SCRIPT_DIR}/policy-chain.sh'; policy_run_chain adversarial-review '$PROMPT'" >/dev/null 2>&1 || rc=$?
check_rc "no timeout binary: a hang still ends in 124" 124 "$rc"

# ── A vendor's unterminated final line still reaches the caller ───────
# Every caller parses stdout with `while IFS= read -r line`, which drops a
# final line that has no newline — silently losing the last finding of a review.
CODEX_BIN="$TMP/no-trailing-newline.sh" run adversarial-review "$PROMPT"
LAST_LINE=""
while IFS= read -r line; do LAST_LINE="$line"; done <<<"$RUN_OUT"
check_eq "an unterminated last line survives a read loop" "[nit] last line with no newline" "$LAST_LINE"

# ── The shape test: a wrong-shaped answer is a FAILED slot ────────────
#
# A slot used to be banked on `rc == 0` alone, so a vendor that answered with
# prose instead of the findings the caller asked for spent the whole chain —
# both callers parse afterwards, outside the walk, where a rejection can no
# longer reach the untried backup.

# Accepts only output carrying a finding line, which is the shape both reviewer
# gates actually need. Written as a FUNCTION because that is the shape the real
# callers use — they need helpers from their own sourcing shell.
_test_wants_finding() { grep -q '^\[' "$1"; }
_test_reject_all() {
  echo "nothing here looks like a review" >&2
  return 1
}
_test_chatty_reject() {
  echo "STDOUT-FROM-VALIDATOR"
  return 1
}
_test_chatty_accept() {
  echo "STDOUT-FROM-VALIDATOR"
  return 0
}
mkstub "$TMP/say-prose.sh" 'echo "Sure, I can help you review that."'

# Unset → today's behavior, byte for byte.
CODEX_BIN="$TMP/say-codex.sh" run adversarial-review "$PROMPT"
check_rc "validator unset changes nothing" 0 "$RUN_RC"
check_eq "validator unset returns the answer" "[must-fix] from codex" "$RUN_OUT"

# Slot 1 answers in the wrong shape → the chain walks to slot 2.
POLICY_CHAIN_VALIDATOR=_test_wants_finding \
  CODEX_BIN="$TMP/say-prose.sh" GROK_BIN="$TMP/say-grok.sh" run adversarial-review "$PROMPT"
check_rc "a wrong-shaped primary falls through" 0 "$RUN_RC"
check_has "the rejection is named" "codex answered in the wrong shape" "$RUN_ERR"
check_has "the backup answered" "answered: grok/grok" "$RUN_ERR"
check_eq "the backup's answer reaches stdout" "[must-fix] from grok" "$RUN_OUT"

# Every slot wrong-shaped → exhaustion, and 125 rather than a bare 1: every
# vendor was alive and answered, so a caller with its own re-ask should spend
# it here. A dead chain (rc 1) has nobody left to ask and must not be re-walked.
POLICY_CHAIN_VALIDATOR=_test_wants_finding \
  CODEX_BIN="$TMP/say-prose.sh" GROK_BIN="$TMP/say-prose.sh" run adversarial-review "$PROMPT"
check_rc "every slot wrong-shaped exhausts as 125, not 1" 125 "$RUN_RC"
check_eq "an exhausted-on-shape chain emits nothing" "" "$RUN_OUT"
check_eq "one rejection line per slot" 2 "$(grep -c "answered in the wrong shape" <<<"$RUN_ERR")"
check_has "exhaustion is still named" "every vendor in the 'adversarial-review' chain failed" "$RUN_ERR"

# ...and a chain that exhausted for a NON-shape reason still returns 1, so the
# two are actually distinguishable rather than both collapsing to "exhausted".
POLICY_CHAIN_VALIDATOR=_test_wants_finding \
  CODEX_BIN="$STUBS/stub-fail.sh" GROK_BIN="$STUBS/stub-fail.sh" run adversarial-review "$PROMPT"
check_rc "a dead chain is still a plain exhaustion" 1 "$RUN_RC"

# A primary rejected on shape with a DEAD backup behind it still earns 125.
# The re-ask re-walks the whole chain, so the narrating primary is recoverable
# — and this compound case (primary narrates, backup down) is the one where the
# re-ask matters most. Keying on the LAST slot would have withheld it here.
POLICY_CHAIN_VALIDATOR=_test_wants_finding \
  CODEX_BIN="$TMP/say-prose.sh" GROK_BIN="$STUBS/stub-fail.sh" run adversarial-review "$PROMPT"
check_rc "shape-then-dead still earns the re-ask" 125 "$RUN_RC"

# A timeout still wins the classification: callers map 124 to its own fatal
# message, and that must not change because a shape test is now in play.
POLICY_CHAIN_VALIDATOR=_test_wants_finding \
  CODEX_BIN="$TMP/say-prose.sh" GROK_BIN="$STUBS/stub-hang.sh" run adversarial-review "$PROMPT"
check_rc "a timeout still classifies as 124" 124 "$RUN_RC"

# The validator's stderr is the reason, quoted into the diagnostic.
POLICY_CHAIN_VALIDATOR=_test_reject_all \
  CODEX_BIN="$TMP/say-codex.sh" GROK_BIN="$TMP/say-grok.sh" run adversarial-review "$PROMPT"
check_has "the validator's stderr becomes the reason" "nothing here looks like a review" "$RUN_ERR"

# THE contract that protects the answer stream: a validator's stdout must never
# reach the caller's, which is parsed as findings. Asserted on both verdicts —
# an accepting validator is the sneakier of the two, because its noise would be
# prepended to a REAL review rather than to nothing.
POLICY_CHAIN_VALIDATOR=_test_chatty_reject \
  CODEX_BIN="$TMP/say-codex.sh" GROK_BIN="$TMP/say-grok.sh" run adversarial-review "$PROMPT"
check_lacks "a rejecting validator's stdout stays out of the answer" "STDOUT-FROM-VALIDATOR" "$RUN_OUT"
POLICY_CHAIN_VALIDATOR=_test_chatty_accept \
  CODEX_BIN="$TMP/say-codex.sh" run adversarial-review "$PROMPT"
check_eq "an accepting validator's stdout stays out of the answer" "[must-fix] from codex" "$RUN_OUT"

# An UNRUNNABLE validator is a caller error, and it is caught before any vendor
# is invoked. Defaulting it to "accept" would silently reinstate the hole.
rm -f "$TMP/argv.txt"
POLICY_CHAIN_VALIDATOR=_no_such_validator_anywhere \
  CODEX_BIN="$TMP/record-args.sh" run adversarial-review "$PROMPT"
check_rc "an unrunnable validator is a caller error" 2 "$RUN_RC"
check_has "it names the validator" "_no_such_validator_anywhere" "$RUN_ERR"
if [[ -f "$TMP/argv.txt" ]]; then
  bad "a vendor was invoked before the unrunnable validator was caught"
else
  ok
fi

# It must not bleed into the NEXT call in the same sourced shell — one gate's
# contract applied to another gate's answer is worse than no contract at all.
#
# Called DIRECTLY here rather than through `run`, and the difference is the
# whole point: `run` captures stdout with `$(...)`, a SUBSHELL, where the
# helper's own bookkeeping — this unset, and the POLICY_CHAIN_VENDOR exports
# the header warns about — dies with the subshell and can never be observed.
# Redirecting to a file is the documented call shape and what both real callers
# do. Asserting this through `run` would have passed while testing nothing.
POLICY_CHAIN_VALIDATOR=_test_reject_all
CODEX_BIN="$TMP/say-codex.sh" GROK_BIN="$TMP/say-grok.sh" \
  policy_run_chain adversarial-review "$PROMPT" >"$TMP/bleed.out" 2>"$TMP/bleed.err" || true
check_eq "the validator does not survive the call" "" "${POLICY_CHAIN_VALIDATOR:-}"

# ...so the next call is unvalidated, which is what "opt-in" means.
CODEX_BIN="$TMP/say-codex.sh" run adversarial-review "$PROMPT"
check_rc "the next call runs unvalidated" 0 "$RUN_RC"
check_eq "and returns its answer" "[must-fix] from codex" "$RUN_OUT"

# Never exported: an exported name lands in the environment of every vendor CLI
# the walk spawns, and in any nested call. Stripped even when the CALLER
# exported it, because documenting "do not export this" does not stop anyone.
mkstub "$TMP/record-env.sh" "env > '$TMP/env.txt'; printf '{\"text\":\"[must-fix] ok\"}\\n'"
rm -f "$TMP/env.txt"
export POLICY_CHAIN_VALIDATOR=_test_wants_finding
GROK_BIN="$TMP/record-env.sh" \
  policy_run_chain one-slot "$PROMPT" >"$TMP/env-case.out" 2>"$TMP/env-case.err" || true
check_has "an exported validator still runs" "answered: grok/grok" "$(cat "$TMP/env-case.err")"
check_lacks "it is stripped from the vendor's environment" \
  "POLICY_CHAIN_VALIDATOR" "$(cat "$TMP/env.txt" 2>/dev/null || echo "")"
check_eq "and it is gone afterwards" "" "${POLICY_CHAIN_VALIDATOR:-}"

# Belt and braces: nothing below this line may inherit a shape test. The
# code-review.sh cases run it as a SUBPROCESS, which would see an exported one.
unset POLICY_CHAIN_VALIDATOR

# ── Caller-scoped rows, through code-review.sh ────────────────────────
#
# 13 (max diff refused, never truncated), 15 (--fixture), plus the § 5
# acceptance behaviors: fall-through on a dead primary, on a hung primary, and
# a hard failure on exhaustion. BOTH bins are stubbed in every case — overriding
# only CODEX_BIN would send the backup hop to a live grok, which is the opposite
# of deterministic.

REVIEW="${SCRIPT_DIR}/code-review.sh"
FIXTURE="${SCRIPT_DIR}/tests/fixtures/planted-bugs"

if [[ -x "$REVIEW" || -f "$REVIEW" ]]; then
  echo "code-review.sh: caller-scoped rows"

  # 15 + acceptance 2 — dead primary, backup answers, fixture mode intact.
  errf="$TMP/cr.err"
  rc=0
  out=$(CODEX_BIN="$STUBS/stub-fail.sh" GROK_BIN="$STUBS/stub-clean.sh" \
    bash "$REVIEW" --fixture "$FIXTURE" 2>"$errf") || rc=$?
  check_rc "cr: dead primary falls through to the backup" 0 "$rc"
  check_has "cr: the fall-through is named on stderr" "trying next slot" "$(cat "$errf")"
  check_has "cr: the answering vendor is named on stderr" "answered: grok" "$(cat "$errf")"
  check_eq "cr: a clean review prints no findings" "" "$out"

  # acceptance 3 — hung primary falls through (this used to be a hard 124).
  rc=0
  CODEX_BIN="$STUBS/stub-hang.sh" GROK_BIN="$STUBS/stub-clean.sh" POLICY_CHAIN_SLOT_TIMEOUT_S=5 \
    bash "$REVIEW" --fixture "$FIXTURE" >/dev/null 2>&1 || rc=$?
  check_rc "cr: hung primary falls through" 0 "$rc"

  # acceptance 4 — exhaustion is a failure, never a pass.
  rc=0
  errf="$TMP/cr-exhaust.err"
  CODEX_BIN="$STUBS/stub-fail.sh" GROK_BIN="$STUBS/stub-fail.sh" \
    bash "$REVIEW" --fixture "$FIXTURE" >/dev/null 2>"$errf" || rc=$?
  check_rc "cr: exhaustion fails" 1 "$rc"
  check_has "cr: exhaustion names the row" "every vendor in the 'adversarial-review' chain failed" "$(cat "$errf")"

  # 9 — a slot that exits 0 with an empty body is NOT a clean review.
  rc=0
  CODEX_BIN="$STUBS/stub-empty.sh" GROK_BIN="$STUBS/stub-empty.sh" \
    bash "$REVIEW" --fixture "$FIXTURE" >/dev/null 2>&1 || rc=$?
  check_rc "cr: empty output with no sentinel is a FAILED review" 1 "$rc"

  # 9b — narration-only is RE-ASKED, not failed. A slot that exits 0 saying
  # only "I'll review the diff..." looks like success to the chain, so the walk
  # stops and the backup never runs; without the re-ask the caller gets a FAILED
  # review for work the vendor was willing to do.
  rc=0
  outf="$TMP/cr-reask.out"
  errf="$TMP/cr-reask.err"
  STUB_NARRATE_STATE="$TMP/narrate-state" \
    CODEX_BIN="$STUBS/stub-narrate-then-answer.sh" GROK_BIN="$STUBS/stub-fail.sh" \
    bash "$REVIEW" --fixture "$FIXTURE" >"$outf" 2>"$errf" || rc=$?
  check_rc "cr: narration-only is re-asked, not failed" 0 "$rc"
  check_has "cr: the re-ask's findings reach stdout" "a real finding on the re-ask" "$(cat "$outf")"
  check_has "cr: the re-ask is announced on stderr" "re-asking once" "$(cat "$errf")"

  # 9c — the re-ask is ONE re-ask. A vendor that narrates twice is a failed
  # review, not an infinite retry loop on a vendor that will never answer.
  rc=0
  errf="$TMP/cr-reask-twice.err"
  CODEX_BIN="$STUBS/stub-prose.sh" GROK_BIN="$STUBS/stub-prose.sh" \
    bash "$REVIEW" --fixture "$FIXTURE" >/dev/null 2>"$errf" || rc=$?
  check_rc "cr: narration on both attempts is a FAILED review" 1 "$rc"
  check_has "cr: the failure says both attempts were spent" "on two attempts" "$(cat "$errf")"

  # 13 — a diff over the byte budget is REFUSED, not truncated.
  #
  # The range is SEARCHED, not spelled `HEAD~1 HEAD`. That spelling asserted
  # something about the repo's history rather than about the code: a session
  # whose last commit was empty — a trailer-only commit, say — got "the diff is
  # empty, nothing was reviewed" and this case failed for a reason with nothing
  # to do with the byte budget.
  cr_big_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  cr_big_base="$cr_big_head"
  for cr_c in $(git -C "$REPO_ROOT" rev-list --max-count=20 HEAD); do
    if [ -n "$(git -C "$REPO_ROOT" diff --name-only "$cr_c" "$cr_big_head")" ]; then
      cr_big_base="$cr_c"
      break
    fi
  done
  rc=0
  errf="$TMP/cr-big.err"
  CODEX_BIN="$STUBS/stub-clean.sh" GROK_BIN="$STUBS/stub-clean.sh" \
    CODEX_REVIEW_MAX_DIFF_BYTES=10 bash "$REVIEW" "$cr_big_base" "$cr_big_head" \
    >/dev/null 2>"$errf" || rc=$?
  check_rc "cr: an over-budget diff is refused" 1 "$rc"
  check_has "cr: refusal says why" "Refusing rather than reviewing a truncated slice" "$(cat "$errf")"

  # Contextium: every vendor unavailable on a fallback-marked row is exit 3,
  # and the message names the fresh-context reviewer and the line to record.
  FBR="$TMP/fallback-review.json"
  printf '%s\n' '{ "rows": { "adversarial-review": { "mode": "single", "fallback": "fresh-context", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "" }, { "vendor": "grok", "model": "grok", "tracks": "" }] } } }' >"$FBR"
  rc=0
  errf="$TMP/cr-fallback.err"
  POLICY_JSON="$FBR" CODEX_BIN="$TMP/nonexistent-binary" GROK_BIN="$TMP/nonexistent-binary" \
    bash "$REVIEW" --fixture "$FIXTURE" >/dev/null 2>"$errf" || rc=$?
  check_rc "cr: no vendor available on a fallback row is exit 3" 3 "$rc"
  check_has "cr: it names the fresh-context reviewer" "implement-audit-reviewer" "$(cat "$errf")"
  check_has "cr: it names the line to record" "claude-fallback (fresh context, NOT independent)" "$(cat "$errf")"

  # 2 (caller-error half) — bad arity stays a caller error.
  rc=0
  bash "$REVIEW" >/dev/null 2>&1 || rc=$?
  check_rc "cr: bad arity is a caller error" 2 "$rc"
else
  echo "note: code-review.sh not present yet; skipping caller-scoped rows" >&2
fi

echo "policy-chain: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
