#!/usr/bin/env bash
# detect-stage.sh — say which stage a project is in, from its files and
# frontmatter. Deterministic, no AI judgment: /project routes on the answer.
#
# Stages:
#   needs-planning     → status active, and no spec at all — or, with
#                        ROADMAP.md, no rows yet, or a ready row whose spec
#                        folder is `—`, missing on disk, or holds an open
#                        NEEDS CLARIFICATION marker
#   ready-to-implement → status active, and a spec is still owed work
#   ready-to-close     → status active, and a ready row's spec is reported
#                        complete but the row is not yet `done` — a close that
#                        did not finish; /close flips the row and syncs next:
#   all-specs-reported → status active, specs exist, none is owed work
#   monitor | blocked | completed → the frontmatter status, which wins
#   unknown            → no README, an unrecognised status, or a malformed
#                        ROADMAP.md (then `roadmap-error:` says why)
#
# "No spec owed work" is two situations. Zero specs means nothing was ever
# planned, so the think flow is right. Every spec reported means the project may
# be finished or may want a next chunk, and the file counts cannot tell which, so
# it is its own stage and the caller asks rather than starting a think flow that
# invents scope.
#
# WITH ROADMAP.md (status active only) the rows decide, read through
# close/scripts/roadmap.sh — the one parser — and the Ready rule written in
# project/references/templates/README.md:
#   1. a loose `*.spec.md` (the older layout) still owed work wins: it is
#      already in flight
#   2. a table with no rows → needs-planning
#   3. a ready row whose spec is reported complete → ready-to-close, ahead of
#      new work, because the row it flips may be what unblocks the next
#   4. the first ready row (in-progress before planned, table order) whose spec
#      is owed work and carries no open marker → ready-to-implement
#   5. else a ready row with Sub-spec `—`, a spec missing on disk, or open
#      markers → needs-planning
#   6. else → all-specs-reported
# A malformed ROADMAP.md is `stage: unknown` plus `roadmap-error:`, never a
# fall-back to the file counts, which could offer work from stale data.
#
# "Owed work" is close/scripts/spec-state.sh's answer (none or partial), never a
# filename guess here.
#
# Usage:
#   detect-stage.sh <project-path>
#
# Output (stdout):
#   stage: <stage>
#   status: <frontmatter status | missing-readme | unknown>
#   specs: <count>        (loose *.spec.md + specs/*/spec.md)
#   reports: <count>      (loose *-report.md + specs/*/report.md)
#   active-spec: <path or empty>
#   next-row: <ID or empty>       (only when ROADMAP.md exists)
#   roadmap-error: <message>      (only when ROADMAP.md is malformed)
#
# Exit: 0 always — the caller parses stdout.
#
# peers:
#   .agents/skills/project/scripts/detect-stage.test.sh
#   .agents/skills/close/scripts/roadmap.sh
#   .agents/skills/close/scripts/spec-state.sh
#   .agents/skills/close/scripts/open-clarifications.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# CONTEXTIUM_CLOSE_SCRIPTS points the three helpers elsewhere; tests use it.
CLOSE_SCRIPTS="${CONTEXTIUM_CLOSE_SCRIPTS:-$SCRIPT_DIR/../../close/scripts}"

PROJECT_PATH="${1:?project path required}"
PROJECT_PATH="${PROJECT_PATH%/}"
README="$PROJECT_PATH/README.md"

if [ ! -f "$README" ]; then
  printf 'stage: unknown\nstatus: missing-readme\nspecs: 0\nreports: 0\nactive-spec:\n'
  exit 0
fi

# Frontmatter only: a body line starting `status:` is prose, not the field.
STATUS=$(awk 'NR==1 && $0=="---" {fm=1; next} fm && $0=="---" {exit} fm && /^status:/ {print $2; exit}' "$README")
if [ -z "$STATUS" ]; then STATUS="unknown"; fi

count_lines() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | grep -c .; fi; }

