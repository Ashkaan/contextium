#!/usr/bin/env bash
# Tests for check-shared-checkout-write.sh.
#
# Run: bash templates/agents/hooks/check-shared-checkout-write.test.sh
#
# Hermetic. HOME, the three guarded checkouts, write-root.sh and thread.sh are
# all fixtures, so nothing here reads a live repo or creates a real worktree.
#
# Both directions matter and they are NOT symmetric. A missed refusal leaves a
# file in a shared checkout that no close will commit, and one the close-time
# backstop catches only sometimes. A wrongly-refused
# write stops the session dead, and a guard that refuses
# `bash <skills>/close/scripts/verify.sh` — a command that only NAMES a guarded
# path — gets turned off, after which it guards nothing. So the allow cases
# below are as load-bearing as the refuse cases.

set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/check-shared-checkout-write.sh"
[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

pass=0
fail=0

FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

# HOME is the fixture root so `$HOME/.agents/skills` really is the home link
# into the checkout's .agents/skills/ — the unexpanded-tilde case below is about a path
# the hook must expand itself, and it can only be written honestly if that
# spelling reaches a guarded root through the link the harnesses read.
export HOME="$FIX"

WORKBENCH="$FIX/checkouts/workbench"
RECORDS="$WORKBENCH"
SKILLS="$WORKBENCH/.agents/skills"
WORKTREE="$FIX/worktrees/workbench/thread-1"
mkdir -p "$SKILLS/close/scripts" "$WORKBENCH" "$WORKTREE" "$FIX/.agents"
ln -s "$SKILLS" "$FIX/.agents/skills"

# ── The two scripts the hook shells out to, stubbed ───────────────────────
# Every `--main` question is logged: the one repo is asked about once, and a
# hook still asking about the retired skills and library checkouts would spend
# a bounded wait on each answer that cannot come.
WR="$FIX/write-root.sh"
WR_LOG="$FIX/write-root-calls.log"
cat > "$WR" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "--main" ]; then
  printf '%s\n' "\${2:-}" >> "$WR_LOG"
  printf '%s\n' "$WORKBENCH"
  exit 0
fi
printf '%s\n' "$WORKTREE"
STUB

TH="$FIX/thread.sh"
printf '#!/usr/bin/env bash\nprintf %%s thread-1\n' > "$TH"

NO_THREAD="$FIX/no-thread.sh"
printf '#!/usr/bin/env bash\nexit 1\n' > "$NO_THREAD"

# write-root.sh that never answers, for the degrade case.
HUNG="$FIX/hung-write-root.sh"
cat > "$HUNG" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "--main" ]; then
  printf '%s\n' "$WORKBENCH"
  exit 0
fi
sleep 30
STUB

chmod +x "$WR" "$TH" "$NO_THREAD" "$HUNG"

export CHECK_SHARED_WRITE_ROOT_SCRIPT="$WR"
export CHECK_SHARED_WRITE_THREAD_SCRIPT="$TH"
# 1s, not 20s: the degrade case asserts the bound exists, and asserting it at
# its production value would cost 20s of wall clock on every run of this suite.
export CHECK_SHARED_WRITE_TIMEOUT=1

# ── Harness ───────────────────────────────────────────────────────────────
run_tool() {          # <tool> <json tool_input>
  local tool="$1" input="$2"
  jq -nc --arg t "$tool" --argjson i "$input" --arg c "$FIX" \
    '{tool_name: $t, tool_input: $i, cwd: $c}' \
    | bash "$HOOK" >/dev/null 2>&1
  echo $?
}

run_bash() {          # <command> [cwd]
  local cmd="$1" cwd="${2:-$FIX}"
  jq -nc --arg c "$cmd" --arg d "$cwd" \
    '{tool_name: "Bash", tool_input: {command: $c}, cwd: $d}' \
    | bash "$HOOK" >/dev/null 2>&1
  echo $?
}

expect() {            # <want-rc> <label> <got-rc>
  if [ "$3" = "$1" ]; then
    pass=$((pass + 1))
    echo "ok: $2"
  else
    fail=$((fail + 1))
    echo "FAIL $2 — wanted exit $1, got $3" >&2
  fi
}

path_refuses() { expect 2 "$1" "$(run_tool "$2" "$3")"; }
path_allows()  { expect 0 "$1" "$(run_tool "$2" "$3")"; }
bash_refuses() { expect 2 "$1" "$(run_bash "$2" "${3:-$FIX}")"; }
bash_allows()  { expect 0 "$1" "$(run_bash "$2" "${3:-$FIX}")"; }

fp() { jq -nc --arg p "$1" '{file_path: $p}'; }

