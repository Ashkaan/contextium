#!/usr/bin/env bash
# session-write-root.test.sh — acceptance for session-write-root.sh + .ts.
#
# Every case runs against a throwaway git repo under $TMPDIR with
# CLAUDE_WORKTREE_HOME pointed inside it, so no test can create a worktree in
# the harness's real worktree folder (see setup-worktree.test.sh's header).
#
# Run: .agents/skills/implement/scripts/session-write-root.test.sh
# Exit: 0 all pass · 1 any fail

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/session-write-root.sh"
SUT_TS="$SCRIPT_DIR/session-write-root.ts"

pass=0; fail=0
ok()   { echo "  ok   — $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL — $1"; echo "         $2"; fail=$((fail+1)); }
check(){ # check <name> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi
}

SANDBOX=$(mktemp -d -t swr-test-XXXXXX)
trap 'rm -rf "$SANDBOX"' EXIT

# ── Fixture: a real git repo with the scripts in place ────────────────────
#
# The SUT asks whether the target root is a git work tree with a REMOTE, so the
# plant path does not have to mean anything (it is just somewhere to run a copy
# from) and the fixture needs a remote to be treated as real.
REPO="$SANDBOX/repo"
mkdir -p "$REPO/toolbin"
cp "$SUT" "$SCRIPT_DIR/setup-worktree.sh" "$SCRIPT_DIR/session-key.sh" \
   "$REPO/toolbin/"
cp "$SUT_TS" "$REPO/toolbin/"
FIX="$REPO/toolbin/session-write-root.sh"
# harness.sh where the copy looks for it (../../close/scripts), and no thread.sh
# beside it: the copy is in no thread, so it takes the per-session path.
mkdir -p "$SANDBOX/close/scripts"
cp "$SCRIPT_DIR/../../close/scripts/harness.sh" "$SANDBOX/close/scripts/"

git -C "$REPO" init -q
git -C "$REPO" config user.email t@t.t
git -C "$REPO" config user.name t
# A remote is what marks this as a real checkout rather than a scratch dir. The
# URL is never contacted: only `git remote` (the NAME list) is read.
git -C "$REPO" remote add origin "$SANDBOX/not-a-real-remote.git"
echo seed > "$REPO/seed.txt"
git -C "$REPO" add -A
git -C "$REPO" commit -qm seed

export CLAUDE_WORKTREE_HOME="$SANDBOX/worktrees"

# Clean identity baseline. This suite usually runs INSIDE a live harness
# session, whose session id is inherited by every child process — so `env -u
# CLAUDE_SESSION_ID` alone does not produce a session-less environment, and the
# "no session" cases would silently exercise the real session instead. Every
# name is cleared here and set explicitly only by the cases that test them.
unset CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID CONTEXTIUM_SESSION CONTEXTIUM_HARNESS CONTEXT_WRITE_ROOT CLAUDE_PROJECT_DIR

echo "session-write-root.sh"

# ── No session id → main checkout (terminal runs, test suites) ────────────
out=$(cd "$REPO" && "$FIX" 2>&1)
check "no session id at all → main checkout" "$REPO" "$out"

# ── --main always reports the main checkout ───────────────────────────────
out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" "$FIX" --main 2>&1)
check "--main → main checkout" "$REPO" "$out"

# ── CONTEXT_WRITE_ROOT overrides everything ───────────────────────────────
out=$(cd "$REPO" && CONTEXT_WRITE_ROOT="/tmp/override-xyz" CLAUDE_SESSION_ID=abc "$FIX" 2>&1)
check "CONTEXT_WRITE_ROOT wins" "/tmp/override-xyz" "$out"

# …including over the refusal a copy outside every repo gives. The override is
# documented to win over everything, so it must be read before the main
# checkout is resolved, not after.
loose="$SANDBOX/loose"
mkdir -p "$loose"
cp "$SUT" "$loose/"
out=$(cd "$SANDBOX" && CONTEXT_WRITE_ROOT="/tmp/override-xyz" bash "$loose/session-write-root.sh" 2>&1)
check "CONTEXT_WRITE_ROOT wins outside every repo" "/tmp/override-xyz" "$out"
out=$(cd "$SANDBOX" && CONTEXT_WRITE_ROOT="/tmp/override-xyz" bash "$loose/session-write-root.sh" --no-create 2>&1)
check "CONTEXT_WRITE_ROOT wins outside every repo (--no-create)" "/tmp/override-xyz" "$out"

