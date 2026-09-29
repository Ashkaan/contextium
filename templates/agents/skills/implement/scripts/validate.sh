#!/usr/bin/env bash
# validate.sh — the fixed-order driver for /implement Phase 4.
#
# The order used to live in implement/SKILL.md as a table, and a table is a
# suggestion. The one it printed had the code review as "layer 4", BEFORE the
# E2E walk — so a review that came back clean landed on a session that had run
# no E2E, and audit-dedupe.sh then no-op'd the real review when it finally came.
# A model reading a table decides when to read it. A model calling a script
# does not decide anything: this script exposes PHASES, and no argument spells
# "review before lint".
#
# Usage:
#   validate.sh --phase checks --scope <arg>
#   validate.sh --phase review --base <sha> --head <sha> [--since <tree>] --scope <arg>
#   validate.sh --phase qa-list [--base <sha>]
#   validate.sh --phase qa-revalidate --since <tree> --scope <arg>
#   validate.sh --require-qa --targets-file <path> --tree <sha>
#   validate.sh --fallback-review <findings-file>
#
# Flags:
#   --phase <name>       checks | review | qa-list | qa-revalidate
#   --scope <arg>        passed through to resolve-scope.sh (blank = staged)
#   --base / --head      the full review's range (phase review, round 1).
#                        --base is ALSO read by qa-list, so a UI change that is
#                        already committed still enumerates.
#   --since <tree>       a tree from `code-review.sh --snapshot`; scopes the
#                        review to what changed since it (phase review rounds
#                        2+, and every qa-revalidate)
#   --targets-file PATH  the QA_TARGETS list (one absolute path per line)
#   --tree <sha>         the tree every target's QA marker must be keyed on
#   --repo <dir>         the worktree (default: CLAUDE_PROJECT_DIR, then git)
#
# Output (stdout): TAP-ish layer lines from the layer scripts, then the two
# machine fields the skill branches on, always both, always last:
#
#   NEED_FIX=0|1     the reviewer asked for changes
#   NEED_E2E=0|1     the tree moved since the phase started, so SPEC § 6 has to
#                    be walked again
#
# `--phase review` / `qa-revalidate` additionally print `NEED_FALLBACK_REVIEW=1`
# when no independent reviewer answered (code-review.sh exit 3), and exit 3:
# the review is PENDING, not passed. Run the implement-audit-reviewer agent in a
# fresh context on the same diff, save its triage lines to a file, and hand it
# to `--fallback-review <file>` — that call is the phase's pass (exit 0) or its
# findings (exit 1), recorded as `claude-fallback (fresh context, NOT
# independent)`: weaker than an independent review, never reported as one.
#
# `--phase qa-list` additionally prints one `QA_TARGETS=<abs path>` line per web
# target, and `QA_TARGETS=` with nothing after it when there are none. A path
# per line rather than one space-joined value, because a directory name may
# contain a space and a caller splitting on one would half-QA it.
#
# Exit:
#   0  the phase passed
#   1  a layer failed, the reviewer left [must-fix]/[should-fix] open, the
#      reviewer chain failed, or --require-qa found a target with no marker for
#      the given tree
#   2  caller error
#   3  the review is pending: no independent reviewer answered — run the
#      fallback reviewer, then --fallback-review <file>
#
# WHAT THIS SCRIPT DOES NOT DO. It never calls /qa, never calls impeccable, and
# never looks at a screenshot. Impeccable stays inside /qa on `@latest` against
# the live page, where its findings are 3x what they are against source —
# pulling it in here would pin a version behind a second caller and split one
# fact across two files.
# Looking at screenshots stays in the skill because it is judgment.
#
# E2E IS NOT A PHASE HERE, ON PURPOSE. Walking SPEC § 6 against a running app is
# human-attestable; a script that "ran E2E" would be a script that marked it
# green. What this script owns is WHEN it has to happen: always once after
# `--phase checks`, and again on every `NEED_E2E=1`.
#
# peers:
#   .agents/skills/implement/scripts/validate.test.sh
#   .agents/skills/implement/scripts/layer-1.sh
#   .agents/skills/implement/scripts/layer-2.sh
#   .agents/skills/implement/scripts/layer-3.sh
#   .agents/skills/implement/scripts/resolve-scope.sh
#   .agents/skills/implement-audit/scripts/run-automated-checks.sh
#   .agents/skills/qa/scripts/qa-targets.sh
#   .agents/skills/qa/scripts/mark-qa-done.sh
#   .agents/skills/review/code-review.sh
#
# Boundary inputs:
#   - empty scope:                 layers run over the staged set; 0 files is a PASS
#   - layer-1 FAIL:                exit 1, and review NEVER runs
#   - layer-3 FAIL:                advisory, does not fail the phase
#   - reviewer NO_FINDINGS:        NEED_FIX=0, exit 0
#   - reviewer [nit] only:         NEED_FIX=0 — a nit is not a change request
#   - reviewer [must-fix]:         NEED_FIX=1, exit 1
#   - reviewer exit 4 (converged): NEED_FIX=0, exit 0, with a note
#   - reviewer exit 5 (ceiling):   NEED_FIX=0, exit 0, with a note
#   - reviewer exit 1/3/124:       exit 1 — the audit did not happen
#   - tree unchanged over review:  NEED_E2E=0
#   - tree changed over review:    layers 1+2 re-run, NEED_E2E=1
#   - 0 QA targets:                `QA_TARGETS=`, --require-qa is a no-op
#   - target with no marker:       --require-qa exit 1
#   - target with a STALE marker:  --require-qa exit 1 (the tree moved)

