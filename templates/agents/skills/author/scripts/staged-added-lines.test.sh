#!/usr/bin/env bash
# staged-added-lines.test.sh — the line-level pre-commit checks must judge what a
# commit ADDED, not what the file already carried.
#
# WHY THIS EXISTS:
#   A per-line check that scans the whole file blocks a commit over a line that
#   commit never touched — say an unanchored path in a SPEC's Handling column,
#   written months before, in a row the fix never touched. An unattended
#   automation has no human to clear it, so its approved work is discarded, and
#   every such old line stands in front of any commit touching its file.
#
#   The four checks below all take a STAGED FILE LIST and then scan the whole
#   file, so each one can fail a commit over a line that commit did not write.
#   That shared shape — not the SPEC anchor rule — is what these cases pin.
#
# WHAT EACH CASE ASSERTS
#   inherited:  file already violates, commit changes an unrelated line -> exit 0
#   introduced: the commit's own added line violates                    -> exit 1
#
# The second half matters as much as the first: scoping to added lines must not
# turn a real check into a no-op.
#
# Runs a real `git add` cycle in a throwaway repo under $TMPDIR, so what is
# measured is the check script against a real staged diff, not a simulation of
# one. Nothing is written inside the workbench.
#
# Usage: bash templates/agents/skills/author/scripts/staged-added-lines.test.sh
# Exit: 0 = all cases pass, 1 = at least one failed.

set -uo pipefail

CHECKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/staged-added-lines-test-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

passes=0
failures=0
OUT=""
RC=0

# A throwaway repo carrying a copy of the real checks directory at its real
# relative path, so sibling sourcing via `$(dirname "$0")` and the SPEC/app path
# regexes all behave exactly as they do in the repo.
new_repo() {
  local d="$WORK/repo-$1"
  mkdir -p "$d/.agents"
  git -C "$d" init -q
  git -C "$d" config user.email test@example.com
  git -C "$d" config user.name "Test"
  git -C "$d" config commit.gpgsign false
  cp -R "$CHECKS_DIR" "$d/.agents/checks"
  printf '%s' "$d"
}

commit_all() {
  git -C "$1" add -A
  git -C "$1" -c core.hooksPath=/dev/null commit -q -m "baseline" --no-verify
}

# Run a check in staged mode from the temp repo root. Leaves the exit status in
# RC and the combined output in OUT for the failure report.
# SKIPPED is a real outcome here, not a swallowed failure. This suite proves the
# added-lines library by driving its CONSUMERS, and the consumers
# (spec-anchor-claims, anti-ai-tokens, repo-read-transport, journal-next-commands,
# error-context, check-refs) do not ship with it: a workbench adds the ones it
# wants to .agents/checks/. A case whose check is absent would run `bash` on a
# missing path, collect exit 127, and compare it against the expected 0 or 1,
# so it would report as a behaviour failure. It says which check is missing and
# counts separately; the helper's own boundary cases below still exercise every
# branch of the library itself.
skipped=0
run_check() {
  local dir="$1" script="$2"
  shift 2
  if [[ ! -f "$dir/.agents/checks/$script" ]]; then
    RC="SKIP"
    OUT="check not present in this checkout: $script"
    return
  fi
  OUT="$(cd "$dir" && TRIGGERED_BY=test REPO_READ_TRANSPORT_NO_GIT=1 \
    bash ".agents/checks/$script" "$@" 2>&1)"
  RC=$?
}

expect() {
  local want="$1" label="$2"
  if [[ "$RC" == "SKIP" ]]; then
    skipped=$((skipped + 1))
    printf 'skip %s — %s\n' "$label" "$OUT"
    return
  fi
  if [[ "$RC" == "$want" ]]; then
    passes=$((passes + 1))
    printf 'ok   %s\n' "$label"
  else
    failures=$((failures + 1))
    printf 'FAIL %s — wanted exit %s, got %s\n' "$label" "$want" "$RC"
    printf '%s\n' "$OUT" | sed 's/^/       | /'
  fi
}