# ── The guarded checkout: a skill, a record, a code file ──────────────────
path_refuses "Edit under .agents/skills/" \
  Edit "$(fp "$SKILLS/close/SKILL.md")"

# ── One repo, asked about once ────────────────────────────────────────────
# The guarded root is the hook's own repo, resolved through `--main` on the
# hook's directory — one resolver call per write, each with a bounded wait,
# not one per folder the checkout holds.
asked=$(grep -c . "$WR_LOG" 2>/dev/null || echo 0)
if [ "$asked" -eq 1 ] && [ "$(cat "$WR_LOG")" = "$(dirname "$HOOK")" ]; then
  pass=$((pass + 1)); echo "ok: one --main question, about the hook's own repo"
else
  fail=$((fail + 1)); echo "FAIL one --main question — got $asked: $(tr '\n' ' ' < "$WR_LOG")" >&2
fi
path_refuses "Edit of a record in the checkout" \
  Edit "$(fp "$RECORDS/journal/2026-09-16/0000-x.md")"
path_refuses "Edit in the code checkout" \
  Edit "$(fp "$WORKBENCH/apps/web/x/README.md")"

# ── The same relative path under a worktree is the whole point ────────────
path_allows "Edit in this thread's worktree" \
  Edit "$(fp "$WORKTREE/close/SKILL.md")"
path_allows "Edit somewhere else entirely" \
  Edit "$(fp "$FIX/scratch/note.md")"

# ── The other write tools ─────────────────────────────────────────────────
path_refuses "Write in a guarded checkout"    Write "$(fp "$SKILLS/new.sh")"
path_refuses "MultiEdit in a guarded checkout" \
  MultiEdit "$(fp "$SKILLS/close/scripts/verify.sh")"
# NotebookEdit names its target `notebook_path`. A guard reading only
# `file_path` lets every notebook write through.
path_refuses "NotebookEdit via notebook_path" NotebookEdit \
  "$(jq -nc --arg p "$SKILLS/nb.ipynb" '{notebook_path: $p}')"
path_allows "Read is not a write" \
  Read "$(fp "$SKILLS/close/SKILL.md")"

# ── An unexpanded tilde is how a quoted path reaches a hook ───────────────
# Without the expansion the path is under no guarded root and the guard fails
# open silently — the identical literal-tilde defect that broke
# a test in the author skill.
# shellcheck disable=SC2088  # the unexpanded tilde is the INPUT under test —
# expanding it here would test a different path entirely.
path_refuses "unexpanded ~/ path" \
  Edit "$(fp '~/.agents/skills/close/SKILL.md')"

# ── One case per promised Bash write form ─────────────────────────────────
bash_refuses "> redirection"        "echo hi > $SKILLS/f"
bash_refuses ">> redirection"       "echo hi >> $SKILLS/f"
bash_refuses "tee"                  "echo hi | tee $SKILLS/f"
bash_refuses "tee -a"               "echo hi | tee -a $SKILLS/f"
bash_refuses "sed -i"               "sed -i 's/a/b/' $SKILLS/f"
bash_refuses "sed -i -e"            "sed -i -e 's/a/b/' $SKILLS/f"
bash_refuses "cp destination"       "cp /tmp/a $SKILLS/f"
bash_refuses "mv destination"       "mv /tmp/a $SKILLS/f"
bash_refuses "ln -s destination"    "ln -s /tmp/a $SKILLS/f"
bash_refuses "install destination"  "install -m 644 /tmp/a $SKILLS/f"
bash_refuses "rm"                   "rm -rf $SKILLS/close"
bash_refuses "mkdir"                "mkdir -p $SKILLS/newdir"
bash_refuses "touch"                "touch $SKILLS/f"

# The SOURCE of a copy is a read, not a write.
bash_allows "cp out of a checkout"  "cp $SKILLS/f /tmp/a"

# ── Two targets, only the second guarded ──────────────────────────────────
bash_refuses "second target guarded" "touch /tmp/ok $SKILLS/f"
bash_refuses "guarded write after an innocent one" \
  "echo a > /tmp/ok; echo b > $RECORDS/f"

# ── A relative target after a directory change ───────────────────────────
bash_refuses "cd then touch"        "cd $SKILLS && touch f"
bash_refuses "cd with a tilde"      'cd ~/.agents/skills && touch f'
bash_refuses "cd then redirect"     "cd $RECORDS && echo x > notes.md"
bash_allows  "cd elsewhere then touch" "cd /tmp && touch f"
# An unresolvable `cd` makes every later relative target unknowable, and
# unknowable fails OPEN — see the hook's KNOWN-and-DECLINED list.
# shellcheck disable=SC2016  # the unexpanded `$SOMEWHERE` is the INPUT under
# test — a hook that cannot resolve the directory must fail open, and expanding
# it here would hand the hook a resolvable path and test the other branch.
bash_allows "cd to a variable, then a relative write" \
  'cd "$SOMEWHERE" && touch f'

