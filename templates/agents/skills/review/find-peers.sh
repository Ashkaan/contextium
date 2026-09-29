#!/usr/bin/env bash
# find-peers.sh — catch incomplete class fixes
#
# Two jobs, one script:
#
#   1. VERIFY A DECLARED SWEEP (--verify-sweep). A class fix names the query
#      that defines its population; this re-runs the query and fails if
#      anything still matches. Run by `/implement` after a class fix and
#      quoted in report.md with its regex and pathspec (a record, not a
#      gate on any commit). This is the blocking half. It also audits
#      what the query EXCLUDES: a negative pathspec naming a whole
#      directory must not be hiding runnable source that still matches.
#
#   2. SURFACE AN UNDECLARED ONE (default mode). Warns when a token this
#      diff REMOVED still exists in a file the changed file declares as a
#      peer. Warn-only.
#
# A peer is only reported when the diff gives positive evidence it was left
# behind. Warning whenever a changed file had ANY declared peer, stale or not,
# once printed 16 warnings in a session that caught none of its five
# incomplete sweeps, so the output had stopped being read.
#
# Usage:
#   find-peers.sh                        # changed files (staged + unstaged)
#   find-peers.sh file1 file2 ...        # only the given files
#   find-peers.sh --verify-sweep <regex> [-- <pathspec>...]
#   find-peers.sh --peers <file>         # print the peers <file> declares
#
# Exit:
#   default mode   — 0 (warn-only; warnings on stderr), or 2 when a git read
#                    fails: a failed read is not "no changed files".
#   --verify-sweep — 0 when the population is clean, 1 when matches remain,
#                    2 on caller error (missing regex) or a failed git grep —
#                    an error is never read as "no surviving match".
#   --peers        — 0, one declared peer per line on stdout; 2 without a file.
#
# Boundary inputs:
#   - 0 files:          exit 0 silently
#   - 1 file:           checked; peer lookup unchanged
#   - N files:          all checked
#   - deleted file:     skipped (delete intent, no peer sweep)
#   - no removed lines: no tokens, so no warnings
#   - token re-added:   skipped (moved/reformatted, not removed)
#   - peer not on disk: skipped
#   - peer named ~/… or /…: read at that path
#   - peer also staged: skipped (it was swept)
#   - git failure:      empty via `|| true`
#   - sweep, no match:  exit 0
#   - sweep, matches:   exit 1, every match printed with file:line
#   - sweep, no regex:  exit 2 with usage
#   - sweep, no pathspec:           whole tree minus knowledge/ journal/
#                                   projects/, which are audited as below
#   - sweep, prose in a record:     not a match, exit 0
#   - exclusion names one file:     acknowledged survivor, never audited
#   - exclusion names a directory:  audited for runnable source
#   - excluded dir, prose only:     exit 0
#   - excluded dir, runnable match: exit 1, every match printed
#   - excluded path not on disk:    no candidates, exit 0

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# A git read that FAILS is not an empty one. Swallowed with `|| true`, a broken
# repo, a missing HEAD or a bad pathspec reads as "no changed files" or "no
# surviving match" — a clean gate over nothing. Every read below checks its
# exit and stops here instead. `git grep` exits 1 for "no match", which is a
# real answer; 2 and up is an error.
git_failed() { # git_failed <what> <exit>
  echo "find-peers: git $1 failed (exit $2) — refusing to read the failure as a clean result" >&2
  exit 2
}

