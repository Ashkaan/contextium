#!/usr/bin/env bash
# detect-stage.sh
#
# Detect the stage of an existing project from filesystem + frontmatter.
# Deterministic — no AI judgment. Routes /project to the right next action.
#
# Stages:
#   needs-planning     → status:active + no *.spec.md or *.plan.md (legacy) at all
#                        — or, with ROADMAP.md, no rows yet, or a ready row whose
#                        Sub-spec is `—`, missing on disk, or carries an open
#                        NEEDS CLARIFICATION marker
#   all-specs-reported → status:active + at least one SPEC + every one of them reported
#   ready-to-implement → status:active + *.spec.md (or legacy *.plan.md) exists + no matching *-report.md
#   ready-to-close     → status:active + ROADMAP.md, and a ready row's spec is
#                        reported complete while the row is not yet `done` — a
#                        close that did not finish; /close flips the row
#   monitor            → status:monitor
#   blocked            → status:blocked
#   completed          → status:completed
#
# Recognizes both *.spec.md (new) AND *.plan.md
# (legacy back-compat). Multiple SPECs/plans: pick the most-recent that has no
# sibling *-report.md as the active SPEC.
#
# "no unreported SPEC" is TWO different situations and this script used to
# collapse them into one. A project with zero SPECs has never been planned, so
# the think flow is right. A project whose every SPEC is reported may be about
# to start its next chunk OR may simply be finished, and nothing in the file
# counts tells them apart — the remaining item can be a watch window rather than
# a build. Returning needs-planning for that second case points /project at a
# think flow that invents scope for a project that may be done. It is its own
# stage, and the caller reads the remaining-work counts before deciding.
#
# A PROJECT WITH ROADMAP.md (the spec-kit layout) is staged from
# its rows, read through close/scripts/roadmap.sh — the one parser — and the
# README template's Ready rule (project/references/templates/README.md), in this
# order, status active only:
#   1. a legacy loose SPEC still owed work wins: that work is already in flight
#   2. a table with no rows → needs-planning: nothing has been planned yet
#   3. a ready row whose spec is reported complete → ready-to-close, ahead of new
#      work, because the row the close flips may be what unblocks the next one
#   4. the first ready row (in-progress before planned, table order) whose spec
#      is none/partial and carries no open NEEDS CLARIFICATION → ready-to-implement
#   5. else a ready row with Sub-spec `—`, a spec missing on disk, or open
#      clarifications → needs-planning
#   6. else → all-specs-reported
# A malformed ROADMAP.md is `stage: unknown` plus `roadmap-error:`, never a
# fallback to the legacy signals, which could offer work from stale data.
#
# The status is read from the README's frontmatter only: a body line that
# starts `status:` is prose, not the field.
#
# The script runs under `set -euo pipefail`; every helper that may exit non-zero
# is called where that exit is handled (`|| true`, `|| RM_RC=$?`, an `if`), so a
# failing helper is reported in the output, never a run that dies before
# `stage:` is printed.
#
# CONTEXTIUM_CLOSE_SCRIPTS points the three close/ helpers (roadmap.sh,
# spec-state.sh, open-clarifications.sh) at another copy; the tests use it.
#
# Usage:
#   detect-stage.sh <project-path>
#
# Output (multi-line to stdout):
#   stage: <stage-name>
#   status: <frontmatter status>
#   specs: <count>      (spec.md + plan.md + specs/*/spec.md)
#   reports: <count>    (*-report.md + specs/*/report.md)
#   active-spec: <path or empty>
#   next-row: <ID or empty>       (ROADMAP.md projects only)
#   roadmap-error: <message>      (only when ROADMAP.md is malformed)
#   spec-state-error: <message>   (only when spec-state.sh crashed; stage unknown)
#
# Exit code: 0 always.
#
# peers:
#   .agents/skills/project/scripts/detect-stage.test.sh
#   .agents/skills/close/scripts/roadmap.sh
#   .agents/skills/close/scripts/spec-state.sh
#   .agents/skills/close/scripts/open-clarifications.sh

set -euo pipefail