SPEC_FILES=$(find "$PROJECT_PATH" -maxdepth 1 -name '*.spec.md' -type f 2>/dev/null | sort)
FOLDER_SPECS=$(find "$PROJECT_PATH" -mindepth 3 -maxdepth 3 -path '*/specs/*/spec.md' -type f 2>/dev/null | sort)
LOOSE_REPORTS=$(find "$PROJECT_PATH" -maxdepth 1 -name '*-report.md' -type f 2>/dev/null)
FOLDER_REPORTS=$(find "$PROJECT_PATH" -mindepth 3 -maxdepth 3 -path '*/specs/*/report.md' -type f 2>/dev/null)
SPEC_COUNT=$(( $(count_lines "$SPEC_FILES") + $(count_lines "$FOLDER_SPECS") ))
REPORT_COUNT=$(( $(count_lines "$LOOSE_REPORTS") + $(count_lines "$FOLDER_REPORTS") ))

# Which specs are owed work: spec-state.sh prints `<name> TAB <state> TAB <evidence>`,
# where <name> is a loose stem (`alpha`) or a folder (`specs/001-alpha`).
SPEC_STATES=""; PENDING=""
if [ "$SPEC_COUNT" -gt 0 ] && [ -f "$CLOSE_SCRIPTS/spec-state.sh" ]; then
  SPEC_STATES=$(bash "$CLOSE_SCRIPTS/spec-state.sh" "$PROJECT_PATH" 2>/dev/null || true)
  PENDING=$(printf '%s\n' "$SPEC_STATES" | awk -F'\t' '$2=="none" || $2=="partial" {print $1}')
fi
spec_state_of() { printf '%s\n' "$SPEC_STATES" | awk -F'\t' -v n="$1" '$1==n {print $2; exit}'; }
is_pending() { printf '%s\n' "$PENDING" | grep -qxF "$1"; }

# The loose spec owed work — the last in name order.
ACTIVE_SPEC=""
while IFS= read -r spec_path; do
  [ -z "$spec_path" ] && continue
  stem=$(basename "$spec_path" .spec.md)
  if [ -f "$CLOSE_SCRIPTS/spec-state.sh" ]; then
    if is_pending "$stem"; then ACTIVE_SPEC="$spec_path"; fi
  elif [ ! -f "$PROJECT_PATH/$stem-report.md" ]; then
    # Helper missing (a partial install): the filename rule, rather than
    # claiming every spec is done.
    ACTIVE_SPEC="$spec_path"
  fi
done <<EOF
$SPEC_FILES
EOF

# A folder spec owed work, when no active roadmap orders them.
if [ -z "$ACTIVE_SPEC" ] && [ -n "$PENDING" ] &&
  { [ ! -f "$PROJECT_PATH/ROADMAP.md" ] || [ "$STATUS" != "active" ]; }; then
  while IFS= read -r spec_path; do
    [ -z "$spec_path" ] && continue
    if is_pending "specs/$(basename "$(dirname "$spec_path")")"; then ACTIVE_SPEC="$spec_path"; fi
  done <<EOF
$FOLDER_SPECS
EOF
fi