# ── check-spec-anchor-claims ────────────────────────────────────────────────
spec_body() {
  cat <<'MD'
# Thing

## 8. Failure modes

| Failure | Detection | Handling |
|---|---|---|
| Resource drift | a tech's entries return empty | Update `CONFIG.technicians` in `src/lib/helpers.ts`. |

## 9. Next
MD
}

d="$(new_repo spec-inherited)"
mkdir -p "$d/apps/web/time-tracker"
spec_body > "$d/apps/web/time-tracker/SPEC.md"
commit_all "$d"
printf 'A note that has nothing to do with failure modes.\n' >> "$d/apps/web/time-tracker/SPEC.md"
git -C "$d" add -A
run_check "$d" check-spec-anchor-claims.sh
expect 0 "spec-anchor: inherited unanchored path does not block an unrelated edit"

d="$(new_repo spec-introduced)"
mkdir -p "$d/apps/web/time-tracker"
spec_body > "$d/apps/web/time-tracker/SPEC.md"
commit_all "$d"
# A NEW failure-mode row, added by this commit, naming a path with no anchor.
# shellcheck disable=SC2016 # the backticks are literal SPEC markdown, not command substitution
{
  printf '# Thing\n\n## 8. Failure modes\n\n'
  printf '| Failure | Detection | Handling |\n|---|---|---|\n'
  printf '| Resource drift | a tech'"'"'s entries return empty | Update `CONFIG.technicians` in `src/lib/helpers.ts`. |\n'
  printf '| KV write fails | see `src/lib/kv.ts` | retry |\n\n'
  printf '## 9. Next\n'
} > "$d/apps/web/time-tracker/SPEC.md"
git -C "$d" add -A
run_check "$d" check-spec-anchor-claims.sh
expect 1 "spec-anchor: a newly added unanchored path still blocks"

# ── check-anti-ai-tokens ────────────────────────────────────────────────────
d="$(new_repo tokens-inherited)"
mkdir -p "$d/apps/web/blog-writer"
printf 'We delve into the topic.\n' > "$d/apps/web/blog-writer/post.md"
commit_all "$d"
printf 'A second paragraph with ordinary words.\n' >> "$d/apps/web/blog-writer/post.md"
git -C "$d" add -A
# Invoked the way a commit-time dispatcher invokes it: the flag
# plus an explicit staged file list. Argv-present is NOT the signal here.
run_check "$d" check-anti-ai-tokens.sh --added-only apps/web/blog-writer/post.md
expect 0 "anti-ai-tokens: an inherited AI tell does not block an unrelated edit"

d="$(new_repo tokens-introduced)"
mkdir -p "$d/apps/web/blog-writer"
printf 'An ordinary first paragraph.\n' > "$d/apps/web/blog-writer/post.md"
commit_all "$d"
printf 'We delve into the topic.\n' >> "$d/apps/web/blog-writer/post.md"
git -C "$d" add -A
# Invoked the way a commit-time dispatcher invokes it: the flag
# plus an explicit staged file list. Argv-present is NOT the signal here.
run_check "$d" check-anti-ai-tokens.sh --added-only apps/web/blog-writer/post.md
expect 1 "anti-ai-tokens: a newly added AI tell still blocks"

# ── check-repo-read-transport ───────────────────────────────────────────────
# `knowledge/finance/budget/` is automation-written in the generated
# classification data, so an API read of a path under it blocks. Longest prefix
# wins there, which is why the path has to be picked off the data file rather
# than guessed — `knowledge/finance/assets/` two rows above it is HUMAN and
# would sail through.
d="$(new_repo transport-inherited)"
mkdir -p "$d/apps/web/reader"
cat > "$d/apps/web/reader/read.ts" <<'TS'
export async function readIt(gh: unknown) {
  return await ghGetRaw(gh, "knowledge/finance/budget/2026.md");
}
TS
commit_all "$d"
printf 'export const UNRELATED = 1;\n' >> "$d/apps/web/reader/read.ts"
git -C "$d" add -A
run_check "$d" check-repo-read-transport.sh
expect 0 "repo-read-transport: an inherited API read does not block an unrelated edit"

