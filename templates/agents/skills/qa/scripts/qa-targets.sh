#!/usr/bin/env bash
# qa-targets.sh — which web apps does this change put pixels in front of?
#
# `/implement` has to decide whether a UI was touched BEFORE it can require a
# full `/qa` pass, and "is this a UI change?" was a judgment the model made from
# the file paths. This makes it a lookup: walk up from each changed file to the
# nearest directory that owns a package.json, ask detect-app.sh what that
# directory IS, and keep the ones it calls web. Nothing here guesses, and
# nothing here reads a hand-maintained list of app names.
#
# Usage:
#   qa-targets.sh --repo <worktree> [--base <sha>] [--files-file PATH|-] [FILE...]
#
# Flags:
#   --repo <dir>       the worktree the changed files are relative to (required)
#   --base <sha>       the session's base commit. Without it the changed set is
#                      `git diff --name-only HEAD` plus untracked, which misses
#                      everything the session already COMMITTED — and
#                      /implement-audit reviews BASE_SHA..HEAD plus uncommitted,
#                      so a committed UI change is in the review and invisible
#                      here. That answered "skipped-not-web" for a change that
#                      was all pixels.
#   --files-file PATH  newline-separated repo-relative paths; `-` reads stdin.
#
# Output (stdout): zero or more ABSOLUTE directory paths, one per line, sorted
# LC_ALL=C and deduped. Absolute because /qa takes a target directory, not a
# repo-relative path.
#
# Exit:
#   0  the list is complete (zero paths is a complete list)
#   2  caller error, OR the detector crashed / is missing
#
# A DETECTOR CRASH IS A HALT, NOT "NOT WEB". detect-app.sh exits 3 for a target
# it cannot classify, and that 3 legitimately means "not a web app". Any OTHER
# non-zero is the detector failing, and reading a failure as "no UI here" is how
# a UI ships with no QA and a green run — the one outcome this script exists to
# make impossible. So 3 is data and everything else is exit 2.
#
# WEB, is whatever detect-app.sh's TYPE says:
# astro-cf, astro, next, vite, static, node-server. cli / render / unknown are
# not targets — there are no pixels in a CLI's stdout, and a render target's
# PNGs are already its own deliverable.
#
# SHARED PACKAGES FAN OUT. A file in `packages/ui/` is not itself a web app, so
# the walk-up finds nothing and the naive answer is "no UI changed" — while two
# apps that import it just changed what they render. So for any changed file
# that resolved to no web target of its own, this finds the files that IMPORT
# it and walks up from THOSE. That is the same import matching
# blast-radius.sh documents, and it is why one edit to a shared component still
# sends both consumers through /qa.
#
# peers:
#   .agents/skills/qa/scripts/detect-app.sh
#   .agents/skills/qa/scripts/tests/qa-targets.test.sh
#   .agents/skills/implement/scripts/validate.sh
#   .agents/skills/review/blast-radius.sh
#
# Boundary inputs:
#   - 0 changed files:            no output, exit 0
#   - 1 file, not in any app:     no output, exit 0
#   - N files in one app:         that app once
#   - nested apps/<domain>/<app>: the APP dir, not the domain dir
#   - the worktree root is web:   the root is a target
#   - shared package, 2 consumers: both consumers
#   - deleted file:               skipped (its directory may be gone too)
#   - detect-app.sh missing:      exit 2
#   - detect-app.sh exit 2 / >3:  exit 2

set -euo pipefail

export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECT="${QA_DETECT_APP:-$SCRIPT_DIR/detect-app.sh}"

err() { echo "$@" >&2; }