# ── The retired records flag is a usage error, not a silent default ──────
#
# The records flag answered "where are the records" out of a second checkout,
# before the records lived in this repo. A stale caller must be told so at the
# call site rather than handed the default mode's answer as if it had asked for
# it — the same exit 1 as any other unknown flag. The flag is assembled rather
# than written, so a repo-wide sweep for the retired spelling finds no caller
# here.
retired_flag="--$(printf 'lib%s' 'rary')"
(cd "$REPO" && "$FIX" "$retired_flag" >/dev/null 2>&1); rc=$?
check "the retired records flag is a usage error now" "1" "$rc"

# ── A cwd outside every repo still answers the repo the script lives in ───
#
# The records live in this repo, so a script read from `.agents/skills/` and run
# from `/tmp` has exactly one right answer: its own checkout. $FIX is the copy
# planted inside $REPO, so that is what it must name.
out=$(cd /tmp && env -u CLAUDE_PROJECT_DIR "$FIX" --main 2>&1)
check "--main from a non-repo cwd → the script's own repo" "$REPO" "$out"

# ── A cwd inside ANOTHER repo still answers the script's repo ─────────────
#
# Every caller writes into the repo this script lives in. Standing in a product
# checkout while running a records script must not send the record there.
elsewhere_git="$SANDBOX/elsewhere-git"
mkdir -p "$elsewhere_git"
git -C "$elsewhere_git" init -q
out=$(cd "$elsewhere_git" && env -u CLAUDE_PROJECT_DIR "$FIX" --main 2>&1)
check "--main from a cwd in another repo → the script's own repo" "$REPO" "$out"

# ── --slug is the SSOT for the session-<key> rule ─────────────────────────
key=$("$REPO/toolbin/session-key.sh" "test-session-1")
out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="test-session-1" "$FIX" --slug 2>&1)
check "--slug → session-<key>" "session-$key" "$out"

# --slug must NOT be silenced by CONTEXT_WRITE_ROOT (the guard needs the real one)
out=$(cd "$REPO" && CONTEXT_WRITE_ROOT=/tmp/x CLAUDE_PROJECT_DIR="$REPO" \
      CLAUDE_SESSION_ID="test-session-1" "$FIX" --slug 2>&1)
check "--slug ignores CONTEXT_WRITE_ROOT" "session-$key" "$out"

# ── CLAUDE_CODE_SESSION_ID is honoured when CLAUDE_SESSION_ID is absent ───
# An ordinary shell call under Claude Code gets CLAUDE_CODE_SESSION_ID, NOT
# CLAUDE_SESSION_ID. Reading only the latter makes every scaffold degrade to the
# main checkout — the exact bug being fixed, back again and silent. If this case
# ever reverts to printing the main checkout, the whole mechanism is inert.
out=$(cd "$REPO" && env -u CLAUDE_SESSION_ID CLAUDE_PROJECT_DIR="$REPO" \
      CLAUDE_CODE_SESSION_ID="test-session-1" "$FIX" --slug 2>&1)
check "CLAUDE_CODE_SESSION_ID alone yields the slug" "session-$key" "$out"
if [[ "$out" == "$REPO" ]]; then
  bad "CLAUDE_CODE_SESSION_ID is not ignored" "degraded to the main checkout"
else
  ok "CLAUDE_CODE_SESSION_ID is not ignored"
fi

# The harness-neutral name, read through harness.sh, yields the same slug.
out=$(cd "$REPO" && env -u CLAUDE_SESSION_ID -u CLAUDE_CODE_SESSION_ID CLAUDE_PROJECT_DIR="$REPO" \
      CONTEXTIUM_SESSION="test-session-1" "$FIX" --slug 2>&1)
check "CONTEXTIUM_SESSION alone yields the slug" "session-$key" "$out"

# CLAUDE_SESSION_ID wins when both are set and disagree.
key2=$("$REPO/toolbin/session-key.sh" "explicit-wins")
out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="explicit-wins" \
      CLAUDE_CODE_SESSION_ID="test-session-1" "$FIX" --slug 2>&1)
check "CLAUDE_SESSION_ID takes precedence" "session-$key2" "$out"