set -euo pipefail

export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

err() { echo "$@" >&2; }

PHASE=""
SCOPE=""
BASE=""
HEAD_REF=""
SINCE=""
TARGETS_FILE=""
TREE=""
REQUIRE_QA=0
FALLBACK_FILE=""
REPO_DIR="${CLAUDE_PROJECT_DIR:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="${2:-}"; shift 2 ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    --head) HEAD_REF="${2:-}"; shift 2 ;;
    --since) SINCE="${2:-}"; shift 2 ;;
    --targets-file) TARGETS_FILE="${2:-}"; shift 2 ;;
    --tree) TREE="${2:-}"; shift 2 ;;
    --repo) REPO_DIR="${2:-}"; shift 2 ;;
    --require-qa) REQUIRE_QA=1; shift ;;
    --fallback-review) FALLBACK_FILE="${2:-}"; [[ -n "$FALLBACK_FILE" ]] || { err "validate: --fallback-review needs a findings file"; exit 2; }; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0" >&2; exit 0 ;;
    *) err "validate: unknown argument: $1"; exit 2 ;;
  esac
done

REPO_DIR="${REPO_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$REPO_DIR" && -e "$REPO_DIR/.git" ]] || {
  err "validate: --repo must be a git worktree (got '${REPO_DIR}')"
  exit 2
}
REPO_DIR="$(cd "$REPO_DIR" && pwd)"

# The reviewer is read from the repo under test first: the workbench carries it
# at .agents/skills/review/.
REVIEW_DIR="$REPO_DIR/.agents/skills/review"
# THE REVIEWER IS REPO-AGNOSTIC: it reviews the git diff of whatever worktree it
# runs in. So a repo that carries none — every product repo a web app `/qa`
# runs on lives in — borrows the workbench's: the review skill beside the
# skills this script sits among, or the one under `WORKBENCH_SHARED_DIR` when
# that is set (the test suite sets it). Without the borrow, `--phase
# qa-revalidate` on a product repo prints "no reviewer" and refuses, so the
# post-QA gate could never pass for any repo but the workbench. Each package's
# lint and typecheck stay repo-local on purpose (layer-1.sh runs the package's
# own scripts) — those are that repo's own rules.
REVIEW_DEFAULT="$REVIEW_DIR/code-review.sh"
if [[ ! -f "$REVIEW_DEFAULT" ]]; then
  if [[ -n "${WORKBENCH_SHARED_DIR:-}" ]]; then
    REVIEW_DEFAULT="$WORKBENCH_SHARED_DIR/.agents/skills/review/code-review.sh"
  else
    REVIEW_DEFAULT="$SKILLS_DIR/review/code-review.sh"
  fi
