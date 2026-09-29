#!/usr/bin/env bash
# blast-radius.sh — the whole-repo context a reviewer cannot see in a diff.
#
# A diff shows what a file now says. It does not show who CALLS the function
# whose signature just moved, and that is the finding class an isolated review
# structurally cannot produce. Hosted review apps sell exactly that answer over
# a persistent index. This computes it per review from the
# working tree instead — no vendor, no index to go stale while you edit, and it
# reads the tree the session actually changed rather than the last push.
#
# It is CONTEXT, never a verdict. It has no pass and no fail: code-review.sh
# pastes its stdout into the prompt and reviews the diff either way. A packer
# that could block a review would be a seventh gate for a question ("who calls
# this?") whose answer is never by itself a defect.
#
# Usage:
#   blast-radius.sh [--repo DIR] [--diff-file PATH|-] [--old-ref REV]
#                   [--files-file PATH] [FILE...]
#
# Flags:
#   --repo DIR         repo to read (default: git toplevel of cwd)
#   --diff-file PATH   unified diff scoping the pack to CHANGED symbols; `-`
#                      reads stdin. Without one, every export in every listed
#                      file is treated as changed.
#   --old-ref REV      revision the diff's `-` side came from (default HEAD).
#                      Only used to fetch old bytes for deleted-export lookup.
#   --files-file PATH  newline-separated file list, merged with FILE args
#
# Output (stdout): a `BLAST RADIUS` block, or nothing at all. Per listed
# .ts/.tsx/.sh file that still exists, three independent sections — who imports
# it, what it imports that this change does not touch, and the callers of each
# changed symbol.
#
# Exit:
#   0  pack written (an EMPTY pack is a success — see the boundary table)
#   2  caller error: unreadable repo, unreadable --files-file / --diff-file
#
# Boundary inputs:
#   - 0 files / empty --files-file:  no output, exit 0
#   - 1 file, no exports, no importers: no output for it, exit 0
#   - every listed file deleted:     no output, exit 0
#   - a deleted file among live ones: skipped, the rest are packed
#   - no .ts/.tsx/.sh in the list:   no output, exit 0
#   - comment-or-whitespace-only diff: import graph still printed, no symbols
#   - identifier under 4 chars:      never a symbol (greps to noise)
#   - over the caps:                 truncated-symbols / truncated-callers /
#                                    truncated-bytes lines, pack still printed
#   - parser package missing:        WARN on stderr, regex symbols, graph intact
#   - repo is not a git repo:        exit 2
#
# CAPS, AND WHY THEY ARE THIS SCRIPT'S OWN. MAX_BYTES is 32KiB and is never
# taken out of code-review.sh's 400,000-byte MAX_DIFF_BYTES: sharing that budget
# would mean a large pack silently shrinking the DIFF, and a review of a
# truncated diff reported as clean is the failure that script exists to prevent.
# The pack is the part that gets dropped, because it is the optional part.
#
# IMPORT MATCHING IS BOUNDED, AND DIFFERENTLY PER LANGUAGE.
#   TypeScript is RESOLVED: candidates come from a basename grep over
#   `from '...'`, `import('...')` and `export ... from '...'`, and each
#   candidate's specifier is then resolved against the importing file's own
#   directory and compared to the target. `.js` specifiers match `.ts` sources.
#   Not attempted: tsconfig `paths`, package.json `exports`, computed
#   specifiers — a wrong resolution would name a file that does not import this
#   one at all.
#   Shell is BASENAME-TAILED: `. path` / `source path` specifiers in this repo
#   are routinely `"$SCRIPT_DIR/x.sh"`, so there is no literal path to resolve.
#   Matching the basename tail is the honest bound; it over-matches two
#   same-named scripts in different directories and says so here rather than
#   pretending to resolve a variable.
#
# Search population: git-tracked plus untracked-not-ignored files, via
# `git grep --untracked` — the same set code-review.sh puts in front of the
# reviewer, so the pack cannot cite a file the diff never showed — minus the
# records (knowledge/, journal/, projects/, which live in the same tree): a
# journal entry that quotes a symbol is prose about it, not a caller.
#
# peers:
#   .agents/skills/review/blast-radius-symbols.mjs
#   .agents/skills/review/blast-radius.test.sh
#   .agents/skills/review/code-review.sh
#   .agents/skills/review/find-peers.sh