# THE WRITE ROOT. This script reads projects and journals with repo-relative
# paths, so it runs FROM the root the session resolves — the thread's worktree,
# else the checkout it lives in — never from whichever cwd invoked it, because a
# wrong cwd here reports "no projects" rather than failing.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRITE_ROOT="$(bash "$SCRIPT_DIR/../../implement/scripts/session-write-root.sh")" || exit 1
cd "$WRITE_ROOT" || exit 1
CLOSE_SCRIPTS="${CONTEXTIUM_CLOSE_SCRIPTS:-$SCRIPT_DIR/../../close/scripts}"

PROJECT_PATH="${1:?project path required}"
PROJECT_PATH="${PROJECT_PATH%/}"
README="${PROJECT_PATH}/README.md"

if [ ! -f "$README" ]; then
  echo "stage: unknown"
  echo "status: missing-readme"
  echo "specs: 0"
  echo "reports: 0"
  echo "active-spec:"
  exit 0
fi

# Frontmatter only: a body line starting `status:` is prose, not the field.
STATUS=$(awk 'NR==1 && $0=="---" {fm=1; next} fm && $0=="---" {exit} fm && /^status:/ {print $2; exit}' "$README")
if [ -z "$STATUS" ]; then STATUS="unknown"; fi

# Recognize both *.spec.md (new) and *.plan.md (legacy back-compat)
SPEC_FILES=$(find "$PROJECT_PATH" -maxdepth 1 \( -name "*.spec.md" -o -name "*.plan.md" \) -type f 2>/dev/null | sort)
REPORT_FILES=$(find "$PROJECT_PATH" -maxdepth 1 -name "*-report.md" -type f 2>/dev/null | sort)

SPEC_COUNT=$(echo -n "$SPEC_FILES" | grep -c '^' 2>/dev/null || true)
REPORT_COUNT=$(echo -n "$REPORT_FILES" | grep -c '^' 2>/dev/null || true)
[ -z "$SPEC_COUNT" ] && SPEC_COUNT=0
[ -z "$REPORT_COUNT" ] && REPORT_COUNT=0
# spec-kit folders, `specs/NNN-name/{spec,report}.md`, count alongside.
FOLDER_SPECS=$(find "$PROJECT_PATH" -mindepth 3 -maxdepth 3 -path '*/specs/*/spec.md' -type f 2>/dev/null | sort)
FOLDER_SPEC_COUNT=$(echo -n "$FOLDER_SPECS" | grep -c '^' 2>/dev/null || true)
FOLDER_REPORT_COUNT=$(find "$PROJECT_PATH" -mindepth 3 -maxdepth 3 -path '*/specs/*/report.md' -type f 2>/dev/null | grep -c '^' || true)
SPEC_COUNT=$((SPEC_COUNT + ${FOLDER_SPEC_COUNT:-0}))
REPORT_COUNT=$((REPORT_COUNT + ${FOLDER_REPORT_COUNT:-0}))

# Find the active SPEC — the most-recent one still owed work.
# `spec-state.sh` owns what "still owed" means for every reader; it is not a
# filename question. A SPEC reported under a name describing the slice it covered
# (`phase-2-sync-freshness-report.md`), or reported without anyone claiming it
# finished, is still active work and used to read here as done.
SPEC_STATE_SH="$CLOSE_SCRIPTS/spec-state.sh"
ACTIVE_SPEC=""
SPEC_STATE_ERR=""
if [ "$SPEC_COUNT" -gt 0 ] && [ -f "$SPEC_STATE_SH" ]; then
  # A helper that CRASHES is not a helper that found nothing owed: read as
  # silence, every spec would look missing or finished and the router would
  # send an already specified row back to planning. It is recorded, and the
  # stage becomes `unknown` below.
  _ss_rc=0
  SPEC_STATES=$(bash "$SPEC_STATE_SH" "$PROJECT_PATH" 2>/dev/null) || _ss_rc=$?
  if [ "$_ss_rc" -ne 0 ]; then SPEC_STATE_ERR="spec-state.sh exited $_ss_rc"; fi
  PENDING=$(printf '%s\n' "$SPEC_STATES" | awk -F'\t' '$2=="none" || $2=="partial" {print $1}')
  while IFS= read -r spec_path; do
    [ -z "$spec_path" ] && continue
    spec_stem=$(basename "$spec_path" | sed -E 's/\.(spec|plan)\.md$//')
    if printf '%s\n' "$PENDING" | grep -qxF "$spec_stem"; then
      ACTIVE_SPEC="$spec_path"
    fi
  done <<< "$SPEC_FILES"
