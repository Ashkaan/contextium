#!/usr/bin/env bash
# Rows for lib/paths.sh: canon_missing gives GNU `realpath --canonicalize-missing`'s
# answer (symlinks in the existing part followed, a missing tail kept, `.` and
# `..` folded) without GNU; run_bounded stops a command at its limit and says
# so with 124. Where GNU realpath is present the rows are also checked against it.
set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/paths.sh"
# shellcheck source=SCRIPTDIR/paths.sh
. "$LIB"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
T="$(cd "$T" && pwd -P)"
pass=0
fail=0
is() { if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$3" "$2" >&2; fi; }

mkdir -p "$T/real/sub" "$T/links"
echo x >"$T/real/sub/file"
ln -s "$T/real" "$T/links/dirlink"
ln -s ../real/sub/file "$T/links/filelink"
ln -s "$T/nowhere/else" "$T/links/dangling"

is "an existing path" "$(canon_missing "$T/real/sub/file")" "$T/real/sub/file"
is "a missing tail is kept" "$(canon_missing "$T/real/sub/new/deeper.md")" "$T/real/sub/new/deeper.md"
is "a symlinked directory in the path is followed" "$(canon_missing "$T/links/dirlink/sub/new.md")" "$T/real/sub/new.md"
is "a symlinked leaf is followed" "$(canon_missing "$T/links/filelink")" "$T/real/sub/file"
is "a dangling link resolves to its missing target" "$(canon_missing "$T/links/dangling")" "$T/nowhere/else"
is "dot and dot-dot fold" "$(canon_missing "$T/real/./sub/../sub/x/../y")" "$T/real/sub/y"
is "a relative path is taken from PWD" "$(cd "$T/real" && canon_missing sub/z)" "$T/real/sub/z"
is "the root" "$(canon_missing /)" "/"
ln -s ../real/sub "$T/links/rel"
is ".. after a symlinked directory is taken from its target" "$(canon_missing "$T/links/dirlink/../elsewhere.md")" "$T/elsewhere.md"
is "…through a relative link too" "$(canon_missing "$T/links/rel/../x")" "$T/real/x"

if realpath --canonicalize-missing / >/dev/null 2>&1; then
  for p in "$T/real/sub/file" "$T/links/dirlink/sub/new.md" "$T/links/filelink" "$T/links/dangling" "$T/real/./sub/../sub/x/../y" "$T/links/dirlink/../elsewhere.md" "$T/links/rel/../x"; do
    is "agrees with GNU realpath: $p" "$(canon_missing "$p")" "$(realpath --canonicalize-missing -- "$p")"
  done
fi

start=$(date +%s)
rc=0; run_bounded 1 sleep 5 || rc=$?
is "a command past its limit returns 124" "$rc" "124"
is "…and is stopped near the limit" "$(( $(date +%s) - start < 4 ))" "1"
start=$(date +%s)
out="$(run_bounded 1 sh -c 'sleep 5; echo late' 2>/dev/null)"
is "a stopped command's own children do not hold its output open" "$(( $(date +%s) - start < 4 )):$out" "1:"
rc=0; run_bounded 5 sh -c 'exit 3' || rc=$?
is "a command within its limit keeps its own exit code" "$rc" "3"
is "…and its output" "$(run_bounded 5 echo hi)" "hi"

echo "paths.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
