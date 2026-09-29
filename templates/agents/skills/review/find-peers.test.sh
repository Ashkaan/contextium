#!/usr/bin/env bash
# find-peers.test.sh — hermetic tests for find-peers.sh
#
# Builds a throwaway git repo under $TMPDIR (never inside this repo: a
# script's tests run outside it), stages fixtures into it, and
# runs the check against them. Nothing here touches the real working tree.
#
# Run: bash skills/review/find-peers.test.sh
# Exit: 0 all pass, 1 any fail.
#
# Covers the boundary table in find-peers.sh's header: both sweep outcomes,
# the caller error, every branch of the exclusion audit (code hidden, prose
# only, survivor named, alternate exclusion spellings, no exclusions, absent
# path), and every reason mode 2 declines to warn (token re-added, peer
# changed too, peer absent, token below the floor).

set -euo pipefail

SCRIPT_UNDER_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/find-peers.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/find-peers-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass_count=0
fail_count=0

ok() {
  echo "  PASS: $1"
  pass_count=$((pass_count + 1))
}

ko() {
  echo "  FAIL: $1" >&2
  fail_count=$((fail_count + 1))
}

# Fresh single-purpose repo per case, so no case can leak into another.
new_repo() {
  local dir="$WORK/repo-$1"
  mkdir -p "$dir"
  git -C "$dir" init --quiet
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name test
  printf '%s\n' "$dir"
}

commit_all() {
  git -C "$1" add --all
  git -C "$1" commit --quiet --message "$2"
}

# ── Mode 1: --verify-sweep ───────────────────────────────────────────────

repo=$(new_repo sweep-clean)
mkdir -p "$repo/apps"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/b.ts"
commit_all "$repo" init
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
  'z\.string\(\),' -- apps >/dev/null 2>&1); then
  ok "sweep with no surviving match exits 0"
else
  ko "sweep with no surviving match should exit 0"
fi

repo=$(new_repo sweep-dirty)
mkdir -p "$repo/apps"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
printf 'updated_at: z.string(),\n' > "$repo/apps/b.ts"
commit_all "$repo" init
sweep_err="$WORK/sweep-dirty.err"
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
  'z\.string\(\),' -- apps >/dev/null 2>"$sweep_err"); then
  ko "sweep with a surviving match should exit 1"
else
  if grep -q 'apps/b.ts' "$sweep_err"; then
    ok "sweep with a surviving match exits 1 and names the file"
  else
    ko "sweep failure should name the surviving file"
  fi
fi

# A negative pathspec is how a deliberate survivor stays legal. It names the
# FILE: since the exclusion audit below, a bare `:!readers` around runnable
# code is the blind spot, not the declaration.
repo=$(new_repo sweep-excluded)
mkdir -p "$repo/apps" "$repo/readers"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
printf 'updated_at: z.string(),\n' > "$repo/readers/r.ts"
commit_all "$repo" init
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
  'z\.string\(\),' -- . ':!readers/r.ts' >/dev/null 2>&1); then
  ok "negative pathspec excludes a deliberate survivor"
else
  ko "negative pathspec should exclude a deliberate survivor"
fi

# The records live in this tree: a journal entry quoting the
# retired pattern is prose about the sweep, not an instance it missed. The
# default population (no pathspec) must leave journal/, knowledge/ and
# projects/ out on its own.
repo=$(new_repo sweep-journal-prose)
mkdir -p "$repo/apps" "$repo/journal/2026-01-01"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
printf 'Swept z.string(), out of every schema today.\n' \
  > "$repo/journal/2026-01-01/0900-x.md"
commit_all "$repo" init
journal_err="$WORK/sweep-journal-prose.err"
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
  'z\.string\(\),' >/dev/null 2>"$journal_err"); then
  ok "a journal entry naming the pattern is not a surviving match"
else
  ko "journal prose should not fail a repo-wide sweep; got: $(cat "$journal_err")"
fi

# ── The exclusion audit ──────────────────────────────────────────────────
#
# The shape that slipped: `:!projects` declared as historical prose, hiding a
# .js file that still matched. Prose in the same tree must stay excludable.