d="$(new_repo transport-introduced)"
mkdir -p "$d/apps/web/reader"
printf 'export const UNRELATED = 1;\n' > "$d/apps/web/reader/read.ts"
commit_all "$d"
cat >> "$d/apps/web/reader/read.ts" <<'TS'
export async function readIt(gh: unknown) {
  return await ghGetRaw(gh, "knowledge/finance/budget/2026.md");
}
TS
git -C "$d" add -A
run_check "$d" check-repo-read-transport.sh
expect 1 "repo-read-transport: a newly added API read still blocks"

# ── check-journal-next-commands ─────────────────────────────────────────────
# One journal file holds every session of a day, so session 2 stages a file that
# already carries session 1's **Next:** bullets.
journal_session() {
  printf '### %s\n\n**Next:**\n\n- %s\n\n' "$1" "$2"
}

d="$(new_repo journal-inherited)"
mkdir -p "$d/journal"
journal_session "session-one" "Deploy the media bundle" > "$d/journal/2026-09-09.md"
commit_all "$d"
journal_session "session-two" "Write up the findings" >> "$d/journal/2026-09-09.md"
git -C "$d" add -A
run_check "$d" check-journal-next-commands.sh --added-only journal/2026-09-09.md
expect 0 "journal-next: an earlier session's Deploy bullet does not block this session"

d="$(new_repo journal-introduced)"
mkdir -p "$d/journal"
journal_session "session-one" "Write up the findings" > "$d/journal/2026-09-09.md"
commit_all "$d"
journal_session "session-two" "Deploy the media bundle" >> "$d/journal/2026-09-09.md"
git -C "$d" add -A
run_check "$d" check-journal-next-commands.sh --added-only journal/2026-09-09.md
expect 1 "journal-next: this session's own Deploy bullet still blocks"

# The reported number must be the FILE line, not an offset into the extracted
# **Next:** block — the check greps the extract, so the two differ.
#
# Guarded on RC: the check that produces this output does not ship, so in a
# workbench without it $OUT holds the skip reason and this assertion has
# nothing to read. Un-guarded it reported a behaviour failure for
# a check that simply is not here.
if [[ "$RC" == "SKIP" ]]; then
  skipped=$((skipped + 1))
  printf 'skip journal-next: reports the file line — %s\n' "$OUT"
elif [[ "$OUT" == *":- Deploy the media bundle"* ]]; then
  reported="$(printf '%s\n' "$OUT" | grep -oE '[0-9]+:- Deploy the media bundle' | head -1)"
  reported="${reported%%:*}"
  actual="$(grep -n -- '- Deploy the media bundle' "$d/journal/2026-09-09.md" | head -1 | cut -d: -f1)"
  if [[ "$reported" == "$actual" ]]; then
    passes=$((passes + 1)); printf 'ok   journal-next: reports the file line (%s), not the block offset\n' "$actual"
  else
    failures=$((failures + 1)); printf 'FAIL journal-next: reported line %s, file line is %s\n' "$reported" "$actual"
  fi
else
  failures=$((failures + 1)); printf 'FAIL journal-next: expected the offending bullet in the output\n'
fi

# ── PARTIAL STAGING: the index and the working tree disagree ────────────────
# The failure a review found. The added-line set is computed from
# the INDEX; a check that greps the WORKING TREE is matching against a different
# document, so an unstaged insertion above a staged violation shifts it off the
# line the filter is looking for and the violation escapes the gate.
d="$(new_repo partial-staging-spec)"
mkdir -p "$d/apps/web/tt"
spec_body > "$d/apps/web/tt/SPEC.md"
commit_all "$d"
# STAGE a new unanchored path inside the failure-modes table...
# (awk and a temp file rather than python3, which macOS may not have.)
# shellcheck disable=SC2016 # the backticks are literal SPEC markdown, not command substitution
awk '$0 == "## 9. Next" { print "| KV write fails | see `src/lib/kv.ts` | retry |"; print "" } { print }' \
  "$d/apps/web/tt/SPEC.md" > "$d/tt.tmp" && mv "$d/tt.tmp" "$d/apps/web/tt/SPEC.md"