# ── ROADMAP.md: the rows decide ──────────────────────────────────────────
HAS_ROADMAP=0; NEXT_ROW=""; ROADMAP_ERR=""; ROADMAP_STAGE=""
if [ -f "$PROJECT_PATH/ROADMAP.md" ]; then HAS_ROADMAP=1; fi
if [ "$HAS_ROADMAP" -eq 1 ] && [ "$STATUS" = "active" ]; then
  ERR_FILE=$(mktemp "${TMPDIR:-/tmp}/detect-stage.XXXXXX")
  RC=0
  ROWS=$(bash "$CLOSE_SCRIPTS/roadmap.sh" "$PROJECT_PATH" 2>"$ERR_FILE") || RC=$?
  if [ "$RC" -ne 0 ]; then
    ROADMAP_ERR=$(sed -n 's/^roadmap: //p' "$ERR_FILE" | tail -n 1)
    [ -z "$ROADMAP_ERR" ] && ROADMAP_ERR="roadmap.sh exited $RC"
    ROADMAP_STAGE="unknown"
  elif [ -n "$ACTIVE_SPEC" ]; then
    # 1. A loose spec in flight: name the row that points at it, if any.
    cat "$ERR_FILE" >&2
    stem=$(basename "$ACTIVE_SPEC" .spec.md)
    NEXT_ROW=$(printf '%s\n' "$ROWS" | awk -F'\t' -v n="$stem" '$4==n {print $1; exit}')
    ROADMAP_STAGE="ready-to-implement"
  elif [ -z "$ROWS" ]; then
    # 2. A table with no rows: nothing has been planned yet.
    cat "$ERR_FILE" >&2
    ROADMAP_STAGE="needs-planning"
  else
    cat "$ERR_FILE" >&2
    plan_row=""; close_row=""
    READY=$(printf '%s\n' "$ROWS" | awk -F'\t' '$3=="yes" && tolower($2)=="in-progress"'
            printf '%s\n' "$ROWS" | awk -F'\t' '$3=="yes" && tolower($2)=="planned"')
    while IFS="$(printf '\t')" read -r id _status _ready sub _feature; do
      if [ -z "$id" ]; then continue; fi
      if [ "$sub" = "—" ]; then
        if [ -z "$plan_row" ]; then plan_row="$id"; fi
        continue
      fi
      case "$(spec_state_of "$sub")" in
        none|partial) ;;
        complete)
          # 3. Reported complete, row not yet done: the close did not finish.
          if [ -z "$close_row" ]; then close_row="$id"; fi
          continue ;;
        *)
          # 5. The row names a spec that is not on disk: nothing to build.
          if [ -z "$plan_row" ]; then plan_row="$id"; fi
          continue ;;
      esac
      if [ -n "$ROADMAP_STAGE" ]; then continue; fi   # an implementable row is already chosen
      case "$sub" in
        specs/*)
          if ! bash "$CLOSE_SCRIPTS/open-clarifications.sh" "$PROJECT_PATH/$sub" >/dev/null 2>&1; then
            if [ -z "$plan_row" ]; then plan_row="$id"; fi
            continue
          fi
          ACTIVE_SPEC="$PROJECT_PATH/$sub/spec.md" ;;
        *)
          ACTIVE_SPEC="$PROJECT_PATH/$sub.spec.md" ;;
      esac
      NEXT_ROW="$id"; ROADMAP_STAGE="ready-to-implement"
    done <<EOF
$READY
EOF
    if [ -n "$close_row" ]; then
      NEXT_ROW="$close_row"; ROADMAP_STAGE="ready-to-close"; ACTIVE_SPEC=""
    elif [ -z "$ROADMAP_STAGE" ]; then
      if [ -n "$plan_row" ]; then NEXT_ROW="$plan_row"; ROADMAP_STAGE="needs-planning"
      else ROADMAP_STAGE="all-specs-reported"; fi
    fi
  fi
  rm -f "$ERR_FILE"
fi

case "$STATUS" in
  monitor|blocked|completed) STAGE="$STATUS" ;;
  active)
    if [ -n "$ROADMAP_STAGE" ]; then STAGE="$ROADMAP_STAGE"
    elif [ -n "$ACTIVE_SPEC" ]; then STAGE="ready-to-implement"
    elif [ "$SPEC_COUNT" -eq 0 ]; then STAGE="needs-planning"
    else STAGE="all-specs-reported"
    fi ;;
  *) STAGE="unknown" ;;
esac

echo "stage: $STAGE"
echo "status: $STATUS"
echo "specs: $SPEC_COUNT"
echo "reports: $REPORT_COUNT"
echo "active-spec: $ACTIVE_SPEC"
if [ "$HAS_ROADMAP" -eq 1 ]; then
  echo "next-row: $NEXT_ROW"
  if [ -n "$ROADMAP_ERR" ]; then echo "roadmap-error: $ROADMAP_ERR"; fi
fi
exit 0