repo=$(new_repo sweep-exclusion-hides-code)
mkdir -p "$repo/apps" "$repo/projects/old/scripts"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
printf 'notes about z.string(), last spring\n' > "$repo/projects/old/notes.md"
printf 'const s = z.string(),\n' > "$repo/projects/old/scripts/scan.js"
commit_all "$repo" init
hide_err="$WORK/sweep-exclusion-hides-code.err"
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
  'z\.string\(\),' -- . ':!projects' >/dev/null 2>"$hide_err"); then
  ko "an exclusion hiding runnable code should exit 1"
else
  if grep -q 'projects/old/scripts/scan.js' "$hide_err" \
    && ! grep -q 'projects/old/notes.md' "$hide_err"; then
    ok "excluded directory hiding runnable code exits 1 and names only the code"
  else
    ko "should name scan.js and not notes.md; got: $(cat "$hide_err")"
  fi
fi

# Prose-only exclusion is what the directory form is legitimately for.
repo=$(new_repo sweep-exclusion-prose-only)
mkdir -p "$repo/apps" "$repo/projects/old"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
printf 'notes about z.string(), last spring\n' > "$repo/projects/old/notes.md"
commit_all "$repo" init
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
  'z\.string\(\),' -- . ':!projects' >/dev/null 2>&1); then
  ok "excluded directory holding only prose still passes"
else
  ko "a prose-only exclusion should pass"
fi

# Naming the file beside the tree is how a deliberate code survivor is
# recorded rather than hidden.
repo=$(new_repo sweep-exclusion-file-named)
mkdir -p "$repo/apps" "$repo/projects/old/scripts"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
printf 'const s = z.string(),\n' > "$repo/projects/old/scripts/scan.js"
commit_all "$repo" init
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
  'z\.string\(\),' -- . ':!projects' ':!projects/old/scripts/scan.js' \
  >/dev/null 2>&1); then
  ok "a code survivor named as its own file-level exclusion is accepted"
else
  ko "naming the survivor file should be accepted"
fi

# `:^` and `:(exclude)` are the same pathspec magic under other spellings.
repo=$(new_repo sweep-exclusion-alt-syntax)
mkdir -p "$repo/apps" "$repo/projects/scripts"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
printf 'const s = z.string(),\n' > "$repo/projects/scripts/scan.sh"
commit_all "$repo" init
alt_ok=0
for form in ':^projects' ':(exclude)projects'; do
  if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
    'z\.string\(\),' -- . "$form" >/dev/null 2>&1); then
    ko "exclusion form $form should be audited"
  else
    alt_ok=$((alt_ok + 1))
  fi
done
if [[ $alt_ok -eq 2 ]]; then
  ok ":^ and :(exclude) are audited like :!"
fi

# No exclusions at all — nothing to audit, and the clean sweep still passes.
repo=$(new_repo sweep-no-exclusions)
mkdir -p "$repo/apps"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
commit_all "$repo" init
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
  'z\.string\(\),' -- apps >/dev/null 2>&1); then
  ok "a sweep with no exclusions skips the audit and passes"
else
  ko "a sweep with no exclusions should pass"
fi

# An exclusion pointing at nothing on disk has no candidates to hide.
repo=$(new_repo sweep-exclusion-absent)
mkdir -p "$repo/apps"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
commit_all "$repo" init
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep \
  'z\.string\(\),' -- . ':!nosuchdir' >/dev/null 2>&1); then
  ok "an exclusion naming a path not on disk passes"
else
  ko "an absent excluded path should pass"
fi

repo=$(new_repo sweep-noregex)
printf 'x\n' > "$repo/f.txt"
commit_all "$repo" init
set +e
(cd "$repo" && bash "$SCRIPT_UNDER_TEST" --verify-sweep >/dev/null 2>&1)
rc=$?
set -e
if [[ $rc -eq 2 ]]; then
  ok "sweep with no regex exits 2 (caller error, not a review outcome)"
else
  ko "sweep with no regex should exit 2, got $rc"
fi