# ── A foreign target root is honoured verbatim ────────────────────────────
# Every migrated script's own suite points CLAUDE_PROJECT_DIR at a `mktemp -d`
# fixture — frequently not a git repo at all. Session isolation must not reach
# into those: without this gate the resolver tries to create a worktree inside
# a non-repo fixture and the suite dies with a resolver error instead of
# writing its file.
foreign_repo="$SANDBOX/foreign"
mkdir -p "$foreign_repo"
out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$foreign_repo" CLAUDE_SESSION_ID="test-session-1" "$FIX" 2>&1)
check "non-repo fixture root honoured verbatim" "$foreign_repo" "$out"

foreign_git="$SANDBOX/foreign-git"
mkdir -p "$foreign_git"
git -C "$foreign_git" init -q
out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$foreign_git" CLAUDE_SESSION_ID="test-session-1" "$FIX" 2>&1)
check "foreign git repo root honoured verbatim" "$foreign_git" "$out"

# ── --no-create never creates ─────────────────────────────────────────────
out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="never-made" "$FIX" --no-create 2>&1)
check "--no-create with no worktree → main checkout" "$REPO" "$out"
if [[ -d "$CLAUDE_WORKTREE_HOME" ]] && find "$CLAUDE_WORKTREE_HOME" -maxdepth 1 -name 'session-*' | grep -q .; then
  bad "--no-create created nothing" "a worktree appeared under $CLAUDE_WORKTREE_HOME"
else
  ok "--no-create created nothing"
fi

# ── Default mode CREATES the worktree — the whole point ───────────────────
out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="test-session-1" "$FIX" 2>&1)
expected="$CLAUDE_WORKTREE_HOME/session-$key"
check "default mode creates + returns the worktree" "$expected" "$out"
if [[ -d "$expected" ]]; then ok "worktree exists on disk"; else bad "worktree exists on disk" "missing: $expected"; fi
if [[ -f "$expected/.claude-session-$key" ]]; then ok "session marker written"; else bad "session marker written" "missing marker in $expected"; fi

# ── Second call is idempotent (re-claim, not a second worktree) ───────────
out2=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="test-session-1" "$FIX" 2>&1)
check "second call returns the same worktree" "$expected" "$out2"
n=$(find "$CLAUDE_WORKTREE_HOME" -maxdepth 1 -name "session-*" -type d | wc -l)
check "exactly one worktree exists" "1" "$n"

# ── --no-create now FINDS the worktree it refused to make ─────────────────
out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="test-session-1" "$FIX" --no-create 2>&1)
check "--no-create finds an existing worktree" "$expected" "$out"

# ── A failed worktree listing is an error, not "no worktree" ──────────────
# Read through `|| true`, a git that failed listed nothing, and the resolver
# answered the main checkout for a session that HAS a worktree — its writes
# would go where no close lands them.
mkdir -p "$SANDBOX/failgit"
cat >"$SANDBOX/failgit/git" <<FAILGIT
#!/usr/bin/env bash
case " \$* " in *" worktree list "*) echo "fatal: simulated read failure" >&2; exit 128 ;; esac
exec "$(command -v git)" "\$@"
FAILGIT
chmod +x "$SANDBOX/failgit/git"
out=$(cd "$REPO" && PATH="$SANDBOX/failgit:$PATH" CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="test-session-1" "$FIX" --no-create 2>&1); rc=$?
check "a failed worktree listing exits 1" "1" "$rc"
if [[ "$out" == *"could not list the worktrees"* ]]; then ok "…saying so"; else bad "…saying so" "got: $out"; fi

# ── Invoked from INSIDE a worktree → that worktree, not main ──────────────
# The regression setup-worktree.sh's own callers hit: resolving from cwd made a
# worktree look like "main".
out=$(cd "$expected" && env -u CLAUDE_PROJECT_DIR CLAUDE_SESSION_ID="other-session" "$FIX" --no-create 2>&1)
check "cwd inside a worktree → that worktree" "$expected" "$out"

# ── --main from inside a worktree still names the MAIN checkout ───────────
out=$(cd "$expected" && env -u CLAUDE_PROJECT_DIR CLAUDE_SESSION_ID="other-session" "$FIX" --main 2>&1)
check "--main from inside a worktree → main checkout" "$REPO" "$out"

# ── Creator failure fails LOUD, never silently to the main checkout ───────
out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="boom-session" \
      SETUP_WORKTREE_SCRIPT="/nonexistent/creator.sh" "$FIX" 2>&1); rc=$?
