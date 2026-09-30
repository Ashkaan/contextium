#!/usr/bin/env bash
# setup-worktree.sh — own /implement Phase 0.5 worktree creation.
#
# Converts what was prose told to the agent into a deterministic mechanism: the
# worktree an /implement session builds in, named after the work, refused
# before anything is created when the roadmap row cannot start, and recorded in
# this thread's ledger so the close lands it.
#
# Four invocation modes:
#   setup-worktree.sh <slug>                          — create-or-reclaim worktree (mode 1)
#   setup-worktree.sh --slug <slug> --shard <row>     — a named roadmap row (mode 1b)
#                                                       composite=<slug>-<row>; emits
#                                                       SLUG=, SHARD=, WORKTREE_DIR=
#                                                       <row> is a ROADMAP.md row ID
#                                                       (`r4`; the flag keeps its old
#                                                       name); see resolve_roadmap_row
#   setup-worktree.sh --validate-slug s               — validate slug, exit 0/2 (mode 2)
#   setup-worktree.sh --print-regex                   — emit SLUG_REGEX value (mode 3)
#
# peers:
#   .agents/skills/implement/scripts/setup-worktree.test.ts
#   .agents/skills/implement/SKILL.md
#   .agents/skills/close/scripts/harness.sh     (where it goes, its branch name)
#   .agents/skills/close/scripts/write-root.sh  (records it for the close)
#
# Env (mode 1 + 1b only):
#   CLAUDE_PROJECT_DIR  — repo root. Optional; falls back to
#                         `git rev-parse --show-toplevel` when unset (Fix B —
#                         some callers leave it unset).
#   CLAUDE_SESSION_ID   — the session id, used as the marker-file suffix.
#                         Optional: else the harness's own (harness.sh), else
#                         the id thread.ts generates for this checkout.
#   CLAUDE_WORKTREE_HOME — the folder the worktree goes under. Optional; else
#                         where the recorded harness keeps its worktrees.
#
# Output (mode 1, stdout):
#   WORKTREE_DIR=<absolute path>      (single line, on success)
# Output (mode 1b, stdout, three lines on success):
#   SLUG=<slug>
#   SHARD=<shard>
#   WORKTREE_DIR=<absolute path of <worktree home>/<slug>-<shard>>
# Output (mode 2, stdout): none
# Output (mode 3, stdout): SLUG_REGEX value

set -euo pipefail

# SSOT: every caller (this script, session-key.test.ts, the skill body) routes
# through --validate-slug; the regex MUST NOT be duplicated elsewhere.
readonly SLUG_REGEX='^[a-z][a-z0-9-]{0,63}$'

err() { echo "$@" >&2; }

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOSE_SCRIPTS="$SELF_DIR/../../close/scripts"
if [[ -f "$CLOSE_SCRIPTS/harness.sh" ]]; then
  # shellcheck disable=SC1091  # a sibling skill's file, resolved at run time
  source "$CLOSE_SCRIPTS/harness.sh"
else
  # A copy outside the skills tree (a test fixture): no harness recorded.
  harness_session_id() { printf '%s' "${CONTEXTIUM_SESSION:-${CLAUDE_CODE_SESSION_ID:-}}"; }
  harness_worktree_root() { printf '%s/%s.worktrees\n' "$(dirname "$1")" "$(basename "$1")"; }
  harness_worktree_branch() { printf 'session/%s\n' "$1"; }
fi

validate_slug() {
  local slug="$1"
  if [[ -z "$slug" ]]; then
    err "slug empty (regex: $SLUG_REGEX)"
    return 2
  fi
  if [[ ! "$slug" =~ $SLUG_REGEX ]]; then
    err "slug fails regex $SLUG_REGEX: $slug"
    return 2
  fi
  return 0
}

