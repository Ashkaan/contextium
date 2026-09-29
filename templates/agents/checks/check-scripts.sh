#!/usr/bin/env bash
# check-scripts.sh — hold every script under .agents/ (the skills, checks,
# generators and hooks) to "carries a test, and the test RUNS it", before a
# close commits it.
#
# WHY. A script with no test is changed blind, and a test that imports or
# sources its subject instead of running it breaks the day the program changes
# language, while a test that spawns it survives with the interpreter line
# changed. AGENTS.md § Standards "Tests and evals" states the rule; this script
# owns whether a given tree obeys it.
#
# WHAT IT CHECKS — each violation carries the letter of the part it breaks:
#   (a)  every script has a paired test: `<stem>.test.sh` or `<stem>.test.ts`
#        beside it, or `tests/<stem>.test.{sh,ts}` in its folder or its parent.
#        Any test extension pairs with any script extension. Whether the suite
#        asserts anything is the runner's and the reviewer's business, not
#        this check's — an empty test file passes.
#   (b)  when the script is a PROGRAM, its paired test does not import or
#        source the script's own path — it runs it as a subprocess. A LIBRARY
#        is exempt from (b) only: it is a file at least one non-test file
#        under the roots imports or sources, so there is no program to run and
#        the import IS how it is used. Library status is re-derived on every run, so
#        deleting a library's last importer turns its import test into a (b)
#        violation on the next scan, incremental included.
#
# WHAT IS A SCRIPT. Under ROOTS below: every `*.sh`; every `.ts`, `.mjs`, `.js`
# or `.py` whose first line starts `#!` or whose parent folder is one of
# SCRIPT_DIRS. Never a `*.test.*`, a `*.template.*`, or anything under a
# `references/`, `tests/`, `templates/` or `node_modules/` segment. Nothing
# else re-derives the definition.
#
# WHAT CONTEXTIUM SHIPPED. A script the installer put here and that still
# matches the checksum it recorded (`.agents/<folder>/.contextium-manifest`)
# passes (a): its tests run in the Contextium repo, and the installer copies
# no tests. Once edited it no longer matches and is yours, test included —
# the same rule the installer uses to decide what it may remove.
#
# WHAT COUNTS AS AN IMPORT. A TypeScript/JS `from "<specifier>"` whose
# specifier, resolved against the importer's directory, is the subject's own
# path; or a shell `source <path>` / `. <path>` line whose path resolves the
# same way. A shell path built at run time (`"$(dirname "$0")/x.sh"`,
# `"$SCRIPT_DIR/x.sh"`, `"$HERE/../x.sh"`) cannot be resolved, so it counts
# when the importer sits in the subject's directory, or one folder below it.
# A comment that mentions the file matches neither shape.
#
# WHAT IT SCANS. With no arguments: part (a) over the scripts changed in this
# worktree since HEAD, staged or not, plus untracked ones — land.sh calls it
# BEFORE its `git add -A`; a changed or deleted `*.test.*` selects its paired
# subject (removing a script's only test is refused); a subject no longer on
# disk is skipped. And part (b) over EVERY test in the universe whose text
# imports or sources its own subject, changed or not. With `--since <ref>` the
# same, measured from where this branch left <ref>: a script the session
# already COMMITTED differs from nothing at HEAD. `--all` runs both parts over
# every script under ROOTS; explicit paths run both parts over exactly those
# files, or every script beneath a directory argument.
#
# Usage:
#   check-scripts.sh                  scripts changed since HEAD
#   check-scripts.sh --since <ref>    …since this branch left <ref>
#   check-scripts.sh --all            every script under the roots
#   check-scripts.sh <path>...        those files / directories
#
# Output (stdout): exactly one line — `OK — N script(s) checked`, or
#   `FAIL — N script(s) checked, M violation(s)`. N is the number of scripts
#   part (a) was run over; a (b) violation found by the universe-wide pass in
#   an incremental scan does not add to it.
# Output (stderr): one line per violation, `<path>: (<part>) <what is wrong>`.
#
# peers:
#   AGENTS.md § Standards "Tests and evals"         (the rule this enforces)
#   .agents/skills/close/scripts/land.sh     (the gate that calls it)
#   .agents/checks/check-scripts.test.sh
#
# bash 3.2 compatible (macOS): no declare -A, no GNU realpath, and no empty
# array expanded bare under set -u.
#
# Exit: 0 clean · 1 one or more violations · 2 caller error