elif [ "$SPEC_COUNT" -gt 0 ]; then
  # Helper missing (a partial install) — fall back to the old filename rule
  # rather than claiming every SPEC is done.
  while IFS= read -r spec_path; do
    [ -z "$spec_path" ] && continue
    spec_stem=$(basename "$spec_path" | sed -E 's/\.(spec|plan)\.md$//')
    [ -f "${PROJECT_PATH}/${spec_stem}-report.md" ] || ACTIVE_SPEC="$spec_path"
  done <<< "$SPEC_FILES"
fi

# A folder spec still owed work, on a project with no ROADMAP.md to order it —
# or one whose ROADMAP.md orders nothing because the project is not active (the
# rows below are read for active projects only). Without the second case a
# finished project lost its active-spec the moment its specs moved into folders.
if [[ -z "$ACTIVE_SPEC" && -n "${PENDING:-}" ]] &&
  [[ ! -f "$PROJECT_PATH/ROADMAP.md" || "$STATUS" != "active" ]]; then
  while IFS= read -r spec_path; do
    [ -z "$spec_path" ] && continue
    name="specs/$(basename "$(dirname "$spec_path")")"
    printf '%s\n' "$PENDING" | grep -qxF "$name" && ACTIVE_SPEC="$spec_path"
  done <<< "$FOLDER_SPECS"
fi