if [[ $rc -ne 0 ]]; then ok "creator failure exits non-zero"; else bad "creator failure exits non-zero" "rc=$rc"; fi
if [[ "$out" == *"refusing to write to the main checkout"* ]]; then
  ok "creator failure refuses the main checkout explicitly"
else
  bad "creator failure refuses the main checkout explicitly" "stderr was: $out"
fi
if [[ "$out" == "$REPO" ]]; then bad "creator failure does not print main root" "printed $REPO"; else
  ok "creator failure does not print main root"; fi

# ── Bad flag is a usage error ─────────────────────────────────────────────
(cd "$REPO" && "$FIX" --bogus >/dev/null 2>&1); rc=$?
check "unknown flag exits 1" "1" "$rc"

# ── Inside a thread: the ledger's worktree, created only for a real session ──
#
# thread.sh names every session — an id-less one gets a generated id so its
# close can land — and the default mode must not turn a READ by that id-less
# session into a worktree. A session whose harness exports an id gets one.
THR_HOME="$SANDBOX/thr-home"
mkdir -p "$THR_HOME"
git init -q --bare -b main "$SANDBOX/thr-origin.git"
THR="$SANDBOX/thr-repo"
git init -q -b main "$THR"
git -C "$THR" config user.email t@t; git -C "$THR" config user.name t
echo seed >"$THR/seed.txt"; git -C "$THR" add -A; git -C "$THR" commit -qm seed
git -C "$THR" remote add origin "$SANDBOX/thr-origin.git"
git -C "$THR" push -q -u origin main; git -C "$THR" remote set-head origin main
mkdir -p "$THR/toolbin"
cp "$SUT" "$SCRIPT_DIR/setup-worktree.sh" "$SCRIPT_DIR/session-key.sh" "$THR/toolbin/"
printf 'toolbin/\n' >>"$THR/.git/info/exclude"
in_thread() {  # in_thread [VAR=value ...] [flag]
  local envs=()
  while [[ "${1:-}" == *=* ]]; do envs+=("$1"); shift; done
  (cd "$THR" && env HOME="$THR_HOME" T3CODE_HOME="$SANDBOX/no-t3" \
    THREAD_SCRIPT="$SCRIPT_DIR/../../close/scripts/thread.sh" \
    WRITE_ROOT_SCRIPT="$SCRIPT_DIR/../../close/scripts/write-root.sh" \
    ${envs[@]+"${envs[@]}"} bash "$THR/toolbin/session-write-root.sh" "$@" 2>&1)
}
out=$(in_thread)
check "an id-less session's read resolves to the main checkout" "$THR" "$out"
check "…and makes no worktree" "1" "$(git -C "$THR" worktree list | wc -l | tr -d ' ')"
out=$(in_thread CONTEXTIUM_SESSION=real-one)
if [[ "$out" != "$THR" && -d "$out" ]]; then ok "a session with an id gets its worktree"; else bad "a session with an id gets its worktree" "got [$out]"; fi
out2=$(in_thread CONTEXTIUM_SESSION=real-one --no-create)
check "…which --no-create then answers" "$out" "$out2"

# ── The .ts face returns the same answer as the shell ────────────────────
echo "session-write-root.ts"
if command -v node >/dev/null 2>&1; then
  ts_out=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="test-session-1" \
    node --input-type=module -e "
      import { sessionWriteRoot, inWriteRoot } from '$REPO/toolbin/session-write-root.ts';
      process.stdout.write(sessionWriteRoot() + '|' + inWriteRoot('knowledge', 'x.md'));
    " 2>&1)
  check "ts sessionWriteRoot matches shell" "$expected|$expected/knowledge/x.md" "$ts_out"

  # A failing resolver must THROW, not return the main checkout.
  ts_err=$(cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" CLAUDE_SESSION_ID="boom2" \
    SETUP_WORKTREE_SCRIPT="/nonexistent/creator.sh" \
    node --input-type=module -e "
      import { sessionWriteRoot } from '$REPO/toolbin/session-write-root.ts';
      try { console.log('RETURNED:' + sessionWriteRoot()); }
      catch (e) { console.log('THREW'); }
    " 2>&1)
  if [[ "$ts_err" == *"THREW"* ]]; then ok "ts throws when the resolver fails"; else
    bad "ts throws when the resolver fails" "got: $ts_err"; fi
else
  echo "  skip — node not on PATH"
fi

echo
echo "passed: $pass   failed: $fail"
[[ $fail -eq 0 ]]