set -uo pipefail

targets=()

err() { echo "$@" >&2; }

# ── The universe ─────────────────────────────────────────────────────────
ROOTS=(.agents)
SCRIPT_DIRS=(scripts checks deploy generators hooks)
EXCLUDE_SEGMENTS=(references tests templates node_modules)
SCRIPT_EXTS=(sh ts mjs js py)
TEST_EXTS=(sh ts)

script_root() { (cd "$(dirname "$0")/../.." && pwd); }

# resolve_path <path> — the path with every existing directory resolved
# physically and a missing tail kept as written; `realpath -m` without GNU.
resolve_path() {
  local p="$1" head tail=""
  case "${p}" in /*) ;; *) p="${PWD}/${p}" ;; esac
  head="${p}"
  while [ ! -d "${head}" ]; do
    tail="/$(basename "${head}")${tail}"
    head="$(dirname "${head}")"
  done
  printf '%s%s\n' "$(cd "${head}" && pwd -P)" "${tail}"
}

in_roots() {
  local p="$1" r
  for r in ${ROOTS[@]+"${ROOTS[@]}"}; do
    [[ "$p" == "$r/"* ]] && return 0
  done
  return 1
}

excluded_segment() {
  local p="$1" s
  for s in ${EXCLUDE_SEGMENTS[@]+"${EXCLUDE_SEGMENTS[@]}"}; do
    [[ "/$p/" == *"/$s/"* ]] && return 0
  done
  return 1
}

in_script_dir() {
  local parent d
  parent="$(basename "$(dirname "$1")")"
  for d in ${SCRIPT_DIRS[@]+"${SCRIPT_DIRS[@]}"}; do
    [[ "$parent" == "$d" ]] && return 0
  done
  return 1
}

# is_script <repo-relative path> — the definition in the header. Reads the
# first line for the shebang, so the file has to be on disk.
is_script() {
  local p="$1" b
  b="$(basename "$p")"
  in_roots "$p" || return 1
  excluded_segment "$p" && return 1
  case "$b" in *.test.* | *.template.*) return 1 ;; esac
  case "$b" in
    *.sh) return 0 ;;
    *.ts | *.mjs | *.js | *.py)
      [[ -f "$p" ]] || return 1
      local first=""
      IFS= read -r -n 2 first <"$p" 2>/dev/null
      [[ "$first" == '#!' ]] && return 0
      in_script_dir "$p"
      ;;
    *) return 1 ;;
  esac
}

# every_script — every script under ROOTS, one per line, sorted. `find` rather
# than `git ls-files` so a script that appeared since the last commit counts.
# A `find` that fails is a caller error, not an empty universe: errexit is off
# above, so the status is checked here.
every_script() {
  local r
  local -a prune=()
  local s
  for s in ${EXCLUDE_SEGMENTS[@]+"${EXCLUDE_SEGMENTS[@]}"}; do
    prune+=(-o -name "$s")
  done
  local listing
  listing="$(mktemp)" || exit 2
  for r in ${ROOTS[@]+"${ROOTS[@]}"}; do
    [[ -d "$r" ]] || continue
    find "$r" \( -type d \( -false ${prune[@]+"${prune[@]}"} \) -prune \) -o -type f \
      \( -name '*.sh' -o -name '*.ts' -o -name '*.mjs' -o -name '*.js' -o -name '*.py' \) -print >>"$listing" || {
      err "check-scripts: find failed under $r"
      rm -f "$listing"
      exit 2
    }
  done
  sort "$listing" | while IFS= read -r p; do
    is_script "$p" && printf '%s\n' "$p"
  done
  rm -f "$listing"
}

# universe — every_script into $UNIVERSE, once. Called directly, never in a
# process substitution: the status of a `find` that failed has to reach the
# caller, or a partial scan prints OK.
UNIVERSE=""
universe() {
  [[ -n "$UNIVERSE" ]] && return 0
  UNIVERSE="$(mktemp)" || exit 2
  every_script >"$UNIVERSE" || exit 2
}

# find_tests <script> — prints every paired test's path, one per line, or
# returns 1 when there is none. Part (a) needs one; part (b) reads them all,
# because a program with a clean `.test.sh` beside an importing `.test.ts` is
# still imported.
stem_of() { local b; b="$(basename "$1")"; printf '%s' "${b%.*}"; }
find_tests() {
  local p="$1" d stem c e found=1
  d="$(dirname "$p")"
  stem="$(stem_of "$p")"
  for c in "$d/$stem" "$d/tests/$stem" "$(dirname "$d")/tests/$stem"; do
    for e in ${TEST_EXTS[@]+"${TEST_EXTS[@]}"}; do
      [[ -f "$c.test.$e" ]] && { printf '%s\n' "${c#./}.test.$e"; found=0; }
    done
  done
  return $found
}

# subjects_of_test <test path> — the scripts this test pairs with (usually
# one), so a changed or deleted test selects its subject. Sets SUBJECTS.
subjects_of_test() {
  local t="$1" d b stem c e
  SUBJECTS=()
  d="$(dirname "$t")"
  b="$(basename "$t")"
  stem="${b%%.test.*}"
  # find_tests' three shapes, inverted: a test beside its script; in the
  # script's tests/ (script in the parent); in the tests/ beside the script's
  # folder (script in any sibling folder of this tests/).
  local -a dirs=("$d")
  if [[ "$(basename "$d")" == tests ]]; then
    local parent sib
    parent="$(dirname "$d")"
    dirs+=("$parent")
    for sib in "$parent"/*/; do
      sib="${sib%/}"
      [[ -d "$sib" && "$sib" != "$d" ]] && dirs+=("$sib")
    done
  fi
  for c in ${dirs[@]+"${dirs[@]}"}; do
    for e in ${SCRIPT_EXTS[@]+"${SCRIPT_EXTS[@]}"}; do
      [[ -f "$c/$stem.$e" ]] || continue
      is_script "$c/$stem.$e" && SUBJECTS+=("$c/$stem.$e")
    done
  done
}

