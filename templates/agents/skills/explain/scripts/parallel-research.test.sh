#!/usr/bin/env bash
# Rows for parallel-research.sh: seats are the `panel` row of the review
# skill's policy.json, run through /debate's dispatch-agents.sh (its flags, its
# timeout, its stand-ins), and the summary it prints at 3 / 2 / 0 voices, on a
# failure, on a timeout and on bad input. Stub CLIs on PATH stand in for the
# real ones; a fixture panel pins which vendor sits in which seat.
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
SUT="$HERE/parallel-research.sh"
# Refuse to run without a real temp dir: every cleanup below is `rm -f "$BIN"/*`,
# and an empty TMP would make that `rm -f /bin/*`.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/parallel-research-test.XXXXXX" 2>/dev/null)" || TMP=""
if [[ -z "$TMP" || ! -d "$TMP" ]]; then
  echo "FAIL: could not create a temp dir under ${TMPDIR:-/tmp}; refusing to run" >&2
  exit 1
fi
trap 'rm -rf "${TMP:?}"' EXIT
BIN="$TMP/bin"
SYS="$TMP/sys"
mkdir -p "$BIN" "$SYS"
# Only the system tools the scripts need, linked one by one: a real claude,
# codex or grok in /usr/bin would otherwise answer a seat the stubs own.
for t in bash sh env jq sed awk grep find sort head tail tr wc cat mktemp rm \
         mkdir dirname basename sleep timeout gtimeout printf cut chmod; do
  if command -v "$t" >/dev/null 2>&1; then ln -sf "$(command -v "$t")" "$SYS/$t"; fi