git -C "$d" add -A
# ...then, WITHOUT staging it, insert lines above so the working-tree copy has
# the violation at a different line number than the index copy does.
{ printf '<!-- unstaged note -->\n<!-- another -->\n<!-- a third -->\n'; cat "$d/apps/web/tt/SPEC.md"; } > "$d/tt.tmp" \
  && mv "$d/tt.tmp" "$d/apps/web/tt/SPEC.md"
run_check "$d" check-spec-anchor-claims.sh
expect 1 "spec-anchor: a staged violation still blocks when unstaged edits moved its line"

d="$(new_repo partial-staging-tokens)"
mkdir -p "$d/apps/web/blog-writer"
printf 'An ordinary first paragraph.\n' > "$d/apps/web/blog-writer/post.md"
commit_all "$d"
printf 'We delve into the topic.\n' >> "$d/apps/web/blog-writer/post.md"
git -C "$d" add -A
{ printf 'unstaged line one\nunstaged line two\n'; cat "$d/apps/web/blog-writer/post.md"; } > "$d/post.tmp" \
  && mv "$d/post.tmp" "$d/apps/web/blog-writer/post.md"
run_check "$d" check-anti-ai-tokens.sh --added-only apps/web/blog-writer/post.md
expect 1 "anti-ai-tokens: a staged AI tell still blocks when unstaged edits moved its line"

# And the converse: an INHERITED violation stays quiet even when the working
# tree has been shuffled, so the index read did not just re-widen the gate.
d="$(new_repo partial-staging-inherited)"
mkdir -p "$d/apps/web/blog-writer"
printf 'We delve into the topic.\n' > "$d/apps/web/blog-writer/post.md"
commit_all "$d"
printf 'An unrelated closing paragraph.\n' >> "$d/apps/web/blog-writer/post.md"
git -C "$d" add -A
printf 'an unstaged trailing line\n' >> "$d/apps/web/blog-writer/post.md"
run_check "$d" check-anti-ai-tokens.sh --added-only apps/web/blog-writer/post.md
expect 0 "anti-ai-tokens: an inherited tell stays quiet under partial staging too"

# ── the two peers the review named ──────────────────────────────────────────
d="$(new_repo error-context)"
mkdir -p "$d/apps/x"
cat > "$d/apps/x/a.ts" <<'TS'
export function one() {
  throw new Error("no context here");
}
TS
commit_all "$d"
printf 'export const UNRELATED = 1;\n' >> "$d/apps/x/a.ts"
git -C "$d" add -A
run_check "$d" check-error-context.sh --added-only apps/x/a.ts
expect 0 "error-context: an inherited context-less throw does not block an unrelated edit"

cat >> "$d/apps/x/a.ts" <<'TS'
export function two() {
  throw new Error("also no context");
}
TS
git -C "$d" add -A
run_check "$d" check-error-context.sh --added-only apps/x/a.ts
expect 1 "error-context: a newly added context-less throw still blocks"

# Staged, then deleted on disk without staging the deletion: the index still
# holds the throw, so the gate must still see it (round-3 review finding).
d="$(new_repo error-context-deleted)"
mkdir -p "$d/apps/x"
printf 'export const OK = 1;\n' > "$d/apps/x/a.ts"
commit_all "$d"
cat >> "$d/apps/x/a.ts" <<'TS'
export function three() {
  throw new Error("staged then deleted");
}
TS
git -C "$d" add -A
rm -f "$d/apps/x/a.ts"
run_check "$d" check-error-context.sh --added-only apps/x/a.ts
expect 1 "error-context: a throw staged and then deleted on disk is still caught"