# ── The false positive that would make the hook unusable ─────────────────
# Naming a guarded path is not writing to it. A guard that refused this would
# be turned off within the hour.
bash_allows "running a script from a guarded checkout" \
  "bash $SKILLS/close/scripts/verify.sh"
bash_allows "reading a file in a guarded checkout" \
  "cat $SKILLS/close/SKILL.md"
bash_allows "grepping a guarded checkout"              "grep -rn foo $SKILLS"
bash_allows "git in a guarded checkout" \
  "git -C $SKILLS status --porcelain"
bash_allows "cd into a guarded checkout and read"      "cd $SKILLS && ls -la"
bash_allows "a sed WITHOUT -i is a read"               "sed -n '1,5p' $SKILLS/f"
bash_allows "not a write at all"                       "npm test"
bash_allows "an empty command"                         ""

# ── Found by the machine reviewer, round 1 ───────────────────────────────
#
# Six bypasses and one false block, every one of them reproduced against the
# hook before it was fixed. Four shared a single cause — the parser deleted
# quote CHARACTERS instead of consuming quoted SPANS — and the fix was to give
# lib/shell-segments.sh a tagged tokenizer both hooks now use.

# A quoted path is ONE word. Deleting the quotes split it at its space and
# handed the caller `file` as the destination, which is under no guarded root.
bash_refuses "a quoted destination with a space" "cp /tmp/a \"$SKILLS/my file\""
bash_refuses "a single-quoted target with a space" "touch '$SKILLS/my file'"
bash_refuses "an escaped space in the target"    "touch $SKILLS/my\\ file"

# The mirror, and the reason the tokenizer had to be quote-AWARE rather than
# quote-blind in the other direction: a `>` inside quotes is prose. Refusing
# these would make every doc edit and every commit message about redirection
# unwritable.
bash_allows "a redirection inside single quotes" "printf '%s' '> $SKILLS/f'"
bash_allows "a redirection inside double quotes" \
  "echo \"write it with > $SKILLS/f\""
bash_allows "a redirection named in a message" \
  "git commit -m 'use > $SKILLS/f'"

# A newline inside an open quote is not a segment break. Printing one segment
# per input line read the second line of a multiline string as a command.
bash_allows "a newline inside a quoted string" \
  "$(printf 'echo "line one\nrm %s/close"' "$SKILLS")"

# The verb is the first word that is not a wrapper or an assignment.
bash_refuses "env wrapper"           "env X=1 touch $SKILLS/f"
bash_refuses "env with its own flag" "env -i PATH=/bin touch $SKILLS/f"
bash_refuses "a leading assignment"  "X=1 cp /tmp/a $SKILLS/f"
bash_refuses "sudo wrapper"          "sudo touch $SKILLS/f"

# `-t` carries the destination and makes every operand a source; `install -d`
# makes every operand a directory to create. Reading only the last operand
# checked a SOURCE path and let both through.
bash_refuses "cp -t"                 "cp -t $SKILLS /tmp/a"
bash_refuses "cp --target-directory" "cp --target-directory $SKILLS /tmp/a"
bash_refuses "cp --target-directory=" "cp --target-directory=$SKILLS /tmp/a"
bash_refuses "mv -t"                 "mv -t $SKILLS /tmp/a"
bash_refuses "install -d, first operand" "install -d $SKILLS/a /tmp/b"

# The mirror: a flag argument that is NOT a destination must not be tested as
# one, or `install -m 644` checks `644` and never looks at the real target.
bash_refuses "install -m still finds the destination" \
  "install -m 644 /tmp/a $SKILLS/f"
bash_refuses "sed -i -e still finds the file" "sed -i -e 's/a/b/' $SKILLS/f"
bash_refuses "touch -r still finds the file"  "touch -r /tmp/ref $SKILLS/f"
bash_allows  "touch -r reference is not a target" "touch -r $SKILLS/ref /tmp/f"

# A file descriptor is not an operand.
bash_refuses "fd-qualified redirection" "cmd 2> $SKILLS/f"
bash_allows  "a here-string is a read"  "cat <<< \"$SKILLS/f\""

# Everything after `--` is an operand whatever it looks like.
bash_refuses "a target after --" "rm -- $SKILLS/f"

# ── Found by the machine reviewer, round 2 ───────────────────────────────
#
# Four more, all reproduced before they were fixed. Three were bypasses in the
# operand walk; the fourth was a false refusal on a command that only READS.