# ── Mode 2: removed-token vs declared peers ──────────────────────────────

# The shape this exists to catch: a distinctive token deleted here, still
# alive in a declared peer that this change did not touch.
repo=$(new_repo peer-left-behind)
mkdir -p "$repo/apps"
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const v = envelope.data.scores;
EOF
printf 'const v = envelope.data.scores;\n' > "$repo/apps/two.ts"
commit_all "$repo" init
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const v = envelope.scores;
EOF
err="$WORK/peer-left-behind.err"
(cd "$repo" && bash "$SCRIPT_UNDER_TEST" 2>"$err" >/dev/null)
if grep -q 'apps/two.ts' "$err" && grep -q 'data.scores' "$err"; then
  ok "warns when a removed token survives in an unchanged declared peer"
else
  ko "should warn about the left-behind peer; got: $(cat "$err")"
fi

# Sweeping the peer in the same commit is the whole point — no warning then.
repo=$(new_repo peer-swept)
mkdir -p "$repo/apps"
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const v = envelope.data.scores;
EOF
printf 'const v = envelope.data.scores;\n' > "$repo/apps/two.ts"
commit_all "$repo" init
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const v = envelope.scores;
EOF
printf 'const v = envelope.scores;\n' > "$repo/apps/two.ts"
err="$WORK/peer-swept.err"
(cd "$repo" && bash "$SCRIPT_UNDER_TEST" 2>"$err" >/dev/null)
if [[ -s "$err" ]]; then
  ko "a peer changed in the same commit should not warn; got: $(cat "$err")"
else
  ok "silent when the declared peer was swept in the same change"
fi

# Reformatting moves a token around; it was never actually removed.
repo=$(new_repo token-readded)
mkdir -p "$repo/apps"
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const v = envelope.data.scores;
EOF
printf 'const v = envelope.data.scores;\n' > "$repo/apps/two.ts"
commit_all "$repo" init
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const v =
  envelope.data.scores;
EOF
err="$WORK/token-readded.err"
(cd "$repo" && bash "$SCRIPT_UNDER_TEST" 2>"$err" >/dev/null)
if [[ -s "$err" ]]; then
  ko "a re-added token should not warn; got: $(cat "$err")"
else
  ok "silent when the token was moved, not removed"
fi

# Short bare words are what made the old version unreadable.
repo=$(new_repo token-too-short)
mkdir -p "$repo/apps"
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const ab = 1;
EOF
printf 'const ab = 1;\n' > "$repo/apps/two.ts"
commit_all "$repo" init
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const cd = 1;
EOF
err="$WORK/token-too-short.err"
(cd "$repo" && bash "$SCRIPT_UNDER_TEST" 2>"$err" >/dev/null)
if [[ -s "$err" ]]; then
  ko "a below-floor token should not warn; got: $(cat "$err")"
else
  ok "silent for tokens under the distinctiveness floor"
fi

repo=$(new_repo peer-missing)
mkdir -p "$repo/apps"
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/gone.ts
const v = envelope.data.scores;
EOF
commit_all "$repo" init
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/gone.ts
const v = envelope.scores;
EOF
err="$WORK/peer-missing.err"
(cd "$repo" && bash "$SCRIPT_UNDER_TEST" 2>"$err" >/dev/null)
if [[ -s "$err" ]]; then
  ko "a peer that does not exist should not warn; got: $(cat "$err")"
else
  ok "silent when the declared peer is not on disk"
fi

repo=$(new_repo no-changes)
printf 'x\n' > "$repo/f.txt"
commit_all "$repo" init
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1); then
  ok "clean tree exits 0 silently"
else
  ko "clean tree should exit 0"
fi

# Warn-only: mode 2 must never fail the run, however much it found.
repo=$(new_repo warn-only-exit)
mkdir -p "$repo/apps"
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const v = envelope.data.scores;
EOF
printf 'const v = envelope.data.scores;\n' > "$repo/apps/two.ts"
commit_all "$repo" init
cat > "$repo/apps/one.ts" <<'EOF'
// peers: apps/two.ts
const v = envelope.scores;
EOF
if (cd "$repo" && bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1); then
  ok "mode 2 exits 0 even when it warns (warn-only contract)"