REPO=""
BASE=""
FILES_FILE=""
ARG_FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:-}"; [[ $# -gt 1 ]] || { err "qa-targets: --repo needs a directory"; exit 2; }; shift 2 ;;
    --base) BASE="${2:-}"; [[ $# -gt 1 ]] || { err "qa-targets: --base needs a revision"; exit 2; }; shift 2 ;;
    --files-file) FILES_FILE="${2:-}"; [[ $# -gt 1 ]] || { err "qa-targets: --files-file needs a path"; exit 2; }; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" >&2; exit 0 ;;
    --*) err "qa-targets: unknown flag: $1"; exit 2 ;;
    *) ARG_FILES+=("$1"); shift ;;
  esac
done

if [[ -z "$REPO" || ! -d "$REPO" ]]; then
  err "qa-targets: --repo must name a directory (got '${REPO}')"
  exit 2
fi
REPO="$(cd "$REPO" && pwd)"

if [[ ! -f "$DETECT" ]]; then
  err "qa-targets: no detector at $DETECT — cannot tell a web app from a CLI."
  err "This is a HALT, not 'no UI changed': a missing detector must never read"
  err "as a clean skip of /qa."
  exit 2
fi

cd "$REPO"

# ── The changed-file list ─────────────────────────────────────────────

RAW="$(mktemp -t qa-targets-XXXXXX)"
# Two lookup tables kept as files, one entry per line: macOS bash 3.2 has no
# associative arrays. A file also survives the `$(...)` subshells every lookup
# below runs in, where an in-memory table would be thrown away.
TYPE_CACHE="$(mktemp -t qa-targets-types-XXXXXX)"
VISITED="$(mktemp -t qa-targets-visited-XXXXXX)"
# shellcheck disable=SC2329  # invoked indirectly by the trap
cleanup() { rm -f "$RAW" "$TYPE_CACHE" "$VISITED" "$GIT_ERR" "$IMPORTERS" "$GREP_HITS"; }
trap cleanup EXIT
GIT_ERR="$(mktemp -t qa-targets-giterr-XXXXXX)"
IMPORTERS="$(mktemp -t qa-targets-importers-XXXXXX)"
GREP_HITS="$(mktemp -t qa-targets-grep-XXXXXX)"

# git_read <what> <command...> — run a git read, and HALT (exit 2) when it
# fails. A git read that fails prints nothing, and an empty changed set or an
# empty importer list reads exactly like "no web app changed" — the one answer
# this script must never give by accident. So a failure is never swallowed.
git_read() {
  local what="$1"
  shift
  if ! "$@" 2>"$GIT_ERR"; then
    err "qa-targets: $what failed — refusing to report 'no UI changed' on a git error:"
    sed 's/^/  /' "$GIT_ERR" >&2
    exit 2
  fi
}

if [[ -n "$FILES_FILE" ]]; then
  if [[ "$FILES_FILE" == "-" ]]; then
    cat >"$RAW"
  elif [[ -f "$FILES_FILE" ]]; then
    cat "$FILES_FILE" >"$RAW"
  else
    err "qa-targets: --files-file not found: $FILES_FILE"
    exit 2
  fi
elif [[ ${#ARG_FILES[@]} -eq 0 ]]; then
  # Exactly the population code-review.sh reviews: the committed range when a
  # base is given, the working-tree edits, and the untracked files git diff
  # cannot see.
  {
    if [[ -n "$BASE" ]]; then
      if ! git diff --name-only "$BASE" 2>/dev/null; then
        err "qa-targets: --base '$BASE' does not resolve in this worktree."
        err "Refusing to enumerate from a partial changed set — a UI change that"
        err "is already committed would silently read as 'no UI changed'."
        exit 2
      fi
    else
      # `rev-parse --verify -q HEAD` exits 1 for "no commit yet" and 128 for a
      # git error. Only the first is an unborn repo; reading the second as one
      # would scan the staged set alone and miss an unstaged UI edit.
      head_rc=0
      git rev-parse --verify -q HEAD >/dev/null 2>"$GIT_ERR" || head_rc=$?
      case "$head_rc" in
        0) git_read "git diff --name-only HEAD" git diff --name-only HEAD ;;
        1)
          # Unborn: prove the repository itself reads, then take the staged set
          # (against the empty tree) and the unstaged edits on top of it; the
          # untracked files follow below.
          git_read "git rev-parse --git-dir" git rev-parse --git-dir >/dev/null
          git_read "git diff --cached --name-only" git diff --cached --name-only
          git_read "git diff --name-only" git diff --name-only
          ;;
        *)
          err "qa-targets: git rev-parse --verify HEAD failed (exit $head_rc) — refusing to report 'no UI changed' on a git error:"
          sed 's/^/  /' "$GIT_ERR" >&2
          exit 2
          ;;
      esac
    fi
    git_read "git ls-files --others" git ls-files --others --exclude-standard
  } >"$RAW"
else
  : >"$RAW"
fi
if [[ ${#ARG_FILES[@]} -gt 0 ]]; then
  printf '%s\n' ${ARG_FILES[@]+"${ARG_FILES[@]}"} >>"$RAW"
fi

# A DELETED path is kept. Removing a page, a component or a stylesheet changes
# what the app renders as surely as editing one does, and the walk-up only needs
# the file's DIRECTORY chain — which normally survives the deletion. Dropping
# them meant a deletion-only UI change enumerated zero targets and skipped /qa
# entirely. `web_target_for` walks up from the path either way and simply finds
# nothing when the whole tree is gone.
CHANGED=()
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  CHANGED+=("$f")
done < <(grep -v '^[[:space:]]*$' "$RAW" 2>/dev/null | sort -u || true)

if [[ ${#CHANGED[@]} -eq 0 ]]; then
  exit 0
fi

# ── Classification ────────────────────────────────────────────────────

# cache_get <dir> / cache_put <dir> <verdict> — TYPE_CACHE, one "dir<TAB>verdict" per line.
cache_get() { awk -F'\t' -v d="$1" '$1 == d { print $2; exit }' "$TYPE_CACHE"; }
cache_put() { printf '%s\t%s\n' "$1" "$2" >>"$TYPE_CACHE"; }

# is_web <abs-dir> — 0 yes, 1 no. Exits the SCRIPT with 2 on a detector failure,
# which is the point: there is no third answer a caller could safely ignore.
is_web() {
  local dir="$1" out rc=0 type cached
  cached="$(cache_get "$dir")"
  if [[ -n "$cached" ]]; then
    [[ "$cached" == "web" ]] && return 0 || return 1
  fi
  out="$(bash "$DETECT" "$dir" 2>/dev/null)" || rc=$?
  if [[ "$rc" -eq 3 ]]; then
    cache_put "$dir" "not-web"
    return 1
  fi
  if [[ "$rc" -ne 0 ]]; then
    err "qa-targets: the detector failed on $dir (exit $rc)."
    err "Refusing to report 'no UI changed' on a detector failure — re-run"
    err "detect-app.sh on that directory and fix it before /implement closes."
    exit 2
  fi
  type="$(sed -n 's/^TYPE=//p' <<<"$out" | head -1)"
  case "$type" in
    astro-cf|astro|next|vite|static|node-server) cache_put "$dir" "web"; return 0 ;;
    *) cache_put "$dir" "not-web"; return 1 ;;
  esac
}

# web_target_for <repo-rel-file> — the nearest ancestor directory that owns a
# package.json AND is web; prints an absolute path, or nothing.
#
# Walking to the nearest package.json (rather than to apps/<first-segment>) is
# what makes apps/<domain>/<app>/ resolve to the APP: the domain folder holds
# shared config at most, and no manifest of its own.
web_target_for() {
  local file="$1" dir
  dir="$(dirname "$file")"
  while :; do
    if [[ "$dir" == "." ]]; then
      if [[ -f "$REPO/package.json" ]] && is_web "$REPO"; then printf '%s\n' "$REPO"; fi
      return 0
    fi
    if [[ -f "$REPO/$dir/package.json" ]] && is_web "$REPO/$dir"; then
      printf '%s\n' "$REPO/$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
}

TARGETS=()
ORPHANS=()
for f in ${CHANGED[@]+"${CHANGED[@]}"}; do
  t="$(web_target_for "$f")"
  if [[ -n "$t" ]]; then
    TARGETS+=("$t")
  else
    ORPHANS+=("$f")
  fi
done

# ── Shared-package fan-out ────────────────────────────────────────────
#
# Only for files that reached no web target of their own, and only for the
# languages an import graph exists in. A changed README in packages/ has no
# importers and produces nothing, which is correct.

drop_code_ext() {
  local p="$1" dir base
  dir="$(dirname "$p")"
  base="$(basename "$p")"
  case "$base" in
    *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs) base="${base%.*}" ;;
  esac
  if [[ "$dir" == "." ]]; then printf '%s\n' "$base"; else printf '%s/%s\n' "$dir" "$base"; fi
}

# norm_rel <repo-relative path> — collapse `.`, `..` and empty segments, as
# `realpath -m --relative-to` would (GNU-only; BSD realpath has neither flag).
# A path that climbs out of the repo keeps its leading `..`.
norm_rel() {
  local part n
  local -a parts out
  out=()
  IFS=/ read -r -a parts <<<"$1"
  for part in ${parts[@]+"${parts[@]}"}; do
    case "$part" in
      ""|.) ;;
      ..)
        n=${#out[@]}
        if [[ $n -gt 0 && "${out[$((n - 1))]}" != ".." ]]; then
          unset "out[$((n - 1))]"
          out=(${out[@]+"${out[@]}"})
        else
          out+=("..")
        fi
        ;;
      *) out+=("$part") ;;
    esac
  done
  [[ ${#out[@]} -gt 0 ]] || return 0
  (IFS=/; printf '%s\n' "${out[*]}")
}

resolve_spec() {
  local from_file="$1" spec="$2" joined resolved
  case "$spec" in
    ./*|../*) joined="$(dirname "$from_file")/$spec" ;;
    /*) return 0 ;;
    *) joined="$spec" ;;
  esac
  resolved="$(norm_rel "$joined")"
  [[ -n "$resolved" ]] || return 0
  case "$resolved" in ../*) return 0 ;; esac
  drop_code_ext "$resolved"
}

# importers_of <file> — print the repo files that import <file>. Runs in the
# CALLER's shell (its output goes to a file, never through `< <(...)`), so the
# exit 2 on a failed git grep stops the script instead of dying in a subshell.
importers_of() {
  local target="$1" base target_noext hitfile spec spec_base grep_rc=0
  target_noext="$(drop_code_ext "$target")"
  base="$(basename "$target_noext")"
  # git grep exits 1 for "no match" — an answer — and above 1 for a failure.
  git grep -l --untracked -E -e "['\"][^'\"]*${base}(\.(js|jsx|ts|tsx|mjs|cjs))?['\"]" \
    -- . >"$GREP_HITS" 2>"$GIT_ERR" || grep_rc=$?
  if [[ $grep_rc -gt 1 ]]; then
    err "qa-targets: git grep failed (exit $grep_rc) looking for importers of $target —"
    err "refusing to report 'no UI changed' on a git error:"
    sed 's/^/  /' "$GIT_ERR" >&2
    exit 2
  fi
  while IFS= read -r hitfile; do
    [[ -n "$hitfile" ]] || continue
    [[ "$hitfile" == "$target" ]] && continue
    case "$hitfile" in
      *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts|*.astro|*.svelte|*.vue) ;;
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
    done < <(grep -oE "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"][^'\"]+['\"]" "$REPO/$hitfile" 2>/dev/null |
      grep -oE "['\"][^'\"]+['\"]" | tr -d "\"'" || true)
  done <"$GREP_HITS"
}

# ── The fan-out walk ──────────────────────────────────────────────────
#
# BFS, not one hop. `button.ts` is usually not imported by the app directly —
# it goes through `packages/ui/index.ts`, and a single-hop walk stops at that
# barrel, finds it is not web, and reports no target.
#
# NO DEPTH CAP, and that is the correction rather than the omission. The first
# version stopped after six hops, which meant a seven-hop graph returned success
# with unexplored importers still queued — a silent "no UI changed" for a change
# that had one, which is the single outcome this script exists to prevent. A cap
# can only ever turn a slow answer into a wrong one.
#
# Termination does not need it. VISITED admits each file at most once and the
# repo is finite, so every iteration either shrinks the frontier or consumes a
# file that can never be queued again; a circular import graph terminates for
# the same reason. The bound is the number of source files, which is also the
# bound on how wrong the answer could be without it.
frontier=()
for f in ${ORPHANS[@]+"${ORPHANS[@]}"}; do
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts|*.css|*.astro|*.svelte|*.vue) ;;
    *) continue ;;
  esac
  frontier+=("$f")
  printf '%s\n' "$f" >>"$VISITED"
done

while [[ ${#frontier[@]} -gt 0 ]]; do
  next=()
  for f in ${frontier[@]+"${frontier[@]}"}; do
    importers_of "$f" >"$IMPORTERS"
    while IFS= read -r importer; do
      [[ -n "$importer" ]] || continue
      grep -qxF -- "$importer" "$VISITED" && continue
      printf '%s\n' "$importer" >>"$VISITED"
      t="$(web_target_for "$importer")"
      if [[ -n "$t" ]]; then
        TARGETS+=("$t")
      else
        # Not in a web app itself — a barrel, or another shared module. Keep
        # walking through it.
        next+=("$importer")
      fi
    done <"$IMPORTERS"
  done
  frontier=(${next[@]+"${next[@]}"})
done

[[ ${#TARGETS[@]} -eq 0 ]] && exit 0
printf '%s\n' ${TARGETS[@]+"${TARGETS[@]}"} | sort -u