# An input redirection names a file being read. Leaving it among the operands
# refused `tee /tmp/out < <guarded>/input`, which writes nothing here.
bash_allows "an input redirection is a read" \
  "tee /tmp/out < $SKILLS/input"
bash_allows "an input redirection into a guarded-path read" \
  "sort < $SKILLS/f > /tmp/out"

# A file descriptor is ATTACHED to its `>`. Dropping any numeric word before a
# redirect lost the file literally named `2`.
bash_refuses "a file literally named 2" "cd $SKILLS && touch 2 > /tmp/log"
bash_allows  "an attached fd is still not an operand" "echo x 2> /tmp/log"

# A wrapper option that takes an argument must take it, or the argument
# becomes the verb and the real command is never looked at.
bash_refuses "sudo -u with a separate argument" "sudo -u root touch $SKILLS/f"
bash_refuses "sudo -u with an attached argument" "sudo -uroot touch $SKILLS/f"
bash_refuses "env -u before the verb" "env -u FOO touch $SKILLS/f"

# An attached short-option argument, and a cluster whose argument-taking letter
# is not the last one.
bash_refuses "cp -t attached"  "cp -t$SKILLS /tmp/a"
bash_refuses "cp -St cluster"  "cp -St src $SKILLS/f"
bash_refuses "install -m attached" "install -m644 /tmp/a $SKILLS/f"

# The mirror: an attached argument that is NOT a destination must not be
# tested as one.
bash_allows "install -m attached mode is not a destination" \
  "install -m$SKILLS 644 /tmp/a /tmp/b"

# ── Found by the machine reviewer, round 3 ───────────────────────────────

# A file descriptor is UNQUOTED digits touching the operator. Quoting makes it
# an ordinary filename, and dropping it there lost the write entirely.
bash_refuses "a quoted 2 is a filename, not an fd" \
  "cd $SKILLS && touch \"2\">/tmp/log"
bash_refuses "an escaped 2 is a filename too" "cd $SKILLS && touch 2\\>/tmp/log"
bash_allows  "an unquoted attached fd is still an fd" "echo x 2>/tmp/log"

# An INPUT descriptor is attached too. Leaving `0` as a word made it read as
# the command, so the real verb was never looked at.
bash_refuses "an attached input descriptor" "0</tmp/in touch $SKILLS/f"

# Every wrapper option that consumes the next word, short and long.
bash_refuses "env -u"        "env -u FOO touch $SKILLS/f"
bash_refuses "env --unset"   "env --unset FOO touch $SKILLS/f"
bash_refuses "env --unset="  "env --unset=FOO touch $SKILLS/f"
bash_refuses "env -S"        "env -S x touch $SKILLS/f"
bash_refuses "exec -a"       "exec -a name touch $SKILLS/f"
bash_refuses "sudo --user"   "sudo --user root touch $SKILLS/f"
bash_refuses "sudo --user="  "sudo --user=root touch $SKILLS/f"
bash_refuses "stdbuf -o"     "stdbuf -o L touch $SKILLS/f"
bash_refuses "stdbuf --output" "stdbuf --output L touch $SKILLS/f"

# The mirror: a wrapper option that takes NO argument must not eat the verb.
bash_refuses "env -i takes no argument" "env -i touch $SKILLS/f"
bash_refuses "sudo -n takes no argument" "sudo -n touch $SKILLS/f"

# ── A delete that removes only untracked content is not a write ──────────
# The hook exists to stop content landing in a shared checkout outside any
# ledger. Deleting a file git does not track lands nothing and leaves nothing
# for a close to miss — it makes the checkout CLEANER. A harness's skill sync
# can write `~/.claude/skills/synced/` (= the skills checkout through the
# symlink), and refusing its cleanup is the wrong outcome. Tracked content
# still refuses, and so does
# a root that is not a git repository at all — the distinction needs git's
# answer, and without one the old refusal stands.
git -C "$RECORDS" init -q
git -C "$RECORDS" -c user.name=t -c user.email=t@t config commit.gpgsign false
mkdir -p "$RECORDS/journal/2026-09-18" "$RECORDS/synced/bucket-1/docx" "$RECORDS/gen"
printf 'tracked\n' > "$RECORDS/journal/2026-09-18/0000-x.md"
printf 'tracked\n' > "$RECORDS/gen/keep.md"
printf '*.log\n' > "$RECORDS/.gitignore"
git -C "$RECORDS" add -A
git -C "$RECORDS" -c user.name=t -c user.email=t@t commit -q -m fixture
printf 'copied\n' > "$RECORDS/synced/bucket-1/docx/SKILL.md"
printf 'stray\n'  > "$RECORDS/stray.txt"
printf 'noise\n'  > "$RECORDS/gen/out.log"