else
  ko "mode 2 must exit 0 — it is warn-only"
fi

# ── The declared-peers reader: `--peers <file>` ─────────────────────────
#
# Skills carry their peers under `metadata:` → `peers:` as one space-separated
# string (the Agent Skills spec); agents and rules still
# carry a top-level `peers:` list. Both must read, and an empty nested value
# names nothing.

repo=$(new_repo peers-nested)
mkdir -p "$repo/x"
cat > "$repo/x/SKILL.md" <<'EOF2'
---
name: x
description: A skill.
metadata:
  peers: "~/tools/x/scripts/a.sh b/c.md"
---
body
EOF2
commit_all "$repo" init
got=$(cd "$repo" && bash "$SCRIPT_UNDER_TEST" --peers x/SKILL.md 2>/dev/null || true)
if [[ "$got" == $'~/tools/x/scripts/a.sh\nb/c.md' ]]; then
  ok "--peers reads metadata.peers as a space-separated string"
else
  ko "--peers should list both nested peers; got: $got"
fi

repo=$(new_repo peers-nested-empty)
mkdir -p "$repo/x"
printf -- '---\nname: x\ndescription: A skill.\nmetadata:\n  peers: ""\n---\nbody\n' > "$repo/x/SKILL.md"
commit_all "$repo" init
rc=0
got=$(cd "$repo" && bash "$SCRIPT_UNDER_TEST" --peers x/SKILL.md 2>/dev/null) || rc=$?
if [[ $rc -eq 0 && -z "$got" ]]; then
  ok "--peers lists nothing for an empty metadata.peers, and exits 0"
else
  ko "empty metadata.peers should list nothing with exit 0; got rc=$rc: $got"
fi

repo=$(new_repo peers-top-level)
mkdir -p "$repo/.agents/agents"
printf -- '---\nname: r\ndescription: An agent.\npeers:\n  - a/b.md\n  - c/d.sh\n---\nbody\n' > "$repo/.agents/agents/r.md"
commit_all "$repo" init
got=$(cd "$repo" && bash "$SCRIPT_UNDER_TEST" --peers .agents/agents/r.md 2>/dev/null || true)
if [[ "$got" == $'a/b.md\nc/d.sh' ]]; then
  ok "--peers still reads a top-level peers: list (agents, rules)"
else
  ko "top-level peers: list should still read; got: $got"
fi

# And mode 2 sees the nested form: a token removed from the skill that
# survives in its declared peer is warned about.
repo=$(new_repo peer-nested-left-behind)
mkdir -p "$repo/x" "$repo/b"
printf -- '---\nname: x\ndescription: A skill.\nmetadata:\n  peers: "b/c.md"\n---\nrun scripts/old-name.sh\n' > "$repo/x/SKILL.md"
printf 'see scripts/old-name.sh\n' > "$repo/b/c.md"
commit_all "$repo" init
printf -- '---\nname: x\ndescription: A skill.\nmetadata:\n  peers: "b/c.md"\n---\nrun scripts/new-name.sh\n' > "$repo/x/SKILL.md"
err="$WORK/peer-nested-left-behind.err"
(cd "$repo" && bash "$SCRIPT_UNDER_TEST" 2>"$err" >/dev/null)
if grep -q 'b/c.md' "$err" && grep -q 'old-name.sh' "$err"; then
  ok "mode 2 warns through a metadata.peers declaration"
else
  ko "mode 2 should warn about the nested peer; got: $(cat "$err")"
fi