set -euo pipefail

err() { echo "$@" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Plain JavaScript as .mjs, so any supported Node runs it with no type-stripping
# flag (older Node refuses a .ts file outright).
SYMBOLS_TS="${SCRIPT_DIR}/blast-radius-symbols.mjs"

# Deterministic ordering everywhere, so the same tree packs the same bytes.
export LC_ALL=C

# Every repo-wide grep below takes these after its `--`.
RECORD_EXCLUDES=(':!knowledge' ':!journal' ':!projects/**/*.md')

MAX_SYMBOLS="${BLAST_RADIUS_MAX_SYMBOLS:-32}"
MAX_CALLERS="${BLAST_RADIUS_MAX_CALLERS:-8}"
MAX_BYTES="${BLAST_RADIUS_MAX_BYTES:-32768}"

REPO=""
DIFF_FILE=""
OLD_REF="HEAD"
FILES_FILE=""
ARG_FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:-}"; [[ $# -gt 1 ]] || { err "blast-radius: --repo needs a directory"; exit 2; }; shift 2 ;;
    --diff-file) DIFF_FILE="${2:-}"; [[ $# -gt 1 ]] || { err "blast-radius: --diff-file needs a path"; exit 2; }; shift 2 ;;
    --old-ref) OLD_REF="${2:-}"; [[ $# -gt 1 ]] || { err "blast-radius: --old-ref needs a revision"; exit 2; }; shift 2 ;;
    --files-file) FILES_FILE="${2:-}"; [[ $# -gt 1 ]] || { err "blast-radius: --files-file needs a path"; exit 2; }; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0" >&2; exit 0 ;;
    --*) err "blast-radius: unknown flag: $1"; exit 2 ;;
    *) ARG_FILES+=("$1"); shift ;;
  esac
done

REPO="${REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "$REPO" ]] || ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  err "blast-radius: not a git repo: ${REPO:-<cwd>}"
  exit 2
fi
REPO="$(cd "$REPO" && pwd)"
cd "$REPO"

# Caller errors are checked BEFORE any early exit. An unreadable --diff-file is
# a bug in the caller whether or not the file list turned out to be empty, and
# reporting 0 for it would hide a typo'd path behind an empty pack.
if [[ -n "$DIFF_FILE" && "$DIFF_FILE" != "-" && ! -f "$DIFF_FILE" ]]; then
  err "blast-radius: --diff-file not found: $DIFF_FILE"
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/blast-radius.XXXXXX")"
# shellcheck disable=SC2329  # invoked indirectly by the trap
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ── The file list ─────────────────────────────────────────────────────

RAW_LIST="$TMP/raw-list"
: >"$RAW_LIST"
if [[ -n "$FILES_FILE" ]]; then
  if [[ "$FILES_FILE" == "-" ]]; then
    cat >>"$RAW_LIST"
  elif [[ -f "$FILES_FILE" ]]; then
    cat "$FILES_FILE" >>"$RAW_LIST"
  else
    err "blast-radius: --files-file not found: $FILES_FILE"
    exit 2
  fi
fi
if [[ ${#ARG_FILES[@]} -gt 0 ]]; then
  printf '%s\n' ${ARG_FILES[@]+"${ARG_FILES[@]}"} >>"$RAW_LIST"
fi

# Only the three languages the symbol side can parse, only files that still
# exist (a deleted file has no new side and nothing left to import), sorted and
# deduped so two callers passing the same path do not pack it twice.
FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  case "$f" in
    *.ts|*.tsx|*.sh) ;;
    *) continue ;;
  esac
  [[ -f "$REPO/$f" ]] || continue
  FILES+=("$f")
done < <(grep -v '^[[:space:]]*$' "$RAW_LIST" 2>/dev/null | sort -u || true)

if [[ ${#FILES[@]} -eq 0 ]]; then
  exit 0
fi

# ── The diff, split per file ──────────────────────────────────────────
#
# Two facts per file: which NEW-side lines the diff added (so the parser can say
# which symbol encloses them), and the text of every line it removed (so a
# deleted export is still found on the old side). A `+`/`-` line that is blank
# or is nothing but a comment is neither — "boundary inputs"'s comment-only
# case, and the reason a typo fix in a docblock does not drag a symbol's whole
# caller list into the prompt.

DIFF_TEXT=""
if [[ -n "$DIFF_FILE" ]]; then
  if [[ "$DIFF_FILE" == "-" ]]; then
    DIFF_TEXT="$(cat)"
  else
    DIFF_TEXT="$(cat "$DIFF_FILE")"
  fi
fi

PARSED_DIR="$TMP/diff"
mkdir -p "$PARSED_DIR"

if [[ -n "$DIFF_TEXT" ]]; then
  printf '%s\n' "$DIFF_TEXT" | awk -v outdir="$PARSED_DIR" '
    function flushfile() { path = ""; newline = 0 }
    # Content that is only whitespace, or only a line comment, is not a change
    # to a symbol. `*` and `*/` cover the continuation lines of a TS block
    # comment; `#` covers shell and the `#!` line.
    function trivial(s) {
      sub(/^[[:space:]]+/, "", s)
      sub(/[[:space:]]+$/, "", s)
      if (s == "") return 1
      if (s ~ /^\/\//) return 1
      if (s ~ /^\/\*/) return 1
      if (s ~ /^\*/) return 1
      if (s ~ /^#/) return 1
      return 0
    }
    function slugify(p,  s) { s = p; gsub(/[^A-Za-z0-9._-]/, "_", s); return s }
    /^diff --git / { flushfile(); next }
    /^--- / { next }
    /^\+\+\+ / {
      path = substr($0, 5)
      sub(/^b\//, "", path)
      if (path == "/dev/null") { path = "" ; next }
      slug = slugify(path)
      print path > (outdir "/" slug ".name")
      close(outdir "/" slug ".name")
      next
    }
    /^@@ / {
      if (path == "") next
      # @@ -oldStart,oldCount +newStart,newCount @@
      split($0, parts, " ")
      plus = parts[3]
      sub(/^\+/, "", plus)
      split(plus, np, ",")
      newline = np[1] + 0
      next
    }
    {
      if (path == "") next
      c = substr($0, 1, 1)
      body = substr($0, 2)
      if (c == "+") {
        if (!trivial(body)) print newline >> (outdir "/" slug ".newlines")
        newline++
      } else if (c == "-") {
        if (!trivial(body)) print body >> (outdir "/" slug ".removed")
      } else if (c == " " || c == "") {
        newline++
      }
    }
  '
fi

slug_for() {
  printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/_/g'
}

# ── Ask the parser which symbols moved ────────────────────────────────

REQUEST="$TMP/request"
: >"$REQUEST"
BYTES_DIR="$TMP/bytes"
mkdir -p "$BYTES_DIR"

idx=0
for f in ${FILES[@]+"${FILES[@]}"}; do
  idx=$((idx + 1))
  slug="$(slug_for "$f")"
  lang="ts"
  [[ "$f" == *.sh ]] && lang="sh"

  {
    printf 'FILE %s\n' "$f"
    printf 'LANG %s\n' "$lang"
    printf 'NEWFILE %s\n' "$REPO/$f"
    if [[ -z "$DIFF_TEXT" ]]; then
      printf 'NEWLINES all\n'
    elif [[ -s "$PARSED_DIR/$slug.newlines" ]]; then
      printf 'NEWLINES %s\n' "$(sort -n -u "$PARSED_DIR/$slug.newlines" | paste -sd, -)"
    else
      printf 'NEWLINES\n'
    fi
    # The old side is fetched ONLY when the diff removed something from this
    # file — `git show` on every file would cost one process per file to learn
    # nothing in the common add-only case.
    if [[ -s "$PARSED_DIR/$slug.removed" ]]; then
      if git show "${OLD_REF}:${f}" >"$BYTES_DIR/old.$idx" 2>/dev/null; then
        printf 'OLDFILE %s\n' "$BYTES_DIR/old.$idx"
        printf 'REMOVEDFILE %s\n' "$PARSED_DIR/$slug.removed"
      fi
    fi
    printf '\n'
  } >>"$REQUEST"
done

SYMBOLS_OUT="$TMP/symbols"
: >"$SYMBOLS_OUT"
if [[ -f "$SYMBOLS_TS" ]]; then
  # A parser crash must not take the review with it: the import graph below is
  # computed entirely in this script and still ships.
  if ! BLAST_RADIUS_REPO_ROOT="$REPO" node "$SYMBOLS_TS" <"$REQUEST" >"$SYMBOLS_OUT" 2>"$TMP/symbols.err"; then
    err "blast-radius: the symbol parser failed; packing the import graph only"
    [[ -s "$TMP/symbols.err" ]] && sed 's/^/  /' "$TMP/symbols.err" >&2
    : >"$SYMBOLS_OUT"
  fi
else
  err "blast-radius: $SYMBOLS_TS is missing; packing the import graph only"
fi

while IFS= read -r line; do
  case "$line" in
    "WARN "*) err "blast-radius: ${line#WARN }" ;;
  esac
done <"$SYMBOLS_OUT"

symbols_for() {
  local f="$1"
  awk -v want="$f" '
    $1 == "SYMBOL" && $2 == want { print $3 }
  ' "$SYMBOLS_OUT"
}

# ── The import graph ──────────────────────────────────────────────────

# Drop a CODE extension, and only a code extension, from a path's last
# component. `${p%.*}` cannot do this job: `./a` has its only dot in the `./`
# prefix, so the parameter expansion returns the empty string and the importer
# comparison below silently matched nothing — `src/caller.ts` was invisible to
# the first version of this script. Directories with dots in their names
# (`v1.2/`) fail the same way.
drop_code_ext() {
  local p="$1" dir base
  dir="$(dirname "$p")"
  base="$(basename "$p")"
  case "$base" in
    *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.sh|*.bash) base="${base%.*}" ;;
  esac
  if [[ "$dir" == "." ]]; then printf '%s\n' "$base"; else printf '%s/%s\n' "$dir" "$base"; fi
}

# Collapse `.` and `..` in a repo-relative path, in bash alone: GNU `realpath
# -m` is not on macOS, and the target need not exist on disk — a `.js`
# specifier naming a `.ts` source never does. Fails when the path climbs out of
# the repo.
normalize_rel() {
  local p="$1" part out=""
  while [[ -n "$p" ]]; do
    case "$p" in */*) part="${p%%/*}"; p="${p#*/}" ;; *) part="$p"; p="" ;; esac
    case "$part" in
      ''|.) ;;
      ..) [[ -n "$out" ]] || return 1
          case "$out" in */*) out="${out%/*}" ;; *) out="" ;; esac ;;
      *) out="${out:+$out/}$part" ;;
    esac
  done
  printf '%s\n' "$out"
}

# Normalize a specifier against the importing file's directory. Prints a
# repo-relative path with any code extension dropped, or nothing when the
# specifier escapes the repo or is absolute.
resolve_spec() {
  local from_file="$1" spec="$2" joined resolved
  case "$spec" in
    ./*|../*) joined="$(dirname "$from_file")/$spec" ;;
    /*) return 0 ;;
    *) joined="$spec" ;;
  esac
  resolved="$(normalize_rel "$joined")" || return 0
  [[ -n "$resolved" ]] || return 0
  drop_code_ext "$resolved"
}

# Every TS/JS import specifier a file states, one per line.
ts_specifiers() {
  grep -oE "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"][^'\"]+['\"]" "$REPO/$1" 2>/dev/null |
    grep -oE "['\"][^'\"]+['\"]" |
    tr -d "\"'" || true
}

# Every `.`/`source` target a shell script states.
sh_specifiers() {
  grep -oE "^[[:space:]]*(\.|source)[[:space:]]+[^[:space:]#]+" "$REPO/$1" 2>/dev/null |
    sed -E 's/^[[:space:]]*(\.|source)[[:space:]]+//' || true
}

# `git grep` exits 1 for "no match", a real answer; 2 and up is an error. The
# packer fails open by design, so an error does not stop it — but a pack built
# on a search that failed says so, or "no callers found" would read as a fact.
grep_failed() { # grep_failed <exit> <what was being searched for>
  err "blast-radius: git grep failed (exit $1) looking for $2 — the pack may be missing entries"
}

# Files that import $1. TypeScript is resolved; shell is basename-tailed.
importers_of() {
  local target="$1" base target_noext hitfile spec spec_base
  base="$(basename "$(drop_code_ext "$target")")"
  target_noext="$(drop_code_ext "$target")"

  local hits rc=0
  if [[ "$target" == *.sh ]]; then
    hits=$(git grep -l --untracked -E -e "(^|[[:space:];&|])(\.|source)[[:space:]]+[^[:space:]]*/?${base}\.sh" \
      -- . ${RECORD_EXCLUDES[@]+"${RECORD_EXCLUDES[@]}"} 2>/dev/null) || rc=$?
    [[ "$rc" -le 1 ]] || grep_failed "$rc" "the scripts sourcing $target"
    printf '%s\n' "$hits" | grep -vxF "$target" | grep -v '^$' || true
    return 0
  fi

  hits=$(git grep -l --untracked -E -e "['\"][^'\"]*${base}(\.(js|jsx|ts|tsx|mjs|cjs))?['\"]" \
    -- . ${RECORD_EXCLUDES[@]+"${RECORD_EXCLUDES[@]}"} 2>/dev/null) || rc=$?
  [[ "$rc" -le 1 ]] || grep_failed "$rc" "the files importing $target"

  # Candidates first (one grep), then resolution per candidate (no grep).
  while IFS= read -r hitfile; do
    [[ -n "$hitfile" ]] || continue
    [[ "$hitfile" == "$target" ]] && continue
    case "$hitfile" in
      *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts) ;;
      *) continue ;;
    esac
    while IFS= read -r spec; do
      [[ -n "$spec" ]] || continue
      spec_base="$(basename "$(drop_code_ext "$spec")")"
      [[ "$spec_base" == "$base" ]] || continue
      if [[ "$(resolve_spec "$hitfile" "$spec")" == "$target_noext" ]]; then
        printf '%s\n' "$hitfile"
        break
      fi
    done < <(ts_specifiers "$hitfile")
  done <<<"$hits"
}

# Repo files $1 imports, minus the ones this change already shows the reviewer.
imports_of() {
  local f="$1" spec resolved cand
  local -a exts
  if [[ "$f" == *.sh ]]; then
    while IFS= read -r spec; do
      [[ -n "$spec" ]] || continue
      case "$spec" in *'$'*) continue ;; esac
      resolved="$(resolve_spec "$f" "$spec")"
      [[ -n "$resolved" ]] || continue
      [[ -f "$REPO/${resolved}.sh" ]] && printf '%s\n' "${resolved}.sh"
    done < <(sh_specifiers "$f")
    return 0
  fi
  exts=(.ts .tsx .mts .cts .js .jsx .mjs .cjs /index.ts /index.tsx)
  while IFS= read -r spec; do
    [[ -n "$spec" ]] || continue
    resolved="$(resolve_spec "$f" "$spec")"
    [[ -n "$resolved" ]] || continue
    for e in ${exts[@]+"${exts[@]}"}; do
      cand="${resolved}${e}"
      if [[ -f "$REPO/$cand" ]]; then
        printf '%s\n' "$cand"
        break
      fi
    done
  done < <(ts_specifiers "$f")
}

callers_of() {
  local symbol="$1" defining="$2"
  # A word match as a fixed string: `\b` is not in every git's regex build
  # (macOS), and a `$` in a JavaScript identifier stays literal.
  local out rc=0
  out=$(git grep -n --untracked -w -F -e "${symbol}" -- . ${RECORD_EXCLUDES[@]+"${RECORD_EXCLUDES[@]}"} 2>/dev/null) || rc=$?
  [[ "$rc" -le 1 ]] || grep_failed "$rc" "the callers of $symbol"
  printf '%s\n' "$out" | awk -F: -v skip="$defining" 'NF && $1 != skip { print $1 ":" $2 }' || true
}

# ── Emit ──────────────────────────────────────────────────────────────

CHANGED_SET="$TMP/changed-set"
printf '%s\n' ${FILES[@]+"${FILES[@]}"} | sort -u >"$CHANGED_SET"

BODY="$TMP/body"
: >"$BODY"

symbol_budget="$MAX_SYMBOLS"
truncated_symbols=0
truncated_callers=0

for f in ${FILES[@]+"${FILES[@]}"}; do
  section="$TMP/section"
  : >"$section"

  # bash 3.2 has no mapfile.
  imported_by=(); while IFS= read -r _l; do imported_by+=("$_l"); done < <(importers_of "$f" | sort -u)
  if [[ ${#imported_by[@]} -gt 0 ]]; then
    printf '  imported-by:\n' >>"$section"
    printf '    %s\n' ${imported_by[@]+"${imported_by[@]}"} >>"$section"
  fi

  imports=(); while IFS= read -r _l; do imports+=("$_l"); done < <(imports_of "$f" | sort -u | grep -vxF -f "$CHANGED_SET" || true)
  if [[ ${#imports[@]} -gt 0 ]]; then
    printf '  imports (not in this change):\n' >>"$section"
    printf '    %s\n' ${imports[@]+"${imports[@]}"} >>"$section"
  fi

  syms=(); while IFS= read -r _l; do syms+=("$_l"); done < <(symbols_for "$f" | sort -u)
  sym_lines=""
  for s in ${syms[@]+"${syms[@]}"}; do
    [[ -n "$s" ]] || continue
    if [[ "$symbol_budget" -le 0 ]]; then
      truncated_symbols=$((truncated_symbols + 1))
      continue
    fi
    symbol_budget=$((symbol_budget - 1))
    calls=(); while IFS= read -r _l; do calls+=("$_l"); done < <(callers_of "$s" "$f" | sort -u)
    if [[ ${#calls[@]} -eq 0 ]]; then
      sym_lines="${sym_lines}    ${s} — no callers found"$'\n'
      continue
    fi
    if [[ ${#calls[@]} -gt "$MAX_CALLERS" ]]; then
      truncated_callers=$((truncated_callers + ${#calls[@]} - MAX_CALLERS))
      calls=("${calls[@]:0:$MAX_CALLERS}")
    fi
    sym_lines="${sym_lines}    ${s} — callers:"$'\n'
    for c in ${calls[@]+"${calls[@]}"}; do
      sym_lines="${sym_lines}      ${c}"$'\n'
    done
  done
  if [[ -n "$sym_lines" ]]; then
    printf '  changed symbols:\n' >>"$section"
    printf '%s' "$sym_lines" >>"$section"
  fi

  # A file with nothing on any of the three axes contributes nothing — an
  # unchanged-looking heading per file is noise in a prompt that pays by byte.
  if [[ -s "$section" ]]; then
    printf '%s\n' "$f" >>"$BODY"
    cat "$section" >>"$BODY"
  fi
done

if [[ ! -s "$BODY" ]]; then
  exit 0
fi

HEADER="BLAST RADIUS (computed from the working tree at review time)
Who calls the symbols this diff changed, and how these files connect. Context
for the review, not findings: nothing here is by itself a defect."

FULL="$TMP/full"
{
  printf '%s\n\n' "$HEADER"
  cat "$BODY"
  [[ "$truncated_symbols" -gt 0 ]] && printf 'truncated-symbols: %s\n' "$truncated_symbols"
  [[ "$truncated_callers" -gt 0 ]] && printf 'truncated-callers: %s\n' "$truncated_callers"
} >"$FULL"

full_bytes=$(wc -c <"$FULL")
if [[ "$full_bytes" -gt "$MAX_BYTES" ]]; then
  # Cut to the budget, then drop the partial last line so the pack never ends
  # mid-path — a half-written `apps/foo/ba` reads as a real file that is not
  # there.
  head -c "$MAX_BYTES" "$FULL" | sed '$d'
  printf 'truncated-bytes: %s\n' "$((full_bytes - MAX_BYTES))"
else
  cat "$FULL"
fi

exit 0