bash_allows  "rm of an untracked directory"      "rm -rf $RECORDS/synced"
bash_allows  "rm of an untracked file"           "rm $RECORDS/stray.txt"
bash_allows  "rm of a gitignored file"           "rm $RECORDS/gen/out.log"
bash_allows  "rm of a path that does not exist"  "rm -f $RECORDS/nothing-here"
bash_refuses "rm of a tracked file"              "rm $RECORDS/journal/2026-09-18/0000-x.md"
bash_refuses "rm of a directory holding tracked content" "rm -rf $RECORDS/gen"
bash_refuses "rm of the checkout itself"         "rm -rf $RECORDS"
bash_refuses "rm mixing tracked and untracked"   "rm $RECORDS/stray.txt $RECORDS/gen/keep.md"
# Only rm gets the carve-out: creating an untracked file is exactly the failure.
bash_refuses "touch of an untracked path is still a write" "touch $RECORDS/new-stray.txt"

# ── Removing a SYMLINK is not a write to what it points at ───────────────
# A link in a harness home that points into this checkout is removed without
# touching the checkout: removing it unlinks an entry in that home. Resolving
# the leaf would charge the delete to the target, and every harness home holds
# links like it, so a refusal there would be a whole class, not one path.
#
# The PARENT is still resolved, because a link entry lives in a directory and
# that directory is what the delete writes to.
mkdir -p "$FIX/linkfarm"
ln -s "$RECORDS/journal/2026-09-18/0000-x.md" "$FIX/linkfarm/tracked-link"
ln -s "$RECORDS/journal" "$FIX/linkfarm/journal-link"
bash_allows  "rm of a symlink that points at tracked content" \
  "rm $FIX/linkfarm/tracked-link"
bash_refuses "rm THROUGH a symlinked parent still refuses" \
  "rm $FIX/linkfarm/journal-link/2026-09-18/0000-x.md"
ln -s journal/2026-09-18/0000-x.md "$RECORDS/tracked-self-link"
git -C "$RECORDS" add -A
git -C "$RECORDS" -c user.name=t -c user.email=t@t commit -q -m link-fixture
bash_refuses "rm of a TRACKED symlink inside a guarded checkout still refuses" \
  "rm $RECORDS/tracked-self-link"


# ── A write that reaches no guarded checkout creates nothing ──────────────
#
# thread.sh --id records a session (a cache entry per thread) as a side effect.
# The guard used to ask it before looking at where the write lands, so every
# `2>/dev/null` made a session entry. It is asked only once a target is inside
# a guarded checkout.
TH_LOG="$FIX/thread-calls.log"
LOGGING_TH="$FIX/logging-thread.sh"
printf '#!/usr/bin/env bash\necho "$*" >> "%s"\nprintf %%s thread-1\n' "$TH_LOG" > "$LOGGING_TH"
chmod +x "$LOGGING_TH"
thread_calls() {      # <command> — how many times the hook asked thread.sh
  : > "$TH_LOG"
  jq -nc --arg c "$1" --arg d "$FIX" '{tool_name: "Bash", tool_input: {command: $c}, cwd: $d}' \
    | CHECK_SHARED_WRITE_THREAD_SCRIPT="$LOGGING_TH" bash "$HOOK" >/dev/null 2>&1
  wc -l < "$TH_LOG" | tr -d ' '
}
expect 0 "2>/dev/null asks nothing of the session"        "$(thread_calls "grep x /etc/hosts 2>/dev/null")"
expect 0 "> /dev/null asks nothing of the session"        "$(thread_calls "echo x > /dev/null")"
expect 0 ">/dev/stderr asks nothing of the session"       "$(thread_calls "echo x >/dev/stderr")"
expect 0 ">/dev/stdout asks nothing of the session"       "$(thread_calls "echo x >/dev/stdout")"
expect 0 "a write outside every checkout asks nothing"    "$(thread_calls "echo x > $FIX/scratch/out.txt")"
expect 1 "a write into the shared checkout still asks"    "$(thread_calls "echo x > $SKILLS/f")"

# ── Degrading, and failing open ──────────────────────────────────────────
# write-root.sh that never answers: the hook still REFUSES, and does it inside
# the bound rather than hanging the session for the duration of the flock.
started=$(date +%s)
rc=$(CHECK_SHARED_WRITE_ROOT_SCRIPT="$HUNG" run_tool Edit "$(fp "$SKILLS/f")")
elapsed=$(( $(date +%s) - started ))
expect 2 "a hung write-root still refuses" "$rc"
if [ "$elapsed" -le 10 ]; then
  pass=$((pass + 1)); echo "ok: the refusal is bounded (${elapsed}s)"