fi
REVIEW="${VALIDATE_CODE_REVIEW:-$REVIEW_DEFAULT}"
AUTOMATED_CHECKS="${VALIDATE_AUTOMATED_CHECKS:-$SKILLS_DIR/implement-audit/scripts/run-automated-checks.sh}"
QA_TARGETS_SH="${VALIDATE_QA_TARGETS:-$SKILLS_DIR/qa/scripts/qa-targets.sh}"
MARK_QA_DONE="${VALIDATE_MARK_QA_DONE:-$SKILLS_DIR/qa/scripts/mark-qa-done.sh}"

NEED_FIX=0
NEED_E2E=0
# Set when no independent reviewer answered: the phase ends in exit 3, pending.
PENDING_FALLBACK=0

# Both fields, every time, on every exit path. A caller that branches on
# NEED_FIX must never have to distinguish "0" from "the script died before
# printing it" — an absent field reads as a pass in every shell idiom there is.
emit_fields() {
  printf 'NEED_FIX=%s\n' "$NEED_FIX"
  printf 'NEED_E2E=%s\n' "$NEED_E2E"
}

scope_files() {
  bash "$SCRIPT_DIR/resolve-scope.sh" --scope "$SCOPE"
}

# Files that changed between a snapshot tree and the working tree, plus the
# untracked ones git diff cannot see.
#
# The layers need THIS list, not the scope, whenever they re-run after something
# moved the tree. `/qa`'s fixes and a fix round's edits are routinely unstaged or
# untracked, and a blank `--scope` resolves to the STAGED set — so the re-run
# reported PASS over files it had never opened.
files_since() {
  local tree="$1"
  {
    git -C "$REPO_DIR" diff --name-only "$tree" 2>/dev/null || true
    git -C "$REPO_DIR" ls-files --others --exclude-standard 2>/dev/null || true
  } | grep -v '^[[:space:]]*$' | sort -u || true
}