# A peer declared as a home path is read at that
# path, so a token left behind there is reported like any other.
repo=$(new_repo peer-home-path)
fake_home="$WORK/home-peer"
mkdir -p "$repo/x" "$fake_home/tools/x/scripts"
printf 'run scripts/old-name.sh here\n' > "$fake_home/tools/x/scripts/run.sh"
printf -- '---\nname: x\ndescription: A skill.\nmetadata:\n  peers: "~/tools/x/scripts/run.sh"\n---\nrun scripts/old-name.sh\n' > "$repo/x/SKILL.md"
commit_all "$repo" init
printf -- '---\nname: x\ndescription: A skill.\nmetadata:\n  peers: "~/tools/x/scripts/run.sh"\n---\nrun scripts/new-name.sh\n' > "$repo/x/SKILL.md"
err="$WORK/peer-home-path.err"
(cd "$repo" && HOME="$fake_home" bash "$SCRIPT_UNDER_TEST" 2>"$err" >/dev/null)
if grep -q 'scripts/run.sh' "$err" && grep -q 'old-name.sh' "$err"; then
  ok "mode 2 reads a ~/ peer at the home path"
else
  ko "mode 2 should warn about the ~/ peer; got: $(cat "$err")"
fi

# A peer declared by an absolute path INSIDE this repo is the same file as
# its repo-relative name: touched in the same change, it is the author's
# to finish and must not warn (the repo-relative form has always been silent
# here; the token is left in on purpose so the lookup is what decides).
repo=$(new_repo peer-absolute-in-repo)
mkdir -p "$repo/apps"
cat > "$repo/apps/one.ts" <<EOF2
// peers: $repo/apps/two.ts
const v = envelope.data.scores;
EOF2
printf 'const v = envelope.data.scores;\n' > "$repo/apps/two.ts"
commit_all "$repo" init
cat > "$repo/apps/one.ts" <<EOF2
// peers: $repo/apps/two.ts
const v = envelope.scores;
EOF2
printf 'const v = envelope.data.scores;\nconst w = 1;\n' > "$repo/apps/two.ts"
err="$WORK/peer-absolute-in-repo.err"
(cd "$repo" && bash "$SCRIPT_UNDER_TEST" 2>"$err" >/dev/null)
if [[ -s "$err" ]]; then
  ko "an absolute in-repo peer changed in the same diff should not warn; got: $(cat "$err")"
else
  ok "an absolute in-repo peer changed in the same diff is silent"
fi

# ── A git read that FAILS is not an empty one ────────────────────────────
# A `git` that errors on one subcommand (FAKE_GIT_FAIL) stands in for a broken
# repo, a missing HEAD, or a bad pathspec. Read as "no output", each would
# report "no changed files" or "no surviving match" — a clean gate over nothing.
fakegit="$WORK/fakegit"; mkdir -p "$fakegit"
realgit="$(command -v git)"
cat > "$fakegit/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "\${FAKE_GIT_FAIL:-}" ]; then echo "fatal: simulated \$a failure" >&2; exit 128; fi
done
exec "$realgit" "\$@"
EOF
chmod +x "$fakegit/git"
repo=$(new_repo git-fails)
mkdir -p "$repo/apps"
printf 'updated_at: z.string().datetime(),\n' > "$repo/apps/a.ts"
commit_all "$repo" init
printf 'x\n' >> "$repo/apps/a.ts"
rc=0; err_out=$(cd "$repo" && PATH="$fakegit:$PATH" FAKE_GIT_FAIL=diff bash "$SCRIPT_UNDER_TEST" 2>&1 >/dev/null) || rc=$?
if [[ "$rc" -eq 2 ]] && grep -q "git diff failed" <<<"$err_out"; then
  ok "a failed git diff is exit 2, named — not 'no changed files'"
else
  ko "a failed git diff should be exit 2 naming it; got rc=$rc: $err_out"
fi
rc=0; err_out=$(cd "$repo" && PATH="$fakegit:$PATH" FAKE_GIT_FAIL=grep bash "$SCRIPT_UNDER_TEST" --verify-sweep 'z\.string' -- apps 2>&1 >/dev/null) || rc=$?
if [[ "$rc" -eq 2 ]] && grep -q "git grep failed" <<<"$err_out"; then
  ok "a failed sweep grep is exit 2, named — not a clean sweep"
else
  ko "a failed sweep grep should be exit 2 naming it; got rc=$rc: $err_out"
fi

echo ""
echo "find-peers.test.sh: $pass_count passed, $fail_count failed"
[[ $fail_count -eq 0 ]]