done
pass=0
fail=0
has() {
  if [[ "$2" == *"$3"* ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1 — lacks '$3':" >&2; printf '%s\n' "$2" | sed 's/^/    /' >&2; fi
}
lacks() {
  if [[ "$2" != *"$3"* ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1 — has '$3':" >&2; printf '%s\n' "$2" | sed 's/^/    /' >&2; fi
}
rc_is() { if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1 — want rc $3, got $2" >&2; fi; }

# A stub answers with the prompt it was given, prefixed with its name. The
# dispatcher passes the prompt as an argument: after `-p` for grok, last for
# claude and codex.
# shellcheck disable=SC2016  # $2 / $a belong to the stub, not this shell
stub() {
  case "$1" in
    grok) printf '#!/bin/sh\necho "grok says: $2"\n' >"$BIN/grok" ;;
    *)    printf '#!/bin/sh\nfor a; do :; done\necho "%s says: $a"\n' "$1" >"$BIN/$1" ;;
  esac
  chmod +x "$BIN/$1"
}
failing() { printf '#!/bin/sh\nexit 7\n' >"$BIN/$1"; chmod +x "$BIN/$1"; }
slow() { printf '#!/bin/sh\nsleep 5\necho late\n' >"$BIN/$1"; chmod +x "$BIN/$1"; }
reset_bin() { rm -f "${BIN:?}"/*; }

# The fixture panel. Seat order is the table's, so a table that puts codex
# first puts codex on H1 — the case that proves the seats come from the table.
POLICY="$TMP/policy.json"
panel() {
  local voices="" v
  for v in "$@"; do voices="${voices:+$voices,}{\"vendor\":\"$v\",\"model\":\"$v\",\"tracks\":\"\"}"; done
  printf '{"rows":{"panel":{"voices":[%s]}}}\n' "$voices" >"$POLICY"
}

# The PATH is the stubs plus the linked system tools, nothing else.
run() { OUT="$(PATH="$BIN:$SYS" DEBATE_POLICY_JSON="$POLICY" "$BASH" "$SUT" "$@" 2>"$TMP/err")"; RC=$?; }

# Two of three panel CLIs installed: the missing one's seat is argued by another.
reset_bin; stub claude; stub codex; panel claude codex grok
run --h1 "is it the cache" --h2 "is it the clock" --h3 "is it the config"
rc_is "two voices, three seats" "$RC" 0
has "seat 1 is the panel's first voice" "$OUT" "=== H1 (claude)"
has "…with the hypothesis it was given" "$OUT" "claude says: is it the cache"
has "seat 2 is the panel's second voice" "$OUT" "codex says: is it the clock"
has "seat 3's missing voice is stood in for" "$OUT" "claude says: is it the config"
has "…and the block says so" "$OUT" "stood in for grok"
has "summary" "$OUT" "SUMMARY: 3 OK, 0 FAIL, 0 TIMEOUT"
has "a thin panel is said once" "$(cat "$TMP/err")" "[voices] explain"

# The seats are the table's, in the table's order.
reset_bin; stub claude; stub codex; stub grok; panel codex grok claude
run --h1 a --h2 b --h3 c
rc_is "table order" "$RC" 0
has "H1 is the table's first voice" "$OUT" "=== H1 (codex)"
has "H3 is the table's third voice" "$OUT" "claude says: c"
lacks "a full panel is not called thin" "$(cat "$TMP/err")" "[voices]"

# A stand-in that fails too leaves that seat a FAIL, with the others intact.
reset_bin; stub codex; failing grok
cat >"$BIN/claude" <<EOF
#!/bin/sh
if [ -e "$TMP/claude.ran" ]; then exit 3; fi
: > "$TMP/claude.ran"
echo "claude says: first"
EOF
chmod +x "$BIN/claude"; rm -f "$TMP/claude.ran"; panel claude codex grok
run --h1 a --h2 b --h3 c
rc_is "one failing seat still returns the others" "$RC" 0
has "the failing seat is reported" "$OUT" "=== H3 (grok) — FAIL"
has "summary counts it" "$OUT" "SUMMARY: 2 OK, 1 FAIL, 0 TIMEOUT"

# A timed-out seat is a TIMEOUT; seats with no CLI and no stand-in are MISSING.
reset_bin; slow codex; panel claude codex grok
run --h1 a --h2 b --h3 c --timeout 1
rc_is "nothing answered" "$RC" 1
has "the slow seat timed out" "$OUT" "=== H2 (codex) — TIMEOUT after 1s"
has "the uninstalled seat is missing" "$OUT" "=== H1 (claude) — MISSING"
has "summary counts both" "$OUT" "SUMMARY: 0 OK, 2 FAIL, 1 TIMEOUT"

# No panel CLI installed at all.
reset_bin; panel claude codex grok
run --h1 a --h2 b --h3 c
rc_is "no voice installed" "$RC" 1
has "…says what it looked for" "$(cat "$TMP/err")" "no model CLI found on PATH (looked for: claude codex grok)"

# No policy table where the review skill keeps it.
reset_bin; stub claude
OUT="$(PATH="$BIN:$SYS" DEBATE_POLICY_JSON="$TMP/absent.json" "$BASH" "$SUT" --h1 a --h2 b --h3 c 2>&1)"; RC=$?
rc_is "a missing table is an error" "$RC" 1
has "…naming the path" "$OUT" "policy.json not found at $TMP/absent.json"

reset_bin; stub claude; panel claude codex grok
run --h1 a --h2 b
rc_is "a missing hypothesis is a caller error" "$RC" 2
run --h1 a --h2 b --h3 c --timeout 0
rc_is "a timeout outside 1-600 is a caller error" "$RC" 2

# The per-vendor flags live in one place: /debate's dispatcher.
if grep -qE 'codex exec|--output-format|--approval-mode' "$SUT"; then
  fail=$((fail + 1)); echo "FAIL: parallel-research.sh keeps its own copy of a CLI's flags" >&2
else
  pass=$((pass + 1))
fi
if grep -qE 'voices\.sh|reviewer-chain\.sh' "$SUT"; then
  fail=$((fail + 1)); echo "FAIL: parallel-research.sh still sources the retired voices.sh / reviewer-chain.sh" >&2
else
  pass=$((pass + 1))
fi

# Research seats: the grok seat is dispatched with read + search tools.
reset_bin; stub claude; stub codex
printf '#!/bin/sh\nprintf "%%s\\n" "$@" >"%s/grok-argv"\necho "grok says: done"\n' "$TMP" >"$BIN/grok"; chmod +x "$BIN/grok"
panel claude codex grok
rm -f "$TMP/grok-argv"
run --h1 a --h2 b --h3 c
has "the grok research seat can read the repo" "$(tr '\n' ' ' <"$TMP/grok-argv" 2>/dev/null)" "--tools read_file,list_dir,grep"
lacks "…and can search the web" "$(tr '\n' ' ' <"$TMP/grok-argv" 2>/dev/null)" "--disable-web-search"

# This suite deletes with `rm -f "$BIN"/*`: it must refuse to run on an empty or
# failed temp dir, which would turn that into `rm -f /bin/*`. Run it with a
# TMPDIR that cannot hold one and an `rm` that only records what it was asked.
# (PR_GUARD_NESTED stops the nested run from recursing into this block.)
if [[ -z "${PR_GUARD_NESTED:-}" ]]; then
  guard="$(mktemp -d "${TMPDIR:-/tmp}/pr-guard.XXXXXX")"
  printf '#!/bin/sh\necho "$*" >>"%s/rm.log"\n' "$guard" >"$guard/rm"; chmod +x "$guard/rm"
  ( PR_GUARD_NESTED=1 PATH="$guard:$PATH" TMPDIR="$guard/no-such-dir" tmo 60 "$BASH" "$HERE/parallel-research.test.sh" >/dev/null 2>&1 ); grc=$?
  rc_is "an unusable TMPDIR stops the suite" "$([ "$grc" -ne 0 ] && echo stopped || echo ran)" stopped
  lacks "…before any rm is issued" "$(cat "$guard/rm.log" 2>/dev/null)" "/bin"
  /bin/rm -rf "$guard"
fi

echo "parallel-research.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