# ── Mode dispatch ──
shard=""
case "${1:-}" in
  --print-regex)
    printf '%s\n' "$SLUG_REGEX"
    exit 0
    ;;
  --validate-slug)
    validate_slug "${2:-}"
    exit $?
    ;;
  --slug)
    # Mode 1b: --slug <slug> --shard <shard>
    [[ "${2:-}" == "" || "${3:-}" != "--shard" || "${4:-}" == "" ]] && {
      err "usage: setup-worktree.sh --slug <slug> --shard <shard>"
      exit 1
    }
    raw_slug="$2"
    shard="$4"
    validate_slug "$raw_slug" || exit $?
    validate_slug "$shard" || exit $?
    composite="${raw_slug}-${shard}"
    validate_slug "$composite" || {
      err "composite slug '${composite}' overflows SLUG_REGEX (max 64 chars). Shorten either --slug or --shard."
      exit 2
    }
    # Set $slug to the composite; the rest of the script uses it.
    slug="$composite"
    original_slug="$raw_slug"
    ;;
  "")
    err "usage: setup-worktree.sh <slug> | --slug <s> --shard <s> | --validate-slug <s> | --print-regex"
    exit 1
    ;;
  *)
    # Mode 1: positional slug
    slug="$1"
    original_slug="$slug"
    validate_slug "$slug" || exit $?
    ;;
esac

# Fix B: CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall
# back to git when unset (every /implement runs inside the repo by definition).
repo="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$repo" ]] || {
  err "CLAUDE_PROJECT_DIR unset and not inside a git repo"
  exit 1
}
if [[ ! -d "$repo/.git" ]] && ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  err "repo root is not a git repo: $repo"
  exit 1
fi

# The session id names the marker. A session whose harness exports none still
# has one: thread.ts generates it once for this checkout and keeps it until a
# close lands, so every later call — and the close — agrees on it.
SESSION_ID="${CLAUDE_SESSION_ID:-$(harness_session_id)}"
if [[ -z "$SESSION_ID" && -f "$CLOSE_SCRIPTS/thread.ts" ]]; then
  SESSION_ID="$(cd "$repo" && node --experimental-strip-types "$CLOSE_SCRIPTS/thread.ts" --id 2>/dev/null || true)"
fi
[[ -n "$SESSION_ID" ]] || {
  err "no session id: set CLAUDE_SESSION_ID, or run inside a harness session"
  exit 1
}

branch="$(harness_worktree_branch "$slug" "$repo")"

# This is the ONLY place the location is decided, and harness.sh decides it:
# the worktree goes where the recorded harness keeps its own, so that
# harness's worktree tools see it. Every reader discovers worktrees through
# `git worktree list` or the ledger instead of rebuilding this path.
# CLAUDE_WORKTREE_HOME overrides the whole root — the test suite sets it so a
# temp-repo test cannot write into a real worktree folder.
worktree_home="${CLAUDE_WORKTREE_HOME:-$(harness_worktree_root "$repo")}"
worktree_dir="$worktree_home/$slug"
mkdir -p "$worktree_home" || {
  err "cannot create worktree home: $worktree_home"
  exit 1
}

# The marker filename uses the SANITIZED session key, not the raw id. Every
# lookup of this file passes the name to `find -name` or a path test, so a raw
# id carrying a glob metacharacter would widen that pattern and match another
# session's worktree. One sanitizer, shared, is the only way the writer and the
# readers stay in agreement (single source of truth). Identity for a normal
# UUID id, so worktrees already on disk keep resolving. It is TypeScript, run
# by node and never sourced — this resolver stays bash only because it runs
# `git worktree add`.
session_key_script="$(dirname "$0")/session-key.ts"
if [[ -f "$session_key_script" ]]; then
  session_key=$(node --experimental-strip-types "$session_key_script" "$SESSION_ID") || {
    err "session id \"$SESSION_ID\" yields no usable marker key"
    exit 1
  }
else
  err "missing session-key.ts at $session_key_script"
  exit 1
fi
marker="$worktree_dir/.claude-session-$session_key"