# Layers 1 and 2, in that order, with layer 1 gating layer 2 — type errors mask
# runtime errors, so a failing typecheck makes a test result meaningless.
#
# $1, when given, is an explicit file list; otherwise the scope is resolved.
run_layers_1_2() {
  local files rc=0
  if [[ $# -gt 0 ]]; then
    files="$1"
  else
    # A scope that does not resolve is NOT an empty scope. Every caller invokes
    # this function as `run_layers_1_2 || rc=$?`, which suspends errexit for the
    # whole body — so a failing resolve-scope left `files` empty and the layers
    # cheerfully reported PASS over nothing, for a scope naming an app that does
    # not exist. Check the substitution explicitly; `set -e` will not do it here.
    if ! files="$(CLAUDE_PROJECT_DIR="$REPO_DIR" scope_files)"; then
      err "validate: the scope '${SCOPE}' did not resolve — refusing to validate an empty file list."
      err "  An unresolvable scope is a caller error, not a clean run over zero files."
      return 1
    fi
  fi
  CLAUDE_PROJECT_DIR="$REPO_DIR" bash "$SCRIPT_DIR/layer-1.sh" <<<"$files" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    err "validate: layer 1 failed — stopping. Nothing downstream runs on a tree that does not type-check."
    return 1
  fi
  CLAUDE_PROJECT_DIR="$REPO_DIR" bash "$SCRIPT_DIR/layer-2.sh" <<<"$files" || return 1
  return 0
}

snapshot() {
  [[ -f "$REVIEW" ]] || return 1
  CODEX_REVIEW_REPO="$REPO_DIR" bash "$REVIEW" --snapshot 2>/dev/null
}

# ── --fallback-review ─────────────────────────────────────────────────
#
# The way out of a pending review (exit 3). The fallback reviewer's triage lines
# are read exactly as code-review.sh's are: a [must-fix] or [should-fix] is a
# fix owed (exit 1), a [nit] is held, and none — with the NO_FINDINGS sentinel
# or only nits — is a pass (exit 0). A file with neither is exit 1. It is a pass
# of a WEAKER review, and the line it prints says so, because the report and the
# journal carry it and nothing may read it as an independent one.
if [[ -n "$FALLBACK_FILE" ]]; then
  [[ -f "$FALLBACK_FILE" ]] || { err "validate: --fallback-review file not found: $FALLBACK_FILE"; exit 2; }
  # A review says something: at least one finding, or a clean-review line —
  # the same rule code-review.sh holds a vendor to. An empty file or loose
  # prose is a review that did not happen. Two spellings are read: triage lines
  # with NO_FINDINGS, and the fallback reviewer's own format
  # (.agents/agents/implement-audit-reviewer.md: `verdict: **fix-now**`, …, and
  # its "Zero findings." line), so its output can be saved as it is.
  FB_ANY='^(\[(must-fix|should-fix|nit)\] |NO_FINDINGS[[:space:]]*$|Zero findings\.)|verdict: \*\*(fix-now|deferred-batch-[0-9]+|speculative|out-of-scope)\*\*'
  if ! grep -qE "$FB_ANY" "$FALLBACK_FILE"; then
    err "validate: $FALLBACK_FILE holds no finding line and no NO_FINDINGS — the fallback review did NOT happen."
    emit_fields
    exit 1
  fi
  cat "$FALLBACK_FILE"
  grep -qE '^\[(must-fix|should-fix)\]|verdict: \*\*(fix-now|deferred-batch-[0-9]+)\*\*' "$FALLBACK_FILE" && NEED_FIX=1
  echo "NOTE: recorded as claude-fallback (fresh context, NOT independent)"
  emit_fields
  [[ "$NEED_FIX" -eq 0 ]] || exit 1
  exit 0
fi

# ── --require-qa ──────────────────────────────────────────────────────
#
# The gate that makes "QA must run fully if there's a UI" a mechanism. It is not
# a commit trailer, because nothing in the close reads those, and not a Stop
# hook, because a Stop hook fires after the reply has already been sent.
#
# Every target needs a marker for THIS tree. A /qa run that edited source moved
# the tree, which is exactly when an earlier target's pass stopped describing
# what is about to ship — so a stale marker is a missing marker, deliberately.
if [[ "$REQUIRE_QA" -eq 1 ]]; then
  [[ -n "$TREE" ]] || { err "validate: --require-qa needs --tree <sha>"; exit 2; }
  if [[ -z "$TARGETS_FILE" ]]; then
    err "validate: --require-qa needs --targets-file <path>"
    exit 2
  fi
  if [[ ! -f "$TARGETS_FILE" ]]; then
    err "validate: --targets-file not found: $TARGETS_FILE"
    exit 2
  fi
  if [[ ! -f "$MARK_QA_DONE" ]]; then
    err "validate: no marker helper at $MARK_QA_DONE — cannot verify QA."
    exit 2
  fi
  missing=0
  checked=0
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    checked=$((checked + 1))
    if [[ ! -d "$target" ]]; then
      err "validate: QA target no longer exists: $target"
      missing=$((missing + 1))
      continue
    fi
    marker="$(bash "$MARK_QA_DONE" --marker-path --tree "$TREE" "$target")"
    if [[ -f "$marker" ]]; then
      echo "PASS: qa-marker $target"
    else
      echo "FAIL: qa-marker $target"
      err "validate: $target has no completed /qa for tree ${TREE:0:12}"
      missing=$((missing + 1))
    fi
  done <"$TARGETS_FILE"
  if [[ "$missing" -gt 0 ]]; then
    err ""
    err "$missing of $checked web target(s) have not finished /qa on this tree."
    err "A UI change closes only after /qa completed on it — impeccable on"
    err "@latest, screenshots, sight-check, visual review. Run /qa on each"
    err "target above and let it write its marker; do not write one by hand."
    NEED_FIX=1
    emit_fields
    exit 1
  fi
  echo "PASS: qa-marker ($checked target(s) complete for tree ${TREE:0:12})"
  emit_fields
  exit 0
fi

case "$PHASE" in
  checks|review|qa-list|qa-revalidate) ;;
  "") err "validate: --phase is required (checks | review | qa-list | qa-revalidate)"; exit 2 ;;
  *) err "validate: unknown phase: $PHASE"; exit 2 ;;
