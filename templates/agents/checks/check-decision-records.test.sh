#!/usr/bin/env bash
# Boundary rows for check-decision-records.sh: each of the seven parts, the
# no-args scan (changed, untracked, nested, deleted, renamed,
# committed-sibling collisions), --since, directory walks and caller errors.
#
# Every fixture lives in a real `git init`-ed repo, because the no-args mode
# reads `git diff HEAD` and `git ls-files --others`; a bare scratch directory
# cannot reach it. The script is run as a subprocess, never sourced.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-decision-records.sh"
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

# has <name> <haystack> <needle> — the output names the part the test claims.
has() {
  if [[ "$2" == *"$3"* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 — output lacks '$3':" >&2
    printf '%s\n' "$2" | sed 's/^/    /' >&2
  fi
}

hasnt() {
  if [[ "$2" != *"$3"* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 — output should not contain '$3'" >&2
  fi
}

# A fresh repo with one baseline commit. Sets REPO.
n=0
newrepo() {
  n=$((n + 1))
  REPO="$TMP/repo$n"
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" symbolic-ref HEAD refs/heads/main
  git -C "$REPO" config user.email t@example.com
  git -C "$REPO" config user.name tester
  echo seed >"$REPO/seed.txt"
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m seed
}

commit_all() { git -C "$REPO" add -A && git -C "$REPO" commit -q -m "$1"; }

# edit <file> <sed-script> — sed in place, portably: BSD sed needs a suffix
# argument to -i and GNU sed rejects a separate one, so go through a temp file.
edit() { sed "$2" "$1" >"$1.tmp" && mv "$1.tmp" "$1"; }

# rec <path> [status] [date] [decision-makers] — a record, valid unless told
# otherwise. `-` omits a key entirely; an empty string writes it blank.
rec() {
  local path="$REPO/$1" status="${2-accepted}" date="${3-2026-09-22}" dm="${4-Pat Doe}"
  mkdir -p "$(dirname "$path")"
  {
    echo '---'
    [[ "$status" != - ]] && echo "status: $status"
    [[ "$date" != - ]] && echo "date: $date"
    [[ "$dm" != - ]] && echo "decision-makers: $dm"
    echo '---'
    echo
    echo '# A decision'
    echo
    echo '## Context and Problem Statement'
    echo
    echo 'Something forced a choice.'
    echo
    echo '## Considered Options'
    echo
    echo '* One'
    echo '* Two'
    echo
    echo '## Decision Outcome'
    echo
    echo 'Chosen option: "One", because it works.'
    echo
    echo 'Pat Doe 2026-09-22: "agreed"'
  } >"$path"
}

# run [args...] — runs the check from $REPO. Sets OUT, ERR, RC.
run() {
  OUT="$(cd "$REPO" && bash "$SCRIPT" "$@" 2>"$TMP/err")"
  RC=$?
  ERR="$(cat "$TMP/err")"
}

# ── Explicit files: one case per part ─────────────────────────────────────

newrepo

rec decisions/0001-clean.md
run decisions/0001-clean.md
check "clean record" 0 "$RC"
has "clean record reports its count" "$OUT" "OK — 1 decision record(s) checked"

printf '# No frontmatter\n\nBody.\n' >"$REPO/decisions/0002-no-fm.md"
run decisions/0002-no-fm.md
check "missing frontmatter" 1 "$RC"
has "missing frontmatter is part (a)" "$ERR" "decisions/0002-no-fm.md: (a) no frontmatter"

: >"$REPO/decisions/0003-empty.md"
run decisions/0003-empty.md
check "zero-byte record" 1 "$RC"
has "zero-byte record is part (a)" "$ERR" "decisions/0003-empty.md: (a) no frontmatter"

printf -- '---\nstatus: proposed\ndate: 2026-09-22\n' >"$REPO/decisions/0004-unclosed.md"
run decisions/0004-unclosed.md
check "unclosed frontmatter" 1 "$RC"
has "unclosed frontmatter is part (a)" "$ERR" "(a) frontmatter is never closed"

rec decisions/0005-no-dm.md accepted 2026-09-22 -
run decisions/0005-no-dm.md
check "missing decision-makers key" 1 "$RC"
has "a missing key is part (a), not unassigned" "$ERR" "(a) missing required key: decision-makers"

rec decisions/0006-no-status.md -
run decisions/0006-no-status.md
check "missing status key" 1 "$RC"
has "missing status is part (a)" "$ERR" "(a) missing required key: status"

rec decisions/0007-decided.md decided
run decisions/0007-decided.md
check "status outside the vocabulary" 1 "$RC"
has "bad status word is part (b)" "$ERR" "decisions/0007-decided.md: (b) status 'decided'"

rec decisions/0008-bare.md "superseded by 0001"
run decisions/0008-bare.md
check "superseded by a bare number" 1 "$RC"
has "bare-number supersession is part (b)" "$ERR" "(b) status 'superseded by 0001'"

rec decisions/0009-by-path.md "superseded by decisions/0001-clean.md"
run decisions/0009-by-path.md
check "superseded by a repo path" 0 "$RC"

rec decisions/0010-nested-path.md "superseded by projects/web/x/decisions/0002-foo.md"
run decisions/0010-nested-path.md
check "superseded by a nested decisions path" 0 "$RC"

# shellcheck disable=SC2088  # the literal tilde is the case under test
for bad_path in /tmp/decisions/0001-clean.md ../decisions/0001-clean.md projects/../decisions/0001-clean.md "~/decisions/0001-clean.md" ./decisions/0001-clean.md; do
  rec decisions/0026-outside.md "superseded by $bad_path"
  run decisions/0026-outside.md
  check "superseded by a path that is not repo-relative: $bad_path" 1 "$RC"
  has "…is part (b): $bad_path" "$ERR" "(b) status 'superseded by $bad_path'"
done
rm "$REPO/decisions/0026-outside.md"

rec decisions/0011-quoted.md '"accepted"'
run decisions/0011-quoted.md
check "a quoted status value parses" 0 "$RC"

rec decisions/0024-unclosed.md '"accepted'
run decisions/0024-unclosed.md
check "an unclosed quote on status" 1 "$RC"
has "unclosed quote is part (a)" "$ERR" "decisions/0024-unclosed.md: (a) status has an unclosed quote"

rec decisions/0025-unclosed-dm.md accepted 2026-09-22 "'Pat Doe"
run decisions/0025-unclosed-dm.md
check "an unclosed quote on decision-makers" 1 "$RC"
has "…is part (a) too" "$ERR" "(a) decision-makers has an unclosed quote"

rec decisions/0027-escaped.md accepted 2026-09-22 '"Pat Doe\"'
run decisions/0027-escaped.md
check "an escaped closing quote on decision-makers" 1 "$RC"
has "…is an unclosed quote, part (a)" "$ERR" "(a) decision-makers has an unclosed quote"

rec decisions/0028-comment.md '"accepted" # after review' 2026-09-22 "'Pat O''Brien'"
run decisions/0028-comment.md
check "a comment after a closed quote, and a doubled single quote" 0 "$RC"

rec decisions/0029-trailing.md '"accepted" and then some'
run decisions/0029-trailing.md
check "text after a closed quote" 1 "$RC"
has "…is part (a)" "$ERR" "(a) status has text after its closing quote"

rec decisions/0012-short-date.md accepted 2026-9-1
run decisions/0012-short-date.md
check "malformed date" 1 "$RC"
has "malformed date is part (c)" "$ERR" "(c) date '2026-9-1'"

rec decisions/0013-feb30.md accepted 2026-02-30
run decisions/0013-feb30.md
check "a date that does not exist" 1 "$RC"
has "impossible date is part (c)" "$ERR" "(c) date '2026-02-30'"

rec decisions/0014-blank-dm.md accepted 2026-09-22 ""
run decisions/0014-blank-dm.md
check "blank decision-makers" 1 "$RC"
has "blank decision-makers is part (d)" "$ERR" "(d) decision-makers is empty"

rec decisions/0015-empty-list.md accepted 2026-09-22 "[]"
run decisions/0015-empty-list.md
check "decision-makers as an empty list" 1 "$RC"
has "empty list is part (d)" "$ERR" "(d) decision-makers is empty"

rec decisions/0016-block-list.md accepted 2026-09-22 ""
awk '{ print } /^decision-makers: $/ { print "  - Pat Doe" }' "$REPO/decisions/0016-block-list.md" \
  >"$TMP/bl" && mv "$TMP/bl" "$REPO/decisions/0016-block-list.md"
run decisions/0016-block-list.md
check "decision-makers as a block list" 0 "$RC"

rec decisions/no-number.md
run decisions/no-number.md
check "filename without NNNN" 1 "$RC"
has "missing number is part (e)" "$ERR" "decisions/no-number.md: (e) filename"

rec decisions/0017-Mixed_Case.md
run decisions/0017-Mixed_Case.md
check "filename not lowercase-with-dashes" 1 "$RC"
has "bad title is part (e)" "$ERR" "(e) filename must be NNNN-title-with-dashes.md"

rec decisions/0018-no-quote.md
edit "$REPO/decisions/0018-no-quote.md" '/^Pat Doe 2026-09-22/d'
run decisions/0018-no-quote.md
check "accepted without a body quote" 1 "$RC"
has "missing approval quote is part (g)" "$ERR" "decisions/0018-no-quote.md: (g) accepted"

rec decisions/0019-fm-quote.md
edit "$REPO/decisions/0019-fm-quote.md" '/^Pat Doe 2026-09-22/d'
awk '{ print } /^decision-makers: Pat Doe$/ { print "note: \"approved 2026-09-22\"" }' \
  "$REPO/decisions/0019-fm-quote.md" >"$TMP/fq" && mv "$TMP/fq" "$REPO/decisions/0019-fm-quote.md"
run decisions/0019-fm-quote.md
check "accepted whose only quote is in frontmatter" 1 "$RC"
has "frontmatter quote does not satisfy part (g)" "$ERR" "(g) accepted"

rec decisions/0020-date-no-quote.md
edit "$REPO/decisions/0020-date-no-quote.md" 's/^Pat Doe 2026-09-22: "agreed"$/Pat Doe agreed on 2026-09-22./'
run decisions/0020-date-no-quote.md
check "a dated line with no quoted words" 1 "$RC"
has "date alone is not part (g)" "$ERR" "(g) accepted"

rec decisions/0023-quote-then-date.md
edit "$REPO/decisions/0023-quote-then-date.md" \
  's/^Pat Doe 2026-09-22: "agreed"$/Someone asked "did we decide this?" (2026-09-19)./'
run decisions/0023-quote-then-date.md
check "a quote dated AFTER it is not an approval" 1 "$RC"
has "quote-then-date is part (g)" "$ERR" "0023-quote-then-date.md: (g) accepted"

rec decisions/0021-curly.md
edit "$REPO/decisions/0021-curly.md" 's/^Pat Doe 2026-09-22: "agreed"$/Pat Doe 2026-09-22: “agreed”/'
run decisions/0021-curly.md
check "typographic quotes satisfy part (g)" 0 "$RC"

rec decisions/0022-proposed.md proposed
edit "$REPO/decisions/0022-proposed.md" '/^Pat Doe 2026-09-22/d'
run decisions/0022-proposed.md
check "proposed needs no approval quote" 0 "$RC"

run decisions/does-not-exist.md
check "nonexistent explicit path" 2 "$RC"
has "caller error names the path" "$ERR" "not a file or directory: decisions/does-not-exist.md"

# ── Many records, several bad: every violation prints ─────────────────────

newrepo
rec decisions/0001-all-wrong.md decided 2026-13-01 ""
rec decisions/0002-also-wrong.md
edit "$REPO/decisions/0002-also-wrong.md" '/^Pat Doe 2026-09-22/d'
rec decisions/0003-fine.md
run decisions/0001-all-wrong.md decisions/0002-also-wrong.md decisions/0003-fine.md
check "multi-violation run" 1 "$RC"
has "multi: (b) printed" "$ERR" "0001-all-wrong.md: (b)"
has "multi: (c) printed" "$ERR" "0001-all-wrong.md: (c)"
has "multi: (d) printed" "$ERR" "0001-all-wrong.md: (d)"
has "multi: the second file's (g) printed too" "$ERR" "0002-also-wrong.md: (g)"
is_count="$(printf '%s\n' "$ERR" | grep -c ': ([a-g]) ')"
check "multi: exactly four violation lines" 4 "$is_count"
has "multi: stdout carries the one summary line" "$OUT" "FAIL — 3 decision record(s) checked, 4 violation(s)"

# ── Directory arguments ───────────────────────────────────────────────────

newrepo
rec decisions/0001-one.md
rec projects/x/decisions/0001-nested.md
printf '# Decision records\n' >"$REPO/decisions/README.md"
printf 'not a record\n' >"$REPO/projects/x/notes.md"
run decisions/
check "a directory argument is walked" 0 "$RC"
has "directory walk skips README.md" "$OUT" "OK — 1 decision record(s) checked"
run .
check "the repo root is walked at any depth" 0 "$RC"
has "root walk finds nested records and ignores other markdown" "$OUT" "OK — 2 decision record(s) checked"

rec projects/x/decisions/oops.md
run .
check "a directory walk still applies part (e)" 1 "$RC"
has "misnamed record inside a walked folder is part (e)" "$ERR" "projects/x/decisions/oops.md: (e)"

# ── No arguments ──────────────────────────────────────────────────────────

newrepo
run
check "no changes at all" 0 "$RC"
has "nothing to check still prints one line" "$OUT" "OK — 0 decision record(s) checked"

rec decisions/0001-brand-new.md
printf '# Decision records\n' >"$REPO/decisions/README.md"
run
check "a brand-new decisions/ folder is scanned file by file" 0 "$RC"
has "untracked record found, README ignored" "$OUT" "OK — 1 decision record(s) checked"

edit "$REPO/decisions/0001-brand-new.md" 's/^status: accepted$/status: decided/'
run
check "a bad untracked record fails the no-args scan" 1 "$RC"
has "no-args reports the repo-relative path" "$ERR" "decisions/0001-brand-new.md: (b)"

(cd "$REPO/decisions" && bash "$SCRIPT" >/dev/null 2>&1)
check "no-args from a subdirectory still scans from the repo root" 1 "$?"

newrepo
rec decisions/0001-kept.md
rec decisions/0002-unrelated.md decided
commit_all "records"
run
check "a committed bad record is not this close's problem" 0 "$RC"
has "clean tree checks nothing" "$OUT" "OK — 0 decision record(s) checked"

rec decisions/0001-collides.md
run
check "a new 0001 beside a COMMITTED 0001" 1 "$RC"
has "collision reported against the new file" "$ERR" \
  "decisions/0001-collides.md: (f) number 0001 is also used by 0001-kept.md"
has "…and against the committed sibling" "$ERR" \
  "decisions/0001-kept.md: (f) number 0001 is also used by 0001-collides.md"
hasnt "the committed bad sibling is not swept in" "$ERR" "0002-unrelated.md"
rm "$REPO/decisions/0001-collides.md"

rec projects/y/decisions/0001-nested-new.md
run
check "a changed record in a nested decisions/ is found" 0 "$RC"
has "nested record counted" "$OUT" "OK — 1 decision record(s) checked"
rm -r "$REPO/projects"

edit "$REPO/decisions/0001-kept.md" 's/^Chosen option: "One"/Chosen option: "Two"/'
run
check "a modified tracked record is checked" 0 "$RC"
has "modified record counted" "$OUT" "OK — 1 decision record(s) checked"
git -C "$REPO" checkout -q -- decisions/0001-kept.md

git -C "$REPO" rm -q decisions/0002-unrelated.md
run
check "a deleted record in the changed set is skipped" 0 "$RC"
has "deleted record not counted" "$OUT" "OK — 0 decision record(s) checked"
git -C "$REPO" reset -q --hard

git -C "$REPO" mv decisions/0001-kept.md decisions/0001-kept-renamed.md
run
check "a staged rename within one folder" 0 "$RC"
has "rename counts the new path once" "$OUT" "OK — 1 decision record(s) checked"
git -C "$REPO" reset -q --hard

# A staged move to a WIDER home. Porcelain -z carries the origin as a second
# field with no status prefix; read as an entry, `xy/decisions/0003-sub.md`
# loses three characters and becomes the destination path, counted twice.
rec xy/decisions/0003-sub.md
commit_all "sub record"
git -C "$REPO" mv xy/decisions/0003-sub.md decisions/0003-sub.md
run
check "a staged move out of a narrower home" 0 "$RC"
has "the rename origin is not read as an entry" "$OUT" "OK — 1 decision record(s) checked"
git -C "$REPO" reset -q --hard

mkdir -p "$REPO/projects/z"
mv "$REPO/decisions/0001-kept.md" "$REPO/projects/z/"
mkdir -p "$REPO/projects/z/decisions"
mv "$REPO/projects/z/0001-kept.md" "$REPO/projects/z/decisions/0001-kept.md"
run
check "an unstaged move to a narrower home" 0 "$RC"
has "move counts only the new path" "$OUT" "OK — 1 decision record(s) checked"

# --since: a record already COMMITTED on this branch — the loop commits
# before its close — differs from nothing at HEAD, so only --since sees it.
newrepo
rec decisions/0004-old.md decided
commit_all "a bad record from before this branch"
git -C "$REPO" checkout -q -b work
rec decisions/0001-committed.md decided
commit_all "a committed bad record"
run
check "a committed record is invisible without --since" 0 "$RC"
run --since main
check "--since finds a record committed on the branch" 1 "$RC"
has "…and names its part" "$ERR" "decisions/0001-committed.md: (b)"
rec decisions/0002-uncommitted.md
run --since main
has "--since still counts uncommitted records too" "$OUT" "FAIL — 2 decision record(s) checked"
git -C "$REPO" stash -q -u
git -C "$REPO" checkout -q main
echo "trunk edit" >>"$REPO/decisions/0004-old.md"
commit_all "the trunk edits an old record after the branch left it"
git -C "$REPO" checkout -q work
git -C "$REPO" stash pop -q >/dev/null
run --since main
check "the trunk-only case still fails on the branch's own record" 1 "$RC"
has "…which it still reports" "$ERR" "decisions/0001-committed.md: (b)"
hasnt "a record only the TRUNK changed is not this branch's (merge base, not main)" "$ERR" "0004-old.md"
run --since no-such-ref
check "--since an unknown ref is a caller error" 2 "$RC"
has "…with git's own reason kept, not swallowed" "$ERR" "Not a valid object name no-such-ref"
git -C "$REPO" checkout -q --orphan unrelated
git -C "$REPO" commit -q -m "no shared history"
run --since work
check "--since a ref with no shared history is a caller error" 2 "$RC"
has "…and says so" "$ERR" "cannot find where HEAD left work"
git -C "$REPO" checkout -q -f work
run --since
check "--since with no ref is a caller error" 2 "$RC"
run --since main decisions/
check "--since with paths is a caller error" 2 "$RC"

# A scan git cannot make is an error, never a clean "0 checked": a changed
# record would otherwise go unread.
newrepo
rec decisions/0001-changed.md
echo garbage >"$REPO/.git/index"
run
check "a git diff that fails is a caller error, not a clean scan" 2 "$RC"
has "…and names the git command" "$ERR" "git diff"

outside="$TMP/not-a-repo"
mkdir -p "$outside"
(cd "$outside" && bash "$SCRIPT" >/dev/null 2>&1)
check "no-args outside a git work tree" 2 "$?"

echo "check-decision-records.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