# ── check-refs ──────────────────────────────────────────────────────────────
d="$(new_repo path-refs)"
mkdir -p "$d/apps/real" "$d/docs"
printf 'x\n' > "$d/apps/real/thing.ts"
# shellcheck disable=SC2016 # literal markdown backticks, not command substitution
printf '# Doc\n\nSee `apps/gone/old.ts` for history.\n' > "$d/docs/notes.md"
commit_all "$d"
printf '\nAn unrelated closing line.\n' >> "$d/docs/notes.md"
git -C "$d" add -A
run_check "$d" check-refs.sh --added-only docs/notes.md
expect 0 "check-refs: an inherited broken path reference does not block an unrelated edit"

# shellcheck disable=SC2016 # literal markdown backticks, not command substitution
printf '\nAlso `apps/missing/other.ts` which does not exist.\n' >> "$d/docs/notes.md"
git -C "$d" add -A
run_check "$d" check-refs.sh --added-only docs/notes.md
expect 1 "check-refs: a newly added broken path reference still blocks"

# shellcheck disable=SC2016 # literal markdown backticks, not command substitution
printf '\nAnd `apps/real/thing.ts` which does exist.\n' > "$d/docs/notes2.md"
git -C "$d" add -A
run_check "$d" check-refs.sh --added-only docs/notes2.md
expect 0 "check-refs: a newly added reference to a real path passes"

# ── the helper's own boundaries ─────────────────────────────────────────────
# nothing staged, one line staged, a whole new file, and a diff that cannot be
# read at all (boundary inputs).
if [[ -f "$CHECKS_DIR/staged-added-lines.sh" ]]; then
  # shellcheck disable=SC1091
  source "$CHECKS_DIR/staged-added-lines.sh"
else
  failures=$((failures + 1))
  printf 'FAIL helper: staged-added-lines.sh does not exist yet\n'
fi

if declare -F staged_added_lines >/dev/null; then
  d="$(new_repo helper-boundaries)"
  mkdir -p "$d/apps/x"
  printf 'one\ntwo\nthree\n' > "$d/apps/x/a.txt"
  commit_all "$d"

  got="$(cd "$d" && staged_added_lines apps/x/a.txt | tr '\n' ' ')"
  if [[ -z "${got// /}" ]]; then
    passes=$((passes + 1)); printf 'ok   helper: a file with nothing staged reports no added lines\n'
  else
    failures=$((failures + 1)); printf 'FAIL helper: nothing staged should report no lines, got "%s"\n' "$got"
  fi

  printf 'four\n' >> "$d/apps/x/a.txt"
  git -C "$d" add -A
  got="$(cd "$d" && staged_added_lines apps/x/a.txt | tr '\n' ' ')"
  if [[ "${got// /}" == "4" ]]; then
    passes=$((passes + 1)); printf 'ok   helper: one appended line reports exactly that line\n'
  else
    failures=$((failures + 1)); printf 'FAIL helper: wanted line 4, got "%s"\n' "$got"
  fi

  printf 'x\ny\n' > "$d/apps/x/new.txt"
  git -C "$d" add -A
  got="$(cd "$d" && staged_added_lines apps/x/new.txt | tr '\n' ' ')"
  if [[ "${got// /}" == "12" ]]; then
    passes=$((passes + 1)); printf 'ok   helper: a brand-new file reports every one of its lines\n'
  else
    failures=$((failures + 1)); printf 'FAIL helper: wanted lines 1 2 for a new file, got "%s"\n' "$got"
  fi

  # An unreadable diff must FAIL OPEN — report the line rather than swallow a
  # real violation. Outside a git repo there is no diff to read.
  if (cd "$WORK" && is_staged_added_line nope.txt 7) >/dev/null 2>&1; then
    passes=$((passes + 1)); printf 'ok   helper: an unreadable diff fails open\n'
  else
    failures=$((failures + 1)); printf 'FAIL helper: an unreadable diff must fail open and report the line\n'
  fi
fi

printf '\n%s passed, %s failed\n' "$passes" "$failures"
[[ "$failures" == 0 ]]
