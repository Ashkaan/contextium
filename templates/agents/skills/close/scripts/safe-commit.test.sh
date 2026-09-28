#!/usr/bin/env bash
# Boundary rows for safe-commit.sh: no args, no files, clean index, foreign staged work, hook-added files, untracked bystanders.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/safe-commit.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

check() {
  local name="$1" expected_rc="$2" actual_rc="$3"
  if [[ "$expected_rc" == "$actual_rc" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name — expected rc=$expected_rc, got rc=$actual_rc" >&2
  fi
}

assert() {
  local name="$1" cond="$2"
  if [[ "$cond" == "1" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name" >&2
  fi
}

REPO="$TMP/repo"
export CLAUDE_PROJECT_DIR="$REPO"

# Never take the real lock from a test — a 120s hold would block a real close.
export SAFE_COMMIT_LOCK="$TMP/test-repo-git.lock"

setup_repo() {
  rm -rf "$REPO"
  mkdir -p "$REPO"
  git -C "$TMP" init -q repo
  git -C "$REPO" config user.email t@t.test
  git -C "$REPO" config user.name Test
  git -C "$REPO" config commit.gpgsign false
  # core.hooksPath is set globally on this host, so a test repo's .git/hooks is
  # ignored unless the path is pinned locally.
  mkdir -p "$REPO/.githooks"
  git -C "$REPO" config core.hooksPath .githooks
  echo "seed" >"$REPO/seed.txt"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "seed" --no-verify
}

committed_files() { git -C "$REPO" show --name-only --format= HEAD | grep -v '^$' | sort | tr '\n' ' '; }

# --- argument validation ---
setup_repo
"$SCRIPT" >/dev/null 2>&1
check "no subject rejected" 2 $?

"$SCRIPT" "add a thing" >/dev/null 2>&1
check "no file list rejected" 2 $?

# --- clean index: commits exactly the named files ---
setup_repo
echo "mine" >"$REPO/mine.txt"
"$SCRIPT" "add mine" mine.txt >/dev/null 2>&1
check "clean-index commit succeeds" 0 $?
assert "commit holds only mine.txt" "$([[ "$(committed_files)" == "mine.txt " ]] && echo 1)"

# --- THE BUG: another session's staged work must not ride along ---
setup_repo
echo "mine" >"$REPO/mine.txt"
echo "theirs" >"$REPO/theirs.txt"
git -C "$REPO" add theirs.txt          # another session staged this
out=$("$SCRIPT" "add mine" mine.txt 2>&1); rc=$?
check "commit succeeds with foreign staged work present" 0 $rc
assert "commit excludes the foreign file" "$([[ "$(committed_files)" == "mine.txt " ]] && echo 1)"
assert "foreign file reported on stderr" "$(grep -q 'theirs.txt' <<<"$out" && echo 1)"

# --- and their WORK survives: content intact, just unstaged ---
assert "foreign content preserved in working tree" "$([[ "$(cat "$REPO/theirs.txt")" == "theirs" ]] && echo 1)"
assert "foreign file still shows as modified/untracked" "$(git -C "$REPO" status --short | grep -q 'theirs.txt' && echo 1)"

# --- a foreign MODIFICATION to a tracked file is also spared ---
setup_repo
echo "tracked" >"$REPO/tracked.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -qm "add tracked" --no-verify
echo "their edit" >"$REPO/tracked.txt"
git -C "$REPO" add tracked.txt
echo "mine" >"$REPO/mine.txt"
"$SCRIPT" "add mine" mine.txt >/dev/null 2>&1
check "commit succeeds alongside a foreign tracked-file edit" 0 $?
assert "foreign edit not committed" "$([[ "$(committed_files)" == "mine.txt " ]] && echo 1)"
assert "foreign edit still in working tree" "$([[ "$(cat "$REPO/tracked.txt")" == "their edit" ]] && echo 1)"

# --- multiple own files all land ---
setup_repo
echo a >"$REPO/a.txt"; echo b >"$REPO/b.txt"; echo c >"$REPO/c.txt"
git -C "$REPO" add c.txt              # foreign
"$SCRIPT" "add a and b" a.txt b.txt >/dev/null 2>&1
check "multi-file commit succeeds" 0 $?
assert "both own files committed" "$([[ "$(committed_files)" == "a.txt b.txt " ]] && echo 1)"

# --- a pre-commit hook that stages a generated file must still get it in ---
setup_repo
cat >"$REPO/.githooks/pre-commit" <<'HOOK'
#!/usr/bin/env bash
echo "generated" > "$(git rev-parse --show-toplevel)/INDEX.md"
git add INDEX.md
HOOK
chmod +x "$REPO/.githooks/pre-commit"
echo "mine" >"$REPO/mine.txt"
"$SCRIPT" "add mine" mine.txt >/dev/null 2>&1
check "commit succeeds with an index-regenerating hook" 0 $?
assert "hook-staged file rides along (pathspec commit would drop it)" "$(grep -q 'INDEX.md' <<<"$(committed_files)" && echo 1)"

# --- untracked bystanders are never touched ---
setup_repo
echo "mine" >"$REPO/mine.txt"
echo "scratch" >"$REPO/scratch.txt"     # untracked, never staged
"$SCRIPT" "add mine" mine.txt >/dev/null 2>&1
assert "untracked bystander not committed" "$([[ "$(committed_files)" == "mine.txt " ]] && echo 1)"
assert "untracked bystander still present" "$([[ -f "$REPO/scratch.txt" ]] && echo 1)"

# --- nonexistent file is a real failure, not a silent skip ---
setup_repo
"$SCRIPT" "add ghost" ghost.txt >/dev/null 2>&1
rc=$?
assert "nonexistent file fails loudly" "$([[ "$rc" -ne 0 ]] && echo 1)"

if command -v flock >/dev/null 2>&1; then
# --- lock held by another process: wait for it, then proceed ---
# The lock closes the check-then-commit race, so the contended path has to be
# a WAIT, not a failure — a /close that gave up whenever an automation held the
# lock for a second would be useless.
setup_repo
echo "mine" >"$REPO/mine.txt"
flock "$SAFE_COMMIT_LOCK" -c 'sleep 2' &
holder=$!
sleep 0.3                                  # let the holder actually take it
SAFE_COMMIT_LOCK_WAIT=30 "$SCRIPT" "add mine" mine.txt >/dev/null 2>&1
check "waits out a held lock, then commits" 0 $?
assert "waited commit holds only mine.txt" "$([[ "$(committed_files)" == "mine.txt " ]] && echo 1)"
wait "$holder" 2>/dev/null

# --- lock timeout: refuse loud, commit NOTHING, stage NOTHING ---
setup_repo
echo "mine" >"$REPO/mine.txt"
before_sha=$(git -C "$REPO" rev-parse HEAD)
flock "$SAFE_COMMIT_LOCK" -c 'sleep 5' &
holder=$!
sleep 0.3
out=$(SAFE_COMMIT_LOCK_WAIT=1 "$SCRIPT" "add mine" mine.txt 2>&1); rc=$?
check "lock timeout exits 3" 3 $rc
assert "lock timeout says nothing was committed" "$(grep -qi 'NOTHING was staged or committed' <<<"$out" && echo 1)"
assert "lock timeout left HEAD untouched" "$([[ "$(git -C "$REPO" rev-parse HEAD)" == "$before_sha" ]] && echo 1)"
assert "lock timeout staged nothing" "$([[ -z "$(git -C "$REPO" diff --cached --name-only)" ]] && echo 1)"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null

# --- foreign staged work is read INSIDE the lock, not before it ---
# The unstage decision and the commit must be one critical section. If the index read happened outside the
# lock, a file staged while we were waiting would still ride along.
setup_repo
echo "mine" >"$REPO/mine.txt"
echo "theirs" >"$REPO/theirs.txt"
(
  flock "$SAFE_COMMIT_LOCK" -c 'sleep 1.5'
) &
holder=$!
sleep 0.2
( sleep 0.6; git -C "$REPO" add theirs.txt ) &     # staged DURING our wait
stager=$!
SAFE_COMMIT_LOCK_WAIT=30 "$SCRIPT" "add mine" mine.txt >/dev/null 2>&1
check "commits after waiting through a concurrent stage" 0 $?
assert "file staged during the wait did NOT ride along" "$([[ "$(committed_files)" == "mine.txt " ]] && echo 1)"
wait "$holder" "$stager" 2>/dev/null
else
  echo "SKIP: flock not installed — flock contention cases"
fi

# --- no flock (stock macOS): the lock.sh symlink lock ---
setup_repo
echo "mine" >"$REPO/mine.txt"
SAFE_COMMIT_NO_FLOCK=1 "$SCRIPT" "add mine" mine.txt >/dev/null 2>&1
check "fallback lock: commit succeeds" 0 $?
assert "fallback lock: released after the commit" "$([[ ! -L "$SAFE_COMMIT_LOCK.d" ]] && echo 1)"

setup_repo
echo "mine" >"$REPO/mine.txt"
sleep 30 &
live=$!
ln -s "$live" "$SAFE_COMMIT_LOCK.d"
out=$(SAFE_COMMIT_NO_FLOCK=1 SAFE_COMMIT_LOCK_WAIT=1 "$SCRIPT" "add mine" mine.txt 2>&1); rc=$?
check "fallback lock: a live holder times out with exit 3" 3 $rc
assert "fallback lock: timeout says nothing was committed" "$(grep -qi 'NOTHING was staged or committed' <<<"$out" && echo 1)"
assert "fallback lock: the live holder's lock is left alone" "$([[ "$(readlink "$SAFE_COMMIT_LOCK.d")" == "$live" ]] && echo 1)"
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
rm -f "$SAFE_COMMIT_LOCK.d"

setup_repo
echo "mine" >"$REPO/mine.txt"
sh -c 'exit 0' & dead=$!; wait "$dead"
ln -s "$dead" "$SAFE_COMMIT_LOCK.d"
SAFE_COMMIT_NO_FLOCK=1 SAFE_COMMIT_LOCK_WAIT=5 "$SCRIPT" "add mine" mine.txt >/dev/null 2>&1
check "fallback lock: a dead holder's lock is taken over" 0 $?
assert "fallback lock: taken-over commit holds only mine.txt" "$([[ "$(committed_files)" == "mine.txt " ]] && echo 1)"

echo "safe-commit: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