else
  fail=$((fail + 1)); echo "FAIL the refusal is bounded — took ${elapsed}s" >&2
fi

# No thread means no worktree to offer, and write-root.sh exits 2 in that case
# by design. A plain terminal must stay able to write.
rc=$(CHECK_SHARED_WRITE_THREAD_SCRIPT="$NO_THREAD" \
  run_tool Edit "$(fp "$SKILLS/f")")
expect 0 "no thread fails open" "$rc"

# A checkout whose resolution fails is simply unguarded for this invocation —
# the other two still apply, and a resolver failure never becomes a blanket
# refusal.
BROKEN="$FIX/broken-write-root.sh"
printf '#!/usr/bin/env bash\nexit 2\n' > "$BROKEN"
chmod +x "$BROKEN"
rc=$(CHECK_SHARED_WRITE_ROOT_SCRIPT="$BROKEN" \
  run_tool Edit "$(fp "$SKILLS/f")")
expect 0 "every resolution failing is not a blanket refusal" "$rc"

# ── The other two harnesses ───────────────────────────────────────────────
#
# Every case here is RED against a hook that reads `.tool_name` alone: a Codex
# `apply_patch` matches no branch and an Antigravity payload leaves at the
# empty-TOOL check having examined no path, so all eight refusals below come
# back exit 0 — guarded-looking and guarding nothing.

# Codex: the tool is named `apply_patch` and the paths live in the patch body.
run_codex_patch() {    # <patch body> [cwd]
  local patch="$1" cwd="${2:-$FIX}"
  jq -nc --arg c "$patch" --arg d "$cwd" \
    '{tool_name: "apply_patch", tool_input: {command: $c}, cwd: $d}' \
    | bash "$HOOK" >/dev/null 2>&1
  echo $?
}

codex_refuses() { expect 2 "$1" "$(run_codex_patch "$2" "${3:-$FIX}")"; }
codex_allows()  { expect 0 "$1" "$(run_codex_patch "$2" "${3:-$FIX}")"; }

codex_refuses "codex apply_patch — Add File" \
  "*** Begin Patch
*** Add File: $RECORDS/journal/2026-09-18/new.md
+hello
*** End Patch"

codex_refuses "codex apply_patch — Update File" \
  "*** Begin Patch
*** Update File: $SKILLS/qa/SKILL.md
@@
-old
+new
*** End Patch"

codex_refuses "codex apply_patch — Delete File" \
  "*** Begin Patch
*** Delete File: $WORKBENCH/apps/x.ts
*** End Patch"

codex_refuses "codex apply_patch — Move to (the DESTINATION is the write)" \
  "*** Begin Patch
*** Update File: $FIX/scratch/a.md
*** Move to: $RECORDS/knowledge/a.md
*** End Patch"

# One patch, many files. Reading only the first is the whole reason this walks
# every verb line: here the first file is outside every guarded root.
codex_refuses "codex apply_patch — only the SECOND file is in a shared checkout" \
  "*** Begin Patch
*** Add File: $FIX/scratch/safe.md
+fine
*** Update File: $SKILLS/close/scripts/land.sh
@@
-x
+y
*** End Patch"

# Envelope paths may be relative; they resolve against the normalized cwd.
codex_refuses "codex apply_patch — relative path under a guarded cwd" \
  "*** Begin Patch
*** Add File: journal/2026-09-18/rel.md
+hello
*** End Patch" "$RECORDS"

codex_allows "codex apply_patch outside every guarded checkout" \
  "*** Begin Patch
*** Add File: $FIX/scratch/ok.md
+fine
*** End Patch"

# A known write tool that yields no path is a broken parser, not a safe call.
codex_refuses "codex apply_patch naming no file refuses rather than fails open" \
  "*** Begin Patch
@@
+orphan hunk
*** End Patch"

# Antigravity: `toolCall`, camelCase, and a JSON verdict on stdout. The exit
# code is ignored there, so asserting on it would pass while the model was told
# nothing — these two helpers read stdout, which is the channel that decides.
run_agy() {            # <json toolCall> [cwd]
  local call="$1" cwd="${2:-$FIX}"
  jq -nc --argjson t "$call" --arg d "$cwd" \
    '{toolCall: $t, workspacePaths: [$d], conversationId: "c", stepIdx: 1}' \
    | bash "$HOOK" 2>/dev/null
}

agy_write() { jq -nc --arg n "$1" --arg p "$2" '{name:$n,args:{TargetFile:$p}}'; }
agy_cmd()   { jq -nc --arg c "$1" '{name:"run_command",args:{CommandLine:$c}}'; }