# ── Mode 1: verify a declared sweep ──────────────────────────────────────
#
# The trailer carries a PATTERN and a PATHSPEC, never a shell command, so
# nothing arbitrary from a commit message is executed. A deliberate
# survivor is excluded via a negative pathspec (`:!path`), which forces
# exceptions to be written down instead of silently tolerated.
if [[ "${1:-}" == "--verify-sweep" ]]; then
  shift
  sweep_regex="${1:-}"
  [[ $# -gt 0 ]] && shift
  [[ "${1:-}" == "--" ]] && shift

  if [[ -z "$sweep_regex" ]]; then
    echo "find-peers: --verify-sweep needs a regex" >&2
    echo "  usage: find-peers.sh --verify-sweep <regex> [-- <pathspec>...]" >&2
    exit 2
  fi

  if [[ $# -eq 0 ]]; then
    set -- "$REPO_ROOT"
  fi

  # The records (knowledge/, journal/, projects/) live in this tree. A
  # journal entry quoting the retired pattern is prose about
  # the sweep, not an instance it missed, so the three are out of every
  # population whether or not the trailer names them — and audited below
  # exactly like a declared exclusion, so runnable source under projects/
  # cannot hide behind the default either.
  record_excludes=(':!knowledge' ':!journal' ':!projects/**/*.md')

  _rc=0
  sweep_hits=$(git grep -nE -e "$sweep_regex" -- "$@" ${record_excludes[@]+"${record_excludes[@]}"}) || _rc=$?
  [[ "$_rc" -le 1 ]] || git_failed grep "$_rc"

  if [[ -n "$sweep_hits" ]]; then
    echo "" >&2
    echo "CLASS-SWEEP INCOMPLETE: the declared population still has matches." >&2
    echo "" >&2
    echo "  pattern:  $sweep_regex" >&2
    echo "  pathspec: $*" >&2
    echo "" >&2
    printf '%s\n' "$sweep_hits" | sed 's/^/  /' >&2
    echo "" >&2
    echo "Every line above is an instance the sweep claimed to have closed." >&2
    echo "Fix them, or exclude a deliberate survivor with a negative" >&2
    echo "pathspec (:!path/to/keep) so the exception is explicit." >&2
    echo "" >&2
    echo "A class fix lands in every instance in the same session." >&2
    exit 1
  fi

  # ── The exclusion audit ────────────────────────────────────────────────
  #
  # Everything above re-runs the query AS DECLARED, which makes a negative
  # pathspec naming a whole DIRECTORY a blind spot: the gate that exists to
  # verify the sweep cannot see anything inside it.
  #
  # A sweep that excluded `:!projects` as historical prose once left an
  # executable script under projects/ still mirroring the file the commit
  # deleted. The machine reviewer found it; this gate passed.
  #
  # So every exclusion that is NOT a single named file is re-grepped for the
  # same regex, restricted to executable source. Prose stays excludable by
  # directory; a code survivor stays legal but has to be named as its own
  # file-level exclusion, which is the exception-on-the-record that
  # a class fix asks for. The two coexist:
  # `:!projects :!projects/x/scripts/scan.js` excludes the tree AND
  # acknowledges the one runnable file inside it.

  broad_excludes=()
  file_excludes=()
  for spec in "$@" ${record_excludes[@]+"${record_excludes[@]}"}; do
    case "$spec" in
      ':!'*) bare=${spec#:!} ;;
      ':^'*) bare=${spec#:^} ;;
      ':(exclude)'*) bare=${spec#':(exclude)'} ;;
      *) continue ;;
    esac
    [[ -n "$bare" ]] || continue
    case " ${broad_excludes[*]+"${broad_excludes[*]}"} " in
      *" $bare "*) continue ;;  # the trailer named a record tree itself
    esac
    if [[ -f "$REPO_ROOT/$bare" ]]; then
      # A single file named in the trailer IS the recorded exception.
      file_excludes+=(":!$bare")
    else
      broad_excludes+=("$bare")
    fi
  done

  # Executable source only. A .md, .json or .yaml inside an excluded tree is
  # the prose the exclusion is legitimately for; a file that RUNS is not.
  # Filtering the OUTPUT by extension rather than narrowing the pathspec
  # keeps this out of git's glob semantics, where `dir/*.ts` crossing `/`
  # is a behaviour to depend on rather than a thing to read.
  runnable_re='^[^:]+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|py|rb):'

  hidden=""
  for bare in ${broad_excludes[@]+"${broad_excludes[@]}"}; do
    _rc=0
    bare_hits=$(git grep -nE -e "$sweep_regex" \
      -- "$bare" ${file_excludes[@]+"${file_excludes[@]}"}) || _rc=$?
    [[ "$_rc" -le 1 ]] || git_failed grep "$_rc"
    [[ -n "$bare_hits" ]] || continue
    bare_runnable=$(printf '%s\n' "$bare_hits" | grep -E "$runnable_re" || true)
    [[ -n "$bare_runnable" ]] || continue
    hidden+="(excluded by :!$bare)"$'\n'"$bare_runnable"$'\n'
  done

  if [[ -n "$hidden" ]]; then
    echo "" >&2
    echo "CLASS-SWEEP EXCLUSION HIDES RUNNABLE CODE." >&2
    echo "" >&2
    echo "  pattern:  $sweep_regex" >&2
    echo "  pathspec: $*" >&2
    echo "" >&2
    printf '%s' "$hidden" | sed 's/^/  /' >&2
    echo "" >&2
    echo "The sweep passed only because these paths were excluded." >&2
    echo "Every file above RUNS, so it is a peer of this class fix," >&2
    echo "not the historical prose the exclusion was written for." >&2
    echo "" >&2
    echo "Fix them, or — if a match is deliberate — keep the directory" >&2
    echo "exclusion and add the file by name beside it, so the survivor" >&2
    echo "is on the record instead of hidden by the tree it sits in:" >&2
    echo "" >&2
    echo "  find-peers.sh --verify-sweep <regex> -- . :!<dir> :!<dir>/path/to/that/file.ts" >&2
    echo "" >&2
    echo "A class fix lands in every instance in the same session." >&2
    exit 1
  fi
  exit 0
fi

# ── Mode 2: surface an undeclared one ────────────────────────────────────

if [[ $# -gt 0 ]]; then
  changed=("$@")
else
  # bash 3.2 has no mapfile.
  changed=()
  _rc=0
  _changed_list=$(git diff --name-only HEAD) || _rc=$?
  [[ "$_rc" -eq 0 ]] || git_failed diff "$_rc"
  while IFS= read -r _l; do [[ -n "$_l" ]] && changed+=("$_l"); done <<<"$_changed_list"
fi

if [[ ${#changed[@]} -eq 0 ]]; then
  exit 0
fi

# The changed set, as a newline list: bash 3.2 has no associative arrays.
changed_set="$(printf '%s\n' ${changed[@]+"${changed[@]}"})"
changed_set_has() { printf '%s\n' "$changed_set" | grep -qxF -- "$1"; }

warn_count=0
warn() {
  echo "  PEER: $1" >&2
  warn_count=$((warn_count + 1))
}

# Read `peers:` frontmatter field from a file. Supports three YAML forms:
#   peers: [path1, path2, path3]
#   peers:
#     - path1
#     - path2
#   metadata:
#     peers: "path1 path2"        # skills: the Agent Skills spec allows no
#                                 # top-level peers key
# Emits one path per line on stdout. Silent if no frontmatter or no `peers:`.
read_frontmatter_peers() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  awk '
    BEGIN { in_fm = 0; fm_done = 0; in_peers = 0; in_metadata = 0 }
    NR == 1 && $0 == "---" { in_fm = 1; next }
    in_fm && $0 == "---" { fm_done = 1; exit }
    !fm_done && in_fm {
      # Nested form: metadata:\n  peers: "a b" — one scalar, split on spaces.
      if (match($0, /^metadata:[[:space:]]*$/)) { in_metadata = 1; in_peers = 0; next }
      if (in_metadata) {
        if ($0 ~ /^[[:space:]]+peers:/) {
          val = $0; sub(/^[[:space:]]+peers:[[:space:]]*/, "", val)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
          gsub(/^["'"'"']|["'"'"']$/, "", val)
          n = split(val, parts, /[[:space:]]+/)
          for (i = 1; i <= n; i++) if (parts[i] != "") print parts[i]
          next
        }
        if ($0 ~ /^[[:space:]]/) next
        in_metadata = 0
      }
      # Inline array form: peers: [a, b, c]
      if ($0 ~ /^peers:[[:space:]]*\[[^]]*\]/) {
        inner = $0; sub(/^peers:[[:space:]]*\[/, "", inner); sub(/\].*$/, "", inner)
        n = split(inner, parts, /[[:space:]]*,[[:space:]]*/)
        for (i = 1; i <= n; i++) {
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", parts[i])
          gsub(/^["'"'"']|["'"'"']$/, "", parts[i])
          if (parts[i] != "") print parts[i]
        }
        in_peers = 0
        next
      }
      # Block form: peers:\n  - path
      if (match($0, /^peers:[[:space:]]*$/)) { in_peers = 1; next }
      if (in_peers) {
        if ($0 ~ /^[[:space:]]+-[[:space:]]+./) {
          item = $0; sub(/^[[:space:]]+-[[:space:]]+/, "", item)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", item)
          gsub(/^["'"'"']|["'"'"']$/, "", item)
          if (item != "") print item
          next
        }
        # Left the block (dedented or sibling key) — stop reading peers
        in_peers = 0
      }
    }
  ' "$file" 2>/dev/null
}

# Read `peers:` from a shell-script's leading comment block. Shell scripts
# cannot carry YAML `---` frontmatter (the shebang must be on line 1), so
# peers are declared via `# peers:` header comments. Scans the first 30
# lines. Mirrors read_ts_comment_peers below.
#
# Supported forms:
#   # peers: scripts/x.sh, scripts/y.sh
#   # peers: scripts/x.sh
#   # peers:
#   #   - scripts/x.sh
#   #   - scripts/y.sh
#
# Emits one path per line. Silent if no `# peers:` declaration found.
read_sh_comment_peers() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  awk '
    BEGIN { in_peers = 0 }
    NR > 30 { exit }
    {
      # Single-line form: # peers: a, b, c
      if ($0 ~ /^[[:space:]]*#[[:space:]]*peers:[[:space:]]*./) {
        rhs = $0; sub(/^[[:space:]]*#[[:space:]]*peers:[[:space:]]*/, "", rhs)
        gsub(/^\[|\][[:space:]]*$/, "", rhs)
        n = split(rhs, parts, /[[:space:]]*,[[:space:]]*/)
        for (i = 1; i <= n; i++) {
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", parts[i])
          gsub(/^["'"'"']|["'"'"']$/, "", parts[i])
          if (parts[i] != "") print parts[i]
        }
        in_peers = 0
        next
      }
      # Block form opener: # peers:
      if (match($0, /^[[:space:]]*#[[:space:]]*peers:[[:space:]]*$/)) {
        in_peers = 1
        next
      }
      if (in_peers) {
        # Block continuation: #   - path
        if ($0 ~ /^[[:space:]]*#[[:space:]]+-[[:space:]]+./) {
          item = $0; sub(/^[[:space:]]*#[[:space:]]+-[[:space:]]+/, "", item)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", item)
          gsub(/^["'"'"']|["'"'"']$/, "", item)
          if (item != "") print item
          next
        }
        in_peers = 0
      }
    }
  ' "$file" 2>/dev/null
}

# Read `peers:` from a TS/JS file's leading comment block. TS files cannot
# carry YAML `---` frontmatter (it would be a parse error), so peers are
# declared via `// peers: a, b, c` lines in the script header. Scans only
# the first 30 lines (headers are short by convention).
#
# Supported forms:
#   // peers: apps/shared/x.ts, apps/shared/y.ts     (single-line, comma-sep)
#   // peers: apps/shared/x.ts                       (single path)
#   // peers:                                        (block form)
#   //   - apps/shared/x.ts
#   //   - apps/shared/y.ts
#
# Emits one path per line. Silent if no `// peers:` declaration found.
read_ts_comment_peers() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  awk '
    BEGIN { in_peers = 0 }
    NR > 30 { exit }
    {
      # Single-line form: // peers: a, b, c
      if ($0 ~ /^[[:space:]]*\/\/[[:space:]]*peers:[[:space:]]*./) {
        rhs = $0; sub(/^[[:space:]]*\/\/[[:space:]]*peers:[[:space:]]*/, "", rhs)
        # Strip leading [ and trailing ] if present
        gsub(/^\[|\][[:space:]]*$/, "", rhs)
        n = split(rhs, parts, /[[:space:]]*,[[:space:]]*/)
        for (i = 1; i <= n; i++) {
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", parts[i])
          gsub(/^["'"'"']|["'"'"']$/, "", parts[i])
          if (parts[i] != "") print parts[i]
        }
        in_peers = 0
        next
      }
      # Block form opener: // peers:
      if (match($0, /^[[:space:]]*\/\/[[:space:]]*peers:[[:space:]]*$/)) {
        in_peers = 1
        next
      }
      if (in_peers) {
        # Block continuation: //   - path
        if ($0 ~ /^[[:space:]]*\/\/[[:space:]]+-[[:space:]]+./) {
          item = $0; sub(/^[[:space:]]*\/\/[[:space:]]+-[[:space:]]+/, "", item)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", item)
          gsub(/^["'"'"']|["'"'"']$/, "", item)
          if (item != "") print item
          next
        }
        # Left the block — stop
        in_peers = 0
      }
    }
  ' "$file" 2>/dev/null
}

# Every peer path a file declares, by whichever syntax its type uses.
declared_peers() {
  local file="$1"
  read_frontmatter_peers "$REPO_ROOT/$file"
  case "$file" in
    *.ts | *.tsx | *.js | *.jsx | *.mts | *.cts)
      read_ts_comment_peers "$REPO_ROOT/$file"
      ;;
    *.sh | *.bash)
      read_sh_comment_peers "$REPO_ROOT/$file"
      ;;
  esac
}

# ── The reader on its own (placed after the readers it calls): --peers <file> ────────────────────────────────
#
# What a file declares, by whichever syntax its type uses. This is the
# lookup mode 2 runs per changed file; exposed so a caller (or a test) can
# ask it directly instead of staging a removal to observe it.
if [[ "${1:-}" == "--peers" ]]; then
  [[ -n "${2:-}" ]] || { echo "find-peers: --peers needs a file" >&2; exit 2; }
  # An absolute path is read where it is (some peers: lines spell a file in
  # another checkout that way); declared_peers prefixes REPO_ROOT, so the readers are called
  # directly. Declaration order is kept; only repeats are dropped.
  peers_file="$2"
  [[ "$peers_file" == /* ]] || peers_file="$REPO_ROOT/$peers_file"
  {
    read_frontmatter_peers "$peers_file"
    case "$peers_file" in
      *.ts | *.tsx | *.js | *.jsx | *.mts | *.cts) read_ts_comment_peers "$peers_file" ;;
      *.sh | *.bash) read_sh_comment_peers "$peers_file" ;;
    esac
  } | awk '!seen[$0]++'
  exit 0
fi

# Tokens this diff took OUT of a file and did not put back.
#
# The 8-char floor plus the required separator is what keeps this from
# becoming the noise generator it replaces: bare short words (`const`, a
# renamed loop variable) are never distinctive enough to mean anything in
# another file, while the things that actually get left behind — a dotted
# access path, a schema name, a file path, a slug — all clear it.
#
# A token still present in the additions was moved or reformatted, not
# removed, so it is dropped before any peer is searched.
# The diff is read by the CALLER and handed in: this runs in a process
# substitution, where a failed read could not stop the script.
removed_tokens() {
  local file="$1" diff_out="$2" removed added tok
  [[ -n "$diff_out" ]] || return 0

  removed=$(printf '%s\n' "$diff_out" | grep '^-' | grep -v '^---' || true)
  [[ -n "$removed" ]] || return 0
  added=$(printf '%s\n' "$diff_out" | grep '^+' | grep -v '^+++' || true)

  while IFS= read -r tok; do
    [[ -n "$tok" ]] || continue
    if [[ -n "$added" ]] && printf '%s\n' "$added" | grep -qF -- "$tok"; then
      continue
    fi
    printf '%s\n' "$tok"
  done < <(
    printf '%s\n' "$removed" |
      grep -oE '[A-Za-z_][A-Za-z0-9_.-]*[._/-][A-Za-z0-9_./-]*' |
      awk 'length($0) >= 8' |
      sort -u
  )
}

for file in ${changed[@]+"${changed[@]}"}; do
  # Skip deleted files — a peer sweep only applies to adds/edits.
  [[ -e "$REPO_ROOT/$file" ]] || continue

  file_peers=()
  while IFS= read -r _l; do file_peers+=("$_l"); done < <(declared_peers "$file" | sort -u)
  [[ ${#file_peers[@]} -eq 0 ]] && continue

  # Only peers that exist and were NOT themselves changed can be left behind.
  # A peer is repo-relative unless it names a home path (`~/…`, the form
  # skills use for their own scripts and references) or is absolute; those
  # are read where they are and can never be "changed in this diff".
  live_peers=()
  live_paths=()
  for peer in ${file_peers[@]+"${file_peers[@]}"}; do
    [[ -z "$peer" ]] && continue
    # shellcheck disable=SC2088  # the literal two characters are the pattern
    case "$peer" in
      "~/"*) peer_path="$HOME/${peer#\~/}" ;;
      /*) peer_path="$peer" ;;
      *) peer_path="$REPO_ROOT/$peer" ;;
    esac
    [[ -e "$peer_path" ]] || continue
    # A path that resolves inside this repo is looked up by its repo-relative
    # name, which is how the diff names it.
    peer_key="$peer"
    if [[ "$peer_path" == "$REPO_ROOT/"* ]]; then peer_key="${peer_path#"$REPO_ROOT"/}"; fi
    if changed_set_has "$peer_key"; then continue; fi
    live_peers+=("$peer")
    live_paths+=("$peer_path")
  done
  [[ ${#live_peers[@]} -eq 0 ]] && continue

  _rc=0
  file_diff=$(git diff -U0 HEAD -- "$file") || _rc=$?
  [[ "$_rc" -eq 0 ]] || git_failed diff "$_rc"

  while IFS= read -r token; do
    [[ -n "$token" ]] || continue
    for i in "${!live_peers[@]}"; do
      if grep -qF -- "$token" "${live_paths[$i]}" 2>/dev/null; then
        warn "${live_peers[$i]} still has '$token', which $file just removed"
      fi
    done
  done < <(removed_tokens "$file" "$file_diff")
done

if [[ $warn_count -gt 0 ]]; then
  echo "⚠ $warn_count peer(s) may be mid-sweep — see the tokens above" >&2
  echo "  If this IS a class fix, verify the sweep and quote it in report.md:" >&2
  echo "  find-peers.sh --verify-sweep <regex> -- <pathspec>  " >&2
fi

exit 0