# ── ROADMAP.md: the rows decide ──────────────────────────────────────────
HAS_ROADMAP=0; NEXT_ROW=""; ROADMAP_ERR=""; ROADMAP_STAGE=""
spec_state_of() { printf '%s\n' "${SPEC_STATES:-}" | awk -F'\t' -v n="$1" '$1==n {print $2; exit}'; }
if [ -f "$PROJECT_PATH/ROADMAP.md" ] && [ "$STATUS" = "active" ]; then
  HAS_ROADMAP=1
  RM_ERR_FILE=$(mktemp "${TMPDIR:-/tmp}/detect-stage.XXXXXX")
  RM_RC=0
  ROWS=$(bash "$CLOSE_SCRIPTS/roadmap.sh" "$PROJECT_PATH" 2>"$RM_ERR_FILE") || RM_RC=$?
  if [ "$RM_RC" -ne 0 ]; then
    ROADMAP_ERR=$(sed -n 's/^roadmap: //p' "$RM_ERR_FILE" | tail -n 1)
    [ -z "$ROADMAP_ERR" ] && ROADMAP_ERR="roadmap.sh exited $RM_RC"
    ROADMAP_STAGE="unknown"
  else
    cat "$RM_ERR_FILE" >&2
    if [ -n "$ACTIVE_SPEC" ]; then
      # 1. Legacy loose SPEC in flight: name the row that points at it, if any.
      stem=$(basename "$ACTIVE_SPEC" | sed -E 's/\.(spec|plan)\.md$//')
      NEXT_ROW=$(printf '%s\n' "$ROWS" | awk -F'\t' -v n="$stem" '$4==n {print $1; exit}')
      ROADMAP_STAGE="ready-to-implement"
    elif [ -z "$ROWS" ]; then
      # 2. A table with no rows: nothing has been planned yet.
      ROADMAP_STAGE="needs-planning"
    else
      plan_row=""; close_row=""
      # Ready rows, in-progress first then planned, each in table order.
      READY=$(printf '%s\n' "$ROWS" | awk -F'\t' '$3=="yes" && tolower($2)=="in-progress"'
              printf '%s\n' "$ROWS" | awk -F'\t' '$3=="yes" && tolower($2)=="planned"')
      while IFS=$'\t' read -r id _st _ready sub _feat; do
        [ -z "$id" ] && continue
        if [ "$sub" = "—" ]; then
          [ -z "$plan_row" ] && plan_row="$id"; continue
        fi
        st=$(spec_state_of "$sub")
        case "$st" in
          none|partial) ;;
          complete)
            # 3. Reported complete, row not yet done: the close did not finish.
            [ -z "$close_row" ] && close_row="$id"; continue ;;
          *)
            # 5. The row names a spec that is not on disk: nothing to build.
            [ -z "$plan_row" ] && plan_row="$id"; continue ;;
        esac
        # An implementable row is already chosen; keep reading only for a
        # complete row awaiting its close, which outranks it.
        [ -n "$ROADMAP_STAGE" ] && continue
        case "$sub" in
          specs/*)
            if ! bash "$CLOSE_SCRIPTS/open-clarifications.sh" "$PROJECT_PATH/$sub" >/dev/null 2>&1; then
              [ -z "$plan_row" ] && plan_row="$id"; continue
            fi
            ACTIVE_SPEC="$PROJECT_PATH/$sub/spec.md" ;;
          *)
            ACTIVE_SPEC=$(printf '%s\n' "$SPEC_FILES" | awk -v n="$sub" '{b=$0; sub(/.*\//,"",b); sub(/\.(spec|plan)\.md$/,"",b)} b==n {print; exit}') ;;
        esac
        NEXT_ROW="$id"; ROADMAP_STAGE="ready-to-implement"
      done <<< "$READY"
      if [ -n "$close_row" ]; then
        NEXT_ROW="$close_row"; ROADMAP_STAGE="ready-to-close"; ACTIVE_SPEC=""
      elif [ -z "$ROADMAP_STAGE" ]; then
        if [ -n "$plan_row" ]; then NEXT_ROW="$plan_row"; ROADMAP_STAGE="needs-planning"
        else ROADMAP_STAGE="all-specs-reported"; fi
      fi
    fi
  fi
  rm -f "$RM_ERR_FILE"
elif [ -f "$PROJECT_PATH/ROADMAP.md" ]; then
  HAS_ROADMAP=1
fi

# Stage from status first (monitor / blocked / completed override filesystem state)
case "$STATUS" in
  monitor)
    STAGE="monitor"
    ;;
  blocked)
    STAGE="blocked"
    ;;
  completed)
    STAGE="completed"
    ;;
  active)
    if [ -n "$SPEC_STATE_ERR" ]; then
      STAGE="unknown"
    elif [ -n "$ROADMAP_STAGE" ]; then
      STAGE="$ROADMAP_STAGE"
    elif [ -z "$ACTIVE_SPEC" ] && [ "$SPEC_COUNT" -eq 0 ]; then
      # Never planned — no SPEC has ever been written here.
      STAGE="needs-planning"
    elif [ -z "$ACTIVE_SPEC" ]; then
      # Every SPEC written here has a report. Could be the next chunk, could be
      # a finished project; the file counts cannot tell. Caller decides.
      STAGE="all-specs-reported"
    elif [ "$REPORT_COUNT" -gt 0 ]; then
      # SPECs + reports exist; some SPEC still has no report → ready-to-implement
      # OR the latest report hasn't been closed yet → ready-to-close.
      # Heuristic: if today's journal mentions the slug + "close", call it ready-to-close.
      # Simpler: if there's at least one *-report.md, surface as ready-to-close-or-implement
      # and let the caller decide. For now: prefer ready-to-implement if active SPEC exists.
      STAGE="ready-to-implement"
    else
      STAGE="ready-to-implement"
    fi
    ;;
  *)
    STAGE="unknown"
    ;;
esac

echo "stage: $STAGE"
echo "status: $STATUS"
echo "specs: $SPEC_COUNT"
echo "reports: $REPORT_COUNT"
echo "active-spec: $ACTIVE_SPEC"
if [ -n "$SPEC_STATE_ERR" ]; then echo "spec-state-error: $SPEC_STATE_ERR"; fi
if [ "$HAS_ROADMAP" -eq 1 ]; then
  echo "next-row: $NEXT_ROW"
  [ -n "$ROADMAP_ERR" ] && echo "roadmap-error: $ROADMAP_ERR"
fi
exit 0