agy_denies() {         # <label> <json toolCall> [cwd]
  local out decision
  out="$(run_agy "$2" "${3:-$FIX}")"
  decision="$(printf '%s' "$out" | jq -r '.decision // empty' 2>/dev/null)"
  if [ "$decision" = "deny" ]; then
    pass=$((pass + 1)); echo "ok: $1"
  else
    fail=$((fail + 1))
    echo "FAIL $1 — wanted a deny decision on stdout, got '${out:0:60}'" >&2
  fi
}

agy_allows() {         # <label> <json toolCall> [cwd]
  local out
  out="$(run_agy "$2" "${3:-$FIX}")"
  # Silence, not `{}`: `{}` is a DENY there (decision is required), so a guard
  # that printed it on the pass path would block every call it approved.
  if [ -z "$out" ]; then
    pass=$((pass + 1)); echo "ok: $1"
  else
    fail=$((fail + 1)); echo "FAIL $1 — wanted silence, got '${out:0:60}'" >&2
  fi
}

agy_denies "antigravity write_to_file into a shared checkout" \
  "$(agy_write write_to_file "$RECORDS/journal/2026-09-18/agy.md")"

agy_denies "antigravity replace_file_content into a shared checkout" \
  "$(agy_write replace_file_content "$SKILLS/qa/SKILL.md")"

agy_denies "antigravity run_command writing by shell redirection" \
  "$(agy_cmd "printf x > $WORKBENCH/stray.txt")"

agy_denies "antigravity write_to_file with no TargetFile refuses" \
  "$(jq -nc '{name:"write_to_file",args:{CodeContent:"x"}}')"

agy_allows "antigravity write outside every guarded checkout" \
  "$(agy_write write_to_file "$FIX/scratch/agy-ok.md")"

agy_allows "antigravity view_file is not a write" \
  "$(jq -nc --arg p "$RECORDS/journal/x.md" '{name:"view_file",args:{AbsolutePath:$p}}')"

# Cwd comes from args.Cwd when present, and only then from workspacePaths[0].
agy_denies "antigravity relative redirection resolves against args.Cwd" \
  "$(jq -nc --arg c "printf x > stray.txt" --arg d "$RECORDS" \
    '{name:"run_command",args:{CommandLine:$c,Cwd:$d}}')" "$FIX/scratch"

# ── Grok Build ────────────────────────────────────────────────────────────
#
# Grok's payload is camelCase: `toolName` and `toolInput`, its shell tool is
# `run_terminal_command` and its file writes are `write` / `search_replace`
# with `toolInput.file_path` (read from a live grok 1.0.41 PreToolUse payload).
# A deny is exit 2 with the reason on stderr, as for Claude Code.
run_grok() {           # <toolName> <json toolInput> [cwd]
  jq -nc --arg t "$1" --argjson i "$2" --arg d "${3:-$FIX}" \
    '{hook_event_name: "PreToolUse", toolName: $t, toolInput: $i, cwd: $d}' \
    | bash "$HOOK" >/dev/null 2>&1
  echo $?
}
expect 2 "grok write into a shared checkout" \
  "$(run_grok write "$(fp "$SKILLS/grok.md")")"
expect 2 "grok search_replace into a shared checkout" \
  "$(run_grok search_replace "$(fp "$SKILLS/close/SKILL.md")")"
expect 2 "grok run_terminal_command writing by redirection" \
  "$(run_grok run_terminal_command "$(jq -nc --arg c "printf x > $WORKBENCH/stray.txt" '{command: $c}')")"
expect 2 "grok write with no file_path refuses" \
  "$(run_grok write '{"content":"x"}')"
expect 0 "grok write outside every guarded checkout" \
  "$(run_grok write "$(fp "$FIX/scratch/grok-ok.md")")"
expect 0 "grok read_file is not a write" \
  "$(run_grok read_file "$(fp "$SKILLS/close/SKILL.md")")"

# `..` after a symlink is taken from the link's TARGET, as the kernel does:
# ~/.agents/skills/.. is the checkout's .agents/, not ~/.agents.
expect 2 "a write through a home link and then .. into the checkout" \
  "$(run_tool Write "$(fp "$FIX/.agents/skills/../AGENTS.md")")"

# ── Gemini CLI ────────────────────────────────────────────────────────────
#
# Gemini CLI's BeforeTool payload is Claude's snake_case shape with its own tool
# names: `run_shell_command`, `write_file` and `replace`, each file tool with
# `tool_input.file_path` (read from @google/gemini-cli-core 0.61.0; not run).
expect 2 "gemini write_file into a shared checkout" \
  "$(run_tool write_file "$(fp "$SKILLS/gemini.md")")"
expect 2 "gemini replace into a shared checkout" \
  "$(run_tool replace "$(fp "$SKILLS/close/SKILL.md")")"