esac

# ── --phase checks ────────────────────────────────────────────────────
#
# Layer 1 (lint + typecheck) → layer 2 (tests) → layer 3 (quality, advisory). Then
# the SKILL walks SPEC § 6 and the mechanism-match line. Always — an unchanged
# review does not buy a skipped E2E, and that is the whole reason E2E moved off
# the review's tail.
if [[ "$PHASE" == "checks" ]]; then
  rc=0
  run_layers_1_2 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    NEED_FIX=1
    emit_fields
    exit 1
  fi
  # Advisory by contract: land.sh's checks are the blocking surface for shape.
  CLAUDE_PROJECT_DIR="$REPO_DIR" bash "$SCRIPT_DIR/layer-3.sh" --scope "$SCOPE" || true
  NEED_E2E=1
  echo "NOTE: walk SPEC § 6 end-to-end now, then the mechanism-match line, before --phase review"
  emit_fields
  exit 0
fi

# ── --phase review ────────────────────────────────────────────────────
if [[ "$PHASE" == "review" ]]; then
  if [[ ! -f "$REVIEW" ]]; then
    err "validate: no reviewer at $REVIEW — the audit cannot run and the session cannot close."
    NEED_FIX=1
    emit_fields
    exit 1
  fi

  PRE="$(snapshot || true)"
  if [[ -z "$PRE" ]]; then
    err "validate: could not snapshot the working tree; the review cannot be scoped."
    NEED_FIX=1
    emit_fields
    exit 1
  fi
  echo "PRE_TREE=$PRE"

  # MANDATORY, not optional. These are the six deterministic checks; skipping
  # them to save a few seconds is how a dangling rule ref reaches a vendor call.
  if [[ -f "$AUTOMATED_CHECKS" ]]; then
    checks_rc=0
    CLAUDE_PROJECT_DIR="$REPO_DIR" bash "$AUTOMATED_CHECKS" \
      --session-base "${BASE:-HEAD}" --repo-dir "$REPO_DIR" || checks_rc=$?
    if [[ "$checks_rc" -ne 0 ]]; then
      err "validate: the automated checks reported a FAIL — fix those before spending a vendor call."
      NEED_FIX=1
      emit_fields
      exit 1
    fi
  else
    err "validate: WARN no automated checks at $AUTOMATED_CHECKS"
  fi

  review_out="$(mktemp -t validate-review-XXXXXX)"
  review_rc=0
  if [[ -n "$SINCE" ]]; then
    CODEX_REVIEW_REPO="$REPO_DIR" bash "$REVIEW" --since "$SINCE" >"$review_out" || review_rc=$?
  else
    [[ -n "$BASE" && -n "$HEAD_REF" ]] || {
      rm -f "$review_out"
      err "validate: --phase review needs --base and --head (round 1) or --since <tree> (rounds 2+)"
      exit 2
    }
    CODEX_REVIEW_REPO="$REPO_DIR" bash "$REVIEW" "$BASE" "$HEAD_REF" >"$review_out" || review_rc=$?
  fi

  case "$review_rc" in
    0) ;;
    4)
      echo "NOTE: the fix loop converged — nothing changed since the last round"
      ;;
    3)
      # Contextium: no independent reviewer answered. A completed-but-weaker
      # path, not a failure: the agent runs the fresh-context fallback reviewer
      # and records it as NOT independent.
      echo "NOTE: no independent reviewer — the review is PENDING. Run the implement-audit-reviewer agent in a fresh context on the same diff, save its triage lines, then: validate.sh --fallback-review <file>. Record: implement-audit: round-<N>; claude-fallback (fresh context, NOT independent); …"
      echo "NEED_FALLBACK_REVIEW=1"
      PENDING_FALLBACK=1
      ;;
    5)
      echo "NOTE: the fix loop hit the round-4 ceiling — report what is still open"
      ;;
    2)
      rm -f "$review_out"
      err "validate: the reviewer was called wrong (exit 2). Fix the range and re-run."
      exit 2
      ;;
    *)
      rm -f "$review_out"
      err "validate: the reviewer exited ${review_rc} — the review did NOT happen."
      err "That is not a clean pass and it is not a nit to hold: there is no audit,"
      err "so there is no close. Restore a vendor and re-run."
      NEED_FIX=1
      emit_fields
      exit 1
      ;;
  esac

  # Only exit 0 carries findings; 4 and 5 print none by construction.
  if [[ "$review_rc" -eq 0 ]]; then
    cat "$review_out"
    # A [nit] is held for the end of the loop, never a reason to re-enter it —
    # nits are an unbounded supply and re-reviewing after fixing one is how the
    # loop finds the next one forever.
    if grep -qE '^\[(must-fix|should-fix)\]' "$review_out"; then
      NEED_FIX=1
    fi
  fi
  rm -f "$review_out"

  POST="$(snapshot || true)"
  echo "POST_TREE=$POST"

  # WHAT THIS COMPARES AGAINST, and why it is not $PRE on a follow-up round.
  #
  # The reviewer never edits the tree, so $PRE and $POST are equal in the common
  # case and comparing them answers nothing. The question that matters is "has
  # anything changed since the last state the layers actually validated?" — and
  # on a follow-up round that state is $SINCE, the snapshot taken before the
  # PREVIOUS round. Everything between them is this round's FIXES, which by
  # definition no layer and no E2E has seen. Comparing against $PRE declared
  # them validated because $PRE was taken after they were written.
  baseline="${SINCE:-$PRE}"
  if [[ -n "$POST" && "$POST" != "$baseline" ]]; then
    err "validate: the tree moved since ${baseline:0:12} — re-running layers 1+2 over what moved."
    rc=0
    run_layers_1_2 "$(files_since "$baseline")" || rc=$?
    [[ "$rc" -ne 0 ]] && NEED_FIX=1
    NEED_E2E=1
  fi

  emit_fields
  [[ "$NEED_FIX" -eq 0 ]] || exit 1
  [[ "$PENDING_FALLBACK" -eq 0 ]] || exit 3
  exit 0