# Resolve fork point: origin/HEAD if available, else local HEAD (with advisory).
fork_point="origin/HEAD"
if ! git -C "$repo" rev-parse --verify "$fork_point" >/dev/null 2>&1; then
  err "WARN: origin/HEAD unresolvable, forking from HEAD"
  fork_point="HEAD"
fi

# Both paths are worktrees (or the main checkout) of one repository: the same
# git common dir, compared physically.
same_git_dir() {
  local a b
  a="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  b="$(git -C "$2" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  [[ -d "$a" && -d "$b" && "$(cd "$a" && pwd -P)" == "$(cd "$b" && pwd -P)" ]]
}

worktree_exists() {
  [[ -d "$worktree_dir" ]]
}

branch_exists() {
  git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"
}

# Helper: run `git worktree add` with one prune-and-retry on stale refs.
try_worktree_add() {
  local attempt_output
  if attempt_output=$(git -C "$repo" worktree add "$@" 2>&1); then
    return 0
  fi
  err "git worktree add failed (first attempt): $attempt_output"
  err "running git worktree prune and retrying once..."
  git -C "$repo" worktree prune
  if attempt_output=$(git -C "$repo" worktree add "$@" 2>&1); then
    return 0
  fi
  err "git worktree add failed after prune: $attempt_output"
  return 1
}

emit_output() {
  # Mode 1b emits SLUG + SHARD lines so the caller can pass both originals
  # downstream (composite alone is ambiguous when either part has hyphens).
  if [[ -n "$shard" ]]; then
    printf 'SLUG=%s\n' "$original_slug"
    printf 'SHARD=%s\n' "$shard"
  fi
  printf 'WORKTREE_DIR=%s\n' "$worktree_dir"
}

# The markers sit at the worktree's root, and the close commits a worktree with
# `git add -A` — so they are excluded through the repo's own info/exclude,
# which every worktree of it reads and nothing commits.
exclude_markers() {
  local ex
  ex="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/info/exclude" || return 0
  mkdir -p "$(dirname "$ex")" 2>/dev/null || return 0
  grep -qxF '.claude-session-*' "$ex" 2>/dev/null \
    || printf '%s\n' '.claude-session-*' >>"$ex" 2>/dev/null || true
}

# Record the worktree in this thread's ledger. `land.ts` walks only the ledger,
# so a worktree left out of it is one the close never commits — it would
# report success over code still sitting here. A refusal is fatal for that
# reason.
adopt_worktree() {
  local out
  if [[ ! -f "$CLOSE_SCRIPTS/write-root.sh" ]]; then
    err "WARN: no close scripts beside this skill; $worktree_dir is in no ledger and no close will land it"
    return 0
  fi
  out="$(bash "$CLOSE_SCRIPTS/write-root.sh" --adopt "$worktree_dir" 2>&1)" || {
    err "could not record $worktree_dir for the close: ${out#write-root: }"
    exit 1
  }
}

same_dir() { [[ -d "$1" && -d "$2" && "$(cd "$1" && pwd -P)" == "$(cd "$2" && pwd -P)" ]]; }

# The project folder for $original_slug — empty when there is none (a
# `session-<key>` slug, or a tree without projects).
#
# The projects are records in this repo, so they sit beside the code in every
# checkout. `--no-create` answers with the session's worktree once it exists
# (the flip is then written where the close commits it) and with the main
# checkout before that (the roadmap pre-flight only reads), and it honours the
# CONTEXT_WRITE_ROOT override the suite sets. NEVER the default mode: that mode
# can create the worktree by calling THIS script, so asking it from here would
# recurse without end.
find_project_dir() {
  local records
  records=$(node --experimental-strip-types "$SELF_DIR/session-write-root.ts" --no-create 2>/dev/null || true)
  [[ -n "$records" && -d "$records/projects" ]] || return 0
  # `|| true` on the pipeline, not just 2>/dev/null on find: under `set -o
  # pipefail` a find that exits non-zero (no such directory) fails the whole
  # command substitution and kills the script — which is how a missing projects
  # tree turned a best-effort status flip into a hard worktree-creation failure.
  { find "$records/projects" -maxdepth 3 -mindepth 3 -name README.md -type f 2>/dev/null \
    | while IFS= read -r r; do
        local d base
        d=$(dirname "$r")
        base=$(basename "$d")
        if [[ "$base" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_${original_slug}$ ]]; then
          printf '%s\n' "$d"
          break
        fi
      done | head -1; } || true
}

# ── ROADMAP.md row resolution ──────────────────────────────────────────────
#
# Runs BEFORE any worktree is created or claimed, because both refusals below
# must leave nothing behind: a worktree made for a row that cannot start is a
# directory and a branch somebody has to clean up.
#   --slug x --shard r4 → the row whose ID is `r4`, case-insensitively.
#   bare x              → the row detect-stage.ts names in `next-row:` when the
#                         stage is ready-to-implement; any other stage refuses.
#                         A legacy loose SPEC in flight wins, as it does there,
#                         and takes the old path with no row to flip.
# Then the row's spec folder must carry no open NEEDS CLARIFICATION marker.
# A project with no ROADMAP.md takes the old path untouched.
roadmap_project="" roadmap_row=""
resolve_roadmap_row() {
  local proj rows rc=0 errf msg row sub
  proj="$(find_project_dir)"
  [[ -n "$proj" && -f "$proj/ROADMAP.md" ]] || return 0
  errf="$(mktemp)"
  rows="$(node --experimental-strip-types "$CLOSE_SCRIPTS/roadmap.ts" "$proj" 2>"$errf")" || rc=$?
  msg="$(sed -n 's/^roadmap: //p' "$errf" | tail -n1)"; rm -f "$errf"
  if [[ "$rc" -ne 0 ]]; then
    err "BLOCKED: $proj/ROADMAP.md is malformed: ${msg:-roadmap.ts exited $rc}"
    exit 1
  fi
  if [[ -n "$shard" ]]; then
    row="$(printf '%s\n' "$rows" | awk -F'\t' -v w="$shard" 'tolower($1)==tolower(w) && !f {print; f=1}')"
    if [[ -z "$row" ]]; then
      err "BLOCKED: no row '$shard' in $proj/ROADMAP.md — rows: $(printf '%s\n' "$rows" | cut -f1 | paste -sd' ' - | sed 's/ /, /g')"
      exit 1
    fi
    # Naming a row is not a way past the rules that pick one: it must be ready
    # (planned or in-progress, every dependency done), have a spec, and that
    # spec must still be owed work. Otherwise a blocked or finished row would be
    # flipped back to in-progress with nothing runnable behind it.
    local rid rstatus rready rsub rstate pstatus
    IFS=$'\t' read -r rid rstatus rready rsub _ <<<"$row"
    pstatus="$(sed -nE 's/^status:[[:space:]]*([a-z]+).*/\1/p' "$proj/README.md" 2>/dev/null | head -n1)"
    if [[ "$pstatus" != active ]]; then
      err "BLOCKED: $original_slug is '${pstatus:-unknown}', not active — no row of it starts until /project $original_slug reopens it"
      exit 1
    fi
    if [[ "$rready" != yes ]]; then
      err "BLOCKED: $rid is '$rstatus' and not ready (a dependency is not done, or the row is blocked, done or absorbed)"
      exit 1
    fi
    if [[ "$rsub" == "—" ]]; then
      err "BLOCKED: $rid has no spec yet — run /project $original_slug"
      exit 1
    fi
    # awk reads to the end rather than `exit` on the match: spec-state.ts
    # writes a line per spec, and a reader that quits early kills it with
    # SIGPIPE — under `set -e` and pipefail that took this script down, silent,
    # exit 141, on any row whose spec was not the last one listed.
    rstate="$(node --experimental-strip-types "$CLOSE_SCRIPTS/spec-state.ts" "$proj" 2>/dev/null | awk -F'\t' -v n="$rsub" '$1==n && !f {print $2; f=1}')"
    case "$rstate" in
      none|partial) ;;
      complete) err "BLOCKED: $rid's spec is already reported complete — /close marks the row done"; exit 1 ;;
      *) err "BLOCKED: $rid's Sub-spec '$rsub' is not on disk — run /project $original_slug"; exit 1 ;;
    esac
  else
    local stage_out stage active next_row
    stage_out="$(node --experimental-strip-types "$SELF_DIR/../../project/scripts/detect-stage.ts" "$proj" 2>/dev/null || true)"
    stage="$(sed -n 's/^stage: //p' <<<"$stage_out")"
    active="$(sed -n 's/^active-spec: \{0,1\}//p' <<<"$stage_out")"
    next_row="$(sed -n 's/^next-row: \{0,1\}//p' <<<"$stage_out")"
    if [[ "$stage" != "ready-to-implement" ]]; then
      err "BLOCKED: $original_slug is at stage '${stage:-unknown}', not ready-to-implement — run /project $original_slug${next_row:+ (row $next_row)}"
      # When the row was sent to planning by its open markers, say which.
      sub="$(printf '%s\n' "$rows" | awk -F'\t' -v w="$next_row" '$1==w && !f {print $4; f=1}')"
      if [[ "$sub" == specs/* ]]; then
        node --experimental-strip-types "$CLOSE_SCRIPTS/open-clarifications.ts" "$proj/$sub" 2>/dev/null | sed 's/^/  /' >&2 || true
      fi
      exit 1
    fi
    case "$active" in
      */specs/*/spec.md) ;;
      *) return 0 ;;    # a legacy loose SPEC in flight: the old path
    esac
    row="$(printf '%s\n' "$rows" | awk -F'\t' -v w="$next_row" '$1==w && !f {print; f=1}')"
    [[ -n "$row" ]] || return 0
  fi
  sub="$(cut -f4 <<<"$row")"
  if [[ "$sub" == specs/* ]]; then
    local markers mrc=0
    markers="$(node --experimental-strip-types "$CLOSE_SCRIPTS/open-clarifications.ts" "$proj/$sub" 2>&1)" || mrc=$?
    if [[ "$mrc" -ne 0 ]]; then
      err "BLOCKED: $(cut -f1 <<<"$row") has open NEEDS CLARIFICATION markers in $proj/$sub — settle them with /project $original_slug first:"
      printf '%s\n' "$markers" | sed 's/^/  /' >&2
      exit 1
    fi
  fi
  roadmap_project="$proj"; roadmap_row="$(cut -f1 <<<"$row")"
}

# After the worktree exists: the row is in progress. Informational — `done` is
# set by /close from the report, never from this flip — so a failed write warns
# and the worktree stays.
#
# WRITTEN IN THE WORKTREE, not where the row was read. The row is resolved
# before the worktree exists, so outside a thread it is read from the main
# checkout; a flip written there too is a dirty file in the shared checkout that
# no close commits, and land.ts then will not fast-forward that checkout. When
# the project is a folder of this repo, the flip goes to the worktree's copy of
# it, which the close commits with the work.
flip_roadmap_row_to_in_progress() {
  [[ -n "$roadmap_row" ]] || return 0
  local target="$roadmap_project" root rel
  root="$(git -C "$roadmap_project" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$root" ]] \
     && [[ "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
           == "$(git -C "$worktree_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ]]; then
    # Both sides physical: git prints the toplevel with symlinks resolved.
    rel="$(cd "$roadmap_project" && pwd -P)"
    rel="${rel#"$(cd "$root" && pwd -P)"/}"
    [[ -f "$worktree_dir/$rel/ROADMAP.md" ]] && target="$worktree_dir/$rel"
  fi
  node --experimental-strip-types "$CLOSE_SCRIPTS/roadmap.ts" "$target" --set "$roadmap_row" in-progress >/dev/null 2>&1 \
    || err "WARN: could not mark $roadmap_row in-progress in $target/ROADMAP.md"
}

resolve_roadmap_row
exclude_markers

# ── One worktree per repo per thread ──────────────────────────────────────
# A session that already has a worktree of this repo — the one its harness
# started it in, or one an earlier call named — builds there. A second one
# beside it would split the session's work across two trees, and the close
# lands each separately.
owned=""
if [[ -f "$CLOSE_SCRIPTS/write-root.sh" ]]; then
  owned="$(bash "$CLOSE_SCRIPTS/write-root.sh" --existing "$repo" 2>/dev/null || true)"
fi
if [[ -n "$owned" ]] && ! same_dir "$owned" "$worktree_dir"; then
  worktree_dir="$owned"
  marker="$worktree_dir/.claude-session-$session_key"
  touch "$marker"
  adopt_worktree
  flip_roadmap_row_to_in_progress
  emit_output
  exit 0
fi

if worktree_exists; then
  # Worktree dir present — verify it is this repo's, its branch, then re-claim.
  #
  # Repository first: two checkouts sharing a folder name can share a worktree
  # root, so this slug's folder may be a worktree of the OTHER one — same
  # branch name, same session marker. Handing it back would send this repo's
  # edits into that repo. The shared git dir is the repo's identity.
  if ! same_git_dir "$worktree_dir" "$repo"; then
    err "worktree at $worktree_dir is not a worktree of $repo (it belongs to $(git -C "$worktree_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo 'no repository')); use another slug"
    exit 1
  fi
  current_branch=$(git -C "$worktree_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [[ "$current_branch" != "$branch" ]]; then
    err "worktree at $worktree_dir is on unexpected branch $current_branch; expected $branch"
    exit 1
  fi
  # Re-claim is for the SAME session (a resumed session calls this again). It is
  # NOT a second session
  # joining. Two sessions running `/implement <slug>` on the same slug would
  # otherwise each drop a marker in one worktree and edit one index — the exact
  # sharing this mechanism exists to end, just relocated from the main tree into
  # a worktree. Refuse, and say who holds it.
  foreign_markers=()
  while IFS= read -r existing; do
    [[ -n "$existing" ]] || continue
    [[ "$(basename "$existing")" == ".claude-session-$session_key" ]] && continue
    foreign_markers+=("$existing")
  done < <(find "$worktree_dir" -maxdepth 1 -name ".claude-session-*" -type f 2>/dev/null | sort)

  if (( ${#foreign_markers[@]} > 0 )); then
    err "BLOCKED: worktree $worktree_dir is already claimed by another session:"
    for m in ${foreign_markers[@]+"${foreign_markers[@]}"}; do
      err "  $(basename "$m")"
    done
    err ""
    err "Two sessions sharing one worktree share one git index, which is the"
    err "problem worktrees exist to solve. Options:"
    err "  - run /implement with a different slug, or"
    err "  - let the holding session /close first, or"
    err "  - if that session is gone, remove its marker and re-run:"
    err "      rm ${foreign_markers[0]}"
    exit 1
  fi
  touch "$marker"
  adopt_worktree
  flip_roadmap_row_to_in_progress
  emit_output
  exit 0
fi

# Worktree dir absent — branch handling depends on whether the branch exists.
mkdir -p "$(dirname "$worktree_dir")"

if branch_exists; then
  # Preserve existing branch tip (don't reset). No -b/-B.
  try_worktree_add "$worktree_dir" "$branch" || exit 1
else
  # Fresh branch — lowercase -b fails-loud if branch unexpectedly exists.
  try_worktree_add -b "$branch" "$worktree_dir" "$fork_point" || exit 1
fi

touch "$marker"
adopt_worktree
flip_roadmap_row_to_in_progress
emit_output