expect 2 "gemini run_shell_command writing by redirection" \
  "$(run_tool run_shell_command "$(jq -nc --arg c "printf x > $WORKBENCH/stray.txt" '{command: $c}')")"
expect 0 "gemini write_file outside every guarded checkout" \
  "$(run_tool write_file "$(fp "$FIX/scratch/gemini-ok.md")")"

# ── Dispatch: the manifests must actually ROUTE these tools here ──────────
#
# A correct parser behind a matcher that never fires guards nothing, and that
# failure is invisible from every case above — they all call the hook directly.
# These read the real manifests and check the regex, which is the only thing
# standing between the payload and this script.
# In this repo the manifests sit beside the hooks: claude-hooks.json (Claude
# Code and Codex read this shape) and ../hooks.json (Antigravity's), which
# install.sh renders into the workbench and the harness homes.
MANIFEST_DIR="$(cd "$(dirname "$0")" && pwd)"

matcher_for() {        # <manifest> <script basename> — via the Claude/Codex shape
  jq -r --arg sc "$2" '.hooks.PreToolUse[]? | select(any(.hooks[]?; (.command // "") | contains($sc))) | .matcher' "$1"
}

agy_matcher_for() {    # <manifest> <script basename> — via the Antigravity shape
  jq -r --arg sc "$2" '.[] | .PreToolUse[]? | select(any(.hooks[]?; (.command // "") | contains($sc))) | .matcher' "$1"
}

dispatches() {         # <label> <tool name> <matchers, newline-separated>
  local hit=""
  while IFS= read -r mx; do
    [ -n "$mx" ] || continue
    if printf '%s' "$2" | grep -Eq "^(${mx})$"; then hit=1; fi
  done <<< "$3"
  if [ -n "$hit" ]; then
    pass=$((pass + 1)); echo "ok: $1"
  else
    fail=$((fail + 1)); echo "FAIL $1 — no matcher in the manifest matches '$2'" >&2
  fi
}

CLAUDE_MANIFEST="$MANIFEST_DIR/claude-hooks.json"
AGY_MANIFEST="$MANIFEST_DIR/../hooks.json"
SELF="check-shared-checkout-write.sh"

if [ -f "$CLAUDE_MANIFEST" ]; then
  CLAUDE_MX="$(matcher_for "$CLAUDE_MANIFEST" "$SELF")"
  dispatches "manifest routes Codex apply_patch to this guard" apply_patch "$CLAUDE_MX"
  dispatches "manifest still routes Claude Write to this guard" Write "$CLAUDE_MX"
  dispatches "manifest still routes Claude Bash to this guard" Bash "$CLAUDE_MX"
  dispatches "manifest routes Grok's write to this guard" write "$CLAUDE_MX"
  dispatches "manifest routes Grok's search_replace to this guard" search_replace "$CLAUDE_MX"
  dispatches "manifest routes Grok's run_terminal_command to this guard" run_terminal_command "$CLAUDE_MX"
else
  echo "note: $CLAUDE_MANIFEST not found, skipping dispatch check" >&2
fi

GEMINI_MANIFEST="$MANIFEST_DIR/../gemini-settings.json"
if [ -f "$GEMINI_MANIFEST" ]; then
  GEMINI_MX="$(jq -r --arg sc "$SELF" '.hooks.BeforeTool[]? | select(any(.hooks[]?; (.command // "") | contains($sc))) | .matcher' "$GEMINI_MANIFEST")"
  dispatches "gemini manifest routes write_file here" write_file "$GEMINI_MX"
  dispatches "gemini manifest routes replace here" replace "$GEMINI_MX"
  dispatches "gemini manifest routes run_shell_command here" run_shell_command "$GEMINI_MX"
else
  fail=$((fail + 1)); echo "FAIL $GEMINI_MANIFEST not found" >&2
fi

if [ -f "$AGY_MANIFEST" ]; then
  AGY_MX="$(agy_matcher_for "$AGY_MANIFEST" "$SELF")"
  dispatches "agy manifest routes write_to_file here" write_to_file "$AGY_MX"
  dispatches "agy manifest routes replace_file_content here" replace_file_content "$AGY_MX"
  dispatches "agy manifest routes run_command here" run_command "$AGY_MX"
else
  echo "note: $AGY_MANIFEST not found, skipping agy dispatch check" >&2
fi

echo ""
# The verdict word follows $fail. A literal "PASS" printed
# `PASS — 0 assertions, N failed` on a run where everything broke, which reads
# as the opposite of what happened to anyone past the exit code.
if [[ "$fail" -gt 0 ]]; then
  echo "FAIL — $fail of $((pass + fail)) assertions failed"
  exit 1
fi
echo "PASS — $pass assertions, 0 failed"