fi

# ── --phase qa-list ───────────────────────────────────────────────────
if [[ "$PHASE" == "qa-list" ]]; then
  if [[ ! -f "$QA_TARGETS_SH" ]]; then
    err "validate: no enumerator at $QA_TARGETS_SH — cannot tell whether a UI changed."
    exit 2
  fi
  targets_rc=0
  # --base matters: /implement-audit reviews BASE_SHA..HEAD *plus* uncommitted,
  # so a session that committed its UI change has it in the review and nowhere
  # in `git diff HEAD`. Without this the enumerator saw a clean-ish worktree and
  # answered "skipped-not-web" for a change that was all pixels.
  targets_args=(--repo "$REPO_DIR")
  [[ -n "$BASE" ]] && targets_args+=(--base "$BASE")
  targets="$(bash "$QA_TARGETS_SH" ${targets_args[@]+"${targets_args[@]}"})" || targets_rc=$?
  if [[ "$targets_rc" -ne 0 ]]; then
    err "validate: the QA target enumerator failed (exit ${targets_rc}). HALT —"
    err "a detector failure must never read as 'no UI changed'."
    exit 2
  fi
  if [[ -z "$targets" ]]; then
    echo "QA_TARGETS="
    echo "NOTE: no web target in this change — record qa: skipped-not-web"
  else
    while IFS= read -r t; do
      [[ -n "$t" ]] || continue
      printf 'QA_TARGETS=%s\n' "$t"
    done <<<"$targets"
  fi
  emit_fields
  exit 0