# ── Imports ──────────────────────────────────────────────────────────────

# literal_tail <spec> — the literal text after the last run-time part of a
# shell path. A small scanner, bash 3.2 safe: each `$(…)` and `${…}` is skipped
# whole, and inside one, quotes and further substitutions are skipped with
# their own scope, so a `)` in `tr -d ")"` or in a folder's own name never
# ends anything early. `$NAME` and backtick spans are run-time too. Quotes
# outside every substitution are dropped.
_LT_S="" _LT_N=0 _LT_POS=0
_lt_backtick() { # _LT_POS on the opening backtick; leaves it after the closing one
  _LT_POS=$((_LT_POS + 1))
  while ((_LT_POS < _LT_N)) && [[ "${_LT_S:_LT_POS:1}" != '`' ]]; do _LT_POS=$((_LT_POS + 1)); done
  _LT_POS=$((_LT_POS + 1))
}
_lt_dquote() { # _LT_POS just after an opening "; leaves it after the closing "
  local c
  while ((_LT_POS < _LT_N)); do
    c="${_LT_S:_LT_POS:1}"
    if [[ "$c" == "\\" ]]; then
      _LT_POS=$((_LT_POS + 2))
    elif [[ "$c" == '"' ]]; then
      _LT_POS=$((_LT_POS + 1))
      return
    elif [[ "$c" == '$' && ( "${_LT_S:_LT_POS+1:1}" == '(' || "${_LT_S:_LT_POS+1:1}" == '{' ) ]]; then
      _LT_POS=$((_LT_POS + 2))
      _lt_subst "${_LT_S:_LT_POS-1:1}"
    elif [[ "$c" == '`' ]]; then
      _lt_backtick
    else
      _LT_POS=$((_LT_POS + 1))
    fi
  done
}
_lt_subst() { # <( or {> — _LT_POS just after the opener; leaves it after the closer
  local open="$1" close=')' depth=1 c
  [[ "$open" == '{' ]] && close='}'
  while ((_LT_POS < _LT_N)); do
    c="${_LT_S:_LT_POS:1}"
    if [[ "$c" == "'" ]]; then
      _LT_POS=$((_LT_POS + 1))
      while ((_LT_POS < _LT_N)) && [[ "${_LT_S:_LT_POS:1}" != "'" ]]; do _LT_POS=$((_LT_POS + 1)); done
      _LT_POS=$((_LT_POS + 1))
    elif [[ "$c" == '"' ]]; then
      _LT_POS=$((_LT_POS + 1))
      _lt_dquote
    elif [[ "$c" == "\\" ]]; then
      _LT_POS=$((_LT_POS + 2))
    elif [[ "$c" == '$' && ( "${_LT_S:_LT_POS+1:1}" == '(' || "${_LT_S:_LT_POS+1:1}" == '{' ) ]]; then
      _LT_POS=$((_LT_POS + 2))
      _lt_subst "${_LT_S:_LT_POS-1:1}"
    elif [[ "$c" == '`' ]]; then
      _lt_backtick
    elif [[ "$c" == "$open" ]]; then
      depth=$((depth + 1)); _LT_POS=$((_LT_POS + 1))
    elif [[ "$c" == "$close" ]]; then
      depth=$((depth - 1)); _LT_POS=$((_LT_POS + 1))
      ((depth == 0)) && return
    else
      _LT_POS=$((_LT_POS + 1))
    fi
  done
}
literal_tail() {
  local tail="" c
  _LT_S="$1"; _LT_N=${#1}; _LT_POS=0
  while ((_LT_POS < _LT_N)); do
    c="${_LT_S:_LT_POS:1}"
    if [[ "$c" == '$' && ( "${_LT_S:_LT_POS+1:1}" == '(' || "${_LT_S:_LT_POS+1:1}" == '{' ) ]]; then
      _LT_POS=$((_LT_POS + 2))
      _lt_subst "${_LT_S:_LT_POS-1:1}"
      tail=""
    elif [[ "$c" == '$' ]]; then
      _LT_POS=$((_LT_POS + 1))
      while ((_LT_POS < _LT_N)) && [[ "${_LT_S:_LT_POS:1}" == [A-Za-z0-9_] ]]; do _LT_POS=$((_LT_POS + 1)); done
      tail=""
    elif [[ "$c" == '`' ]]; then
      _lt_backtick
      tail=""
    else
      [[ "$c" == '"' || "$c" == "'" ]] || tail="$tail$c"
      _LT_POS=$((_LT_POS + 1))
    fi
  done
  printf '%s' "$tail"
}

# resolves_to <importer> <specifier> <subject-realpath> — does this specifier,
# read from <importer>, name the subject? Run-time-built shell paths (anything
# holding `$` or a backtick) resolve by proximity: the importer sits in the
# subject's folder or one below it.
resolves_to() {
  local importer="$1" spec="$2" subject="$3" idir sdir
  idir="$(dirname "$importer")"
  sdir="$(dirname "$subject")"
  if [[ "$spec" == *'$'* || "$spec" == *'`'* ]]; then
    local ireal tail
    ireal="$(resolve_path "$idir")"
    # The literal tail after the last run-time part (`/../scripts/x.sh` of
    # `$HERE/../scripts/x.sh`). A tail with folders in it names where it
    # points, read from the importer's folder; only a bare `/x.sh` is left to
    # proximity.
    tail="$(literal_tail "$spec")"
    tail="${tail#/}"
    if [[ "$tail" == */* ]]; then
      [[ "$(resolve_path "$ireal/$tail")" == "$subject" ]]
      return
    fi
    [[ "$ireal" == "$sdir" ]] && return 0
    [[ "$(dirname "$ireal")" == "$sdir" && "$(basename "$ireal")" == tests ]] && return 0
    # the tests/ beside the subject's folder (`$HERE/../scripts/x.sh`)
    [[ "$(basename "$ireal")" == tests && "$(dirname "$ireal")" == "$(dirname "$sdir")" ]] && return 0
    return 1
  fi
  if [[ "$spec" == /* ]]; then
    [[ "$(resolve_path "$spec")" == "$subject" ]]
  else
    [[ "$(resolve_path "$idir/$spec")" == "$subject" ]]
  fi
}

# imports_subject <file> <subject> — does <file> import or source <subject>?
# Only `from "…"` and a leading `source`/`.` count; a comment naming the file
# matches neither.
imports_subject() {
  local file="$1" subject="$2" stem sreal line spec
  # A file that cannot be read cannot be cleared: stop, never read it as clean.
  [[ -r "$file" ]] || { err "check-scripts: cannot read $file"; exit 2; }
  stem="$(stem_of "$subject")"
  sreal="$(resolve_path "$subject")"
  case "$subject" in
    *.sh)
      while IFS= read -r line; do
        [[ "$line" =~ ^[[:space:]]*(source|\.)[[:space:]]+(.*)$ ]] || continue
        # The path is everything up to the first `;`, `&&` or `||`; quotes
        # come off after, so a `$(dirname "$0")/x.sh` keeps its inner quotes.
        spec="${BASH_REMATCH[2]}"
        spec="${spec%%;*}"; spec="${spec%%&&*}"; spec="${spec%%||*}"
        spec="${spec%"${spec##*[![:space:]]}"}"
        spec="${spec%\"}"; spec="${spec#\"}"
        spec="${spec%\'}"; spec="${spec#\'}"
        [[ "$spec" == *"$stem.sh"* ]] || continue
        resolves_to "$file" "$spec" "$sreal" && return 0
      done < <(grep -E "^[[:space:]]*(source|\.)[[:space:]]+.*${stem}\.sh" "$file" 2>/dev/null)
      ;;
    *)
      # Comment lines (`//`, `/*`, ` *`) are dropped before the match: a test
      # that says it "used to `import … from "./x.ts"`" is not importing.
      while IFS= read -r spec; do
        resolves_to "$file" "$spec" "$sreal" && return 0
      done < <(grep -vE '^[[:space:]]*(//|/\*|\*)' "$file" 2>/dev/null \
        | grep -oE "from[[:space:]]+[\"'][^\"']*${stem}\.(ts|mjs|js)[\"']" \
        | sed -E "s/^from[[:space:]]+[\"']//; s/[\"']\$//")
      ;;
  esac
  return 1
}

# is_library <subject> — does a non-test file under the roots import or source
# it? One grep over the roots for the stem, then each candidate resolved.
is_library() {
  local subject="$1" stem pat cand
  stem="$(stem_of "$subject")"
  case "$subject" in
    *.sh) pat="^[[:space:]]*(source|\.)[[:space:]]+.*${stem}\.sh" ;;
    *) pat="from[[:space:]]+[\"'][^\"']*${stem}\.(ts|mjs|js)[\"']" ;;
  esac
  local -a existing=()
  local r
  for r in ${ROOTS[@]+"${ROOTS[@]}"}; do [[ -d "$r" ]] && existing+=("$r"); done
  [[ ${#existing[@]} -gt 0 ]] || return 1
  while IFS= read -r cand; do
    [[ -n "$cand" ]] || continue
    [[ "$cand" == "$subject" ]] && continue
    imports_subject "$cand" "$subject" && return 0
  done < <(grep -rlE --exclude='*.test.*' --exclude-dir=node_modules "$pat" ${existing[@]+"${existing[@]}"} 2>/dev/null)
  return 1
}

# ── Parts ────────────────────────────────────────────────────────────────

violations=0
violation() { violations=$((violations + 1)); err "$1: ($2) $3"; }

# shipped <script> — Contextium installed it and it is unchanged since: its
# folder's manifest lists it with the checksum it still has.
shipped() {
  local p="$1" item manifest want
  item="${p#.agents/}"; item="${item%%/*}"
  manifest=".agents/$item/.contextium-manifest"
  [[ -f "$manifest" ]] || return 1
  want="$(awk -F'\t' -v p="$p" '$1 == p { print $2; exit }' "$manifest")"
  [[ -n "$want" ]] || return 1
  [[ "$(cksum <"$p" | awk '{print $1, $2}')" == "$want" ]]
}

part_a() {
  local p="$1" stem
  stem="$(stem_of "$p")"
  find_tests "$p" >/dev/null && return 0
  shipped "$p" && return 0
  violation "$p" a "no test — expected $stem.test.sh or $stem.test.ts beside it, or tests/$stem.test.* in its folder or parent"
  return 1
}

part_b() {
  local p="$1" t library=""
  while IFS= read -r t; do
    imports_subject "$t" "$p" || continue
    [[ -n "$library" ]] || { is_library "$p" && library=yes || library=no; }
    [[ "$library" == yes ]] && return 0
    violation "$t" b "imports its subject $p — run it as a subprocess"
  done < <(find_tests "$p")
  return 0
}

# ── Modes ────────────────────────────────────────────────────────────────

mode="changed"
since=""
case "${1:-}" in
  --all)
    [[ $# -eq 1 ]] || { err "check-scripts: --all takes no paths"; exit 2; }
    mode="all"
    ;;
  --since)
    [[ -n "${2:-}" ]] || { err "check-scripts: --since needs a ref"; exit 2; }
    since="$2"
    shift 2
    [[ $# -eq 0 ]] || { err "check-scripts: --since takes no paths"; exit 2; }
    ;;
  -*)
    err "check-scripts: unknown option $1"
    exit 2
    ;;
  "") ;;
  *) mode="paths" ;;
esac

# Each path once. A newline-framed list rather than an associative array,
# which bash 3.2 lacks; a path never holds a newline here.
seen=$'\n'
add_target() {
  case "$seen" in *$'\n'"$1"$'\n'*) return 0 ;; esac
  seen="$seen$1"$'\n'
  targets+=("$1")
}

if [[ "$mode" == "paths" ]]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || script_root)"
  cd "$REPO_ROOT" || exit 2
  for arg in "$@"; do
    arg="${arg#"$REPO_ROOT"/}"
    arg="${arg#./}"
    if [[ -d "$arg" ]]; then
      universe
      while IFS= read -r p; do
        [[ "$p" == "$arg/"* || "$p" == "$arg" ]] && add_target "$p"
      done <"$UNIVERSE"
    elif [[ -f "$arg" ]]; then
      is_script "$arg" && add_target "$arg"
    else
      err "check-scripts: no such file or directory: $arg"
      exit 2
    fi
  done
  for p in ${targets[@]+"${targets[@]}"}; do part_a "$p" && part_b "$p"; done
elif [[ "$mode" == "all" ]]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || script_root)"
  cd "$REPO_ROOT" || exit 2
  universe
  while IFS= read -r p; do add_target "$p"; done <"$UNIVERSE"
  for p in ${targets[@]+"${targets[@]}"}; do part_a "$p" && part_b "$p"; done
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    err "check-scripts: not inside a git work tree"
    exit 2
  }
  cd "$REPO_ROOT" || exit 2
  base="HEAD"
  if [[ -n "$since" ]]; then
    base="$(git merge-base HEAD "$since")" || {
      err "check-scripts: cannot find where HEAD left $since"
      exit 2
    }
  fi
  # Tracked changes against the base plus untracked files, one per file.
  # `--no-renames` lists a move as its two halves; the half no longer on disk
  # is skipped as a subject, but as a TEST it still selects what it paired —
  # and a test under `tests/` is read BEFORE the excluded-segment rule, which
  # is about scripts, or deleting a script's only test there would pass.
  # Either listing failing is a caller error, never an empty change set.
  changed="$(mktemp)" || exit 2
  git diff -z --name-only --no-renames "$base" >"$changed" || {
    err "check-scripts: git diff against $base failed"
    rm -f "$changed"
    exit 2
  }
  git ls-files -z --others --exclude-standard >>"$changed" || {
    err "check-scripts: git ls-files failed"
    rm -f "$changed"
    exit 2
  }
  while IFS= read -r -d '' path; do
    in_roots "$path" || continue
    if [[ "$(basename "$path")" == *.test.* ]]; then
      subjects_of_test "$path"
      for p in ${SUBJECTS[@]+"${SUBJECTS[@]}"}; do add_target "$p"; done
    else
      excluded_segment "$path" && continue
      [[ -f "$path" ]] || continue
      is_script "$path" && add_target "$path"
    fi
  done <"$changed"
  rm -f "$changed"
  for p in ${targets[@]+"${targets[@]}"}; do part_a "$p"; done
  # Part (b) over the whole universe: library status depends on files that
  # did not change, so the changed set cannot scope it.
  universe
  while IFS= read -r p; do part_b "$p"; done <"$UNIVERSE"
fi
rm -f "$UNIVERSE"

if [[ $violations -gt 0 ]]; then
  echo "FAIL — ${#targets[@]} script(s) checked, ${violations} violation(s)"
  exit 1
fi
echo "OK — ${#targets[@]} script(s) checked"