fi

# ── --phase qa-revalidate ─────────────────────────────────────────────
#
# /qa fixes things. Impeccable findings get fixed, visual findings get fixed,
# and those edits are code nobody has reviewed. Re-reviewing them goes through
# code-review.sh --since directly rather than through a second /implement-audit
# dispatch, because audit-dedupe.sh would no-op that dispatch and re-emit the
# stored trailer — a clean-looking audit over unreviewed bytes.
if [[ "$PHASE" == "qa-revalidate" ]]; then
  [[ -n "$SINCE" ]] || { err "validate: --phase qa-revalidate needs --since <tree>"; exit 2; }
  POST="$(snapshot || true)"
  echo "POST_TREE=$POST"

  if [[ -n "$POST" && "$POST" == "$SINCE" ]]; then
    echo "NOTE: /qa changed nothing — no re-review needed"
    emit_fields
    exit 0
  fi

  NEED_E2E=1
  rc=0
  # Over what /qa MOVED, not over the scope. /qa's fixes are routinely unstaged
  # or untracked, and a blank scope resolves to the staged set — so this used to
  # report PASS over files it had never opened.
  run_layers_1_2 "$(files_since "$SINCE")" || rc=$?
  [[ "$rc" -ne 0 ]] && NEED_FIX=1

  if [[ ! -f "$REVIEW" ]]; then
    err "validate: no reviewer at $REVIEW — /qa's edits cannot be reviewed."
    NEED_FIX=1
    emit_fields
    exit 1
  fi

  review_out="$(mktemp -t validate-qa-review-XXXXXX)"
  review_rc=0
  # ITS OWN ROUND BUDGET. The round counter is keyed on the session, and the
  # implementation fix loop that ran before this may have spent all four rounds
  # — at which point the post-QA review would return exit 5 without ever
  # calling a vendor, and /qa's own source edits would ship unreviewed behind a
  # "ceiling reached" note. This is a DIFFERENT loop reviewing DIFFERENT code,
  # so it gets a different counter, which is the same reasoning code-review.sh
  # uses when a full two-arg review resets the count.
  CODEX_REVIEW_REPO="$REPO_DIR" \
    CODE_REVIEW_ROUND_STATE_DIR="${CODE_REVIEW_ROUND_STATE_DIR:-/tmp/code-review-rounds}-qa" \
    bash "$REVIEW" --since "$SINCE" >"$review_out" || review_rc=$?
  case "$review_rc" in
    0)
      cat "$review_out"
      grep -qE '^\[(must-fix|should-fix)\]' "$review_out" && NEED_FIX=1
      ;;
    4) echo "NOTE: nothing to re-review after /qa" ;;
    3)
      echo "NOTE: no independent reviewer — the review of /qa's edits is PENDING. Run the implement-audit-reviewer agent on them in a fresh context, save its triage lines, then: validate.sh --fallback-review <file>. Record it as claude-fallback (fresh context, NOT independent)"
      echo "NEED_FALLBACK_REVIEW=1"
      PENDING_FALLBACK=1
      ;;
    5)
      # With a dedicated counter this cannot fire on the first qa-revalidate,
      # and if it somehow does it means the post-QA review did NOT happen. That
      # is not a note to carry to the close; it is the same unreviewed-code
      # failure exit 1 and 124 are.
      err "validate: the post-QA review hit the round ceiling — /qa's edits are unreviewed."
      NEED_FIX=1
      ;;
    *)
      err "validate: the post-QA review exited ${review_rc} — /qa's edits are unreviewed."
      NEED_FIX=1
      ;;
  esac
  rm -f "$review_out"

  emit_fields
  [[ "$NEED_FIX" -eq 0 ]] || exit 1
  [[ "$PENDING_FALLBACK" -eq 0 ]] || exit 3
  exit 0
fi
