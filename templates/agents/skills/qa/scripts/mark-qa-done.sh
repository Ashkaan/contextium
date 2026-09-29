#!/usr/bin/env bash
# mark-qa-done.sh — record that a webapp repo has been visually QA'd.
#
# TWO MARKERS, TWO READERS, AND THEY ANSWER DIFFERENT QUESTIONS.
#
#   1. The CHANGE-SET marker, keyed on `git status --porcelain | cksum`
#      (qa_change_hash). Its only reader was a QA Stop hook that no longer
#      exists — so this marker now has no reader at all. Still written,
#      unchanged: it costs nothing.
#
#   2. The TREE marker, keyed on a git tree SHA. Read by
#      `/implement`'s `validate.sh --require-qa`, which refuses to let the
#      session close while a web target in the diff has no completed /qa.
#
# WHY THE SECOND ONE EXISTS. Marker 1 cannot carry that gate. Its key is a
# digest of the UNCOMMITTED change-set, so once the work is committed the digest
# is of empty input — a marker written after a commit is keyed `-4294967295`,
# which is exactly `printf '' | cksum`. A marker that can never match a future state cannot prove
# anything about the tree that shipped. A tree SHA can: it names the exact bytes
# QA looked at, it survives the commit, and — this is the part the gate needs —
# a LATER /qa that edits source changes the tree, so an earlier target's marker
# stops matching and that target runs again.
#
# Usage:
#   mark-qa-done.sh <repo-dir>                       change-set marker only
#   mark-qa-done.sh --tree <sha> <repo-dir>          both markers
#   mark-qa-done.sh --marker-path --tree <sha> <repo-dir>
#                                                    print the tree marker's
#                                                    path; write nothing
#
# `--marker-path` is how validate.sh asks "is this target done?" without
# re-deriving the key. The slug formula lives here and nowhere else
# (single source of truth); a second copy of `basename-cksum` in the gate
# would be a marker writer and a marker reader that can silently disagree.
#
# peers:
#   .agents/skills/qa/scripts/lib.sh
#   .agents/skills/implement/scripts/validate.sh
#   .agents/skills/qa/scripts/tests/qa-targets.test.sh
#
# Exit:  0 marked (or path printed); 2 usage; 3 --tree on a served app whose
#        interaction check has not passed on that tree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # sibling source, resolved at runtime
source "$SCRIPT_DIR/lib.sh"

TREE=""
PRINT_ONLY=0
REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tree) TREE="${2:-}"; [[ $# -gt 1 ]] || { qa_err "mark-qa-done: --tree needs a sha"; exit 2; }; shift 2 ;;
    --marker-path) PRINT_ONLY=1; shift ;;
    -h|--help) sed -n '2,40p' "$0" >&2; exit 0 ;;
    --*) qa_err "mark-qa-done: unknown flag: $1"; exit 2 ;;
    *) REPO="$1"; shift ;;
  esac
done

[[ -n "$REPO" && -d "$REPO" ]] || {
  qa_err "usage: mark-qa-done.sh [--marker-path] [--tree <sha>] <repo-dir>"
  exit 2
}
REPO="$(cd "$REPO" && pwd)"

# An override so the marker writer and its readers can be pointed at a sandbox
# together.
DONE_DIR="${QA_DONE_DIR:-/tmp/qa-done}"

# TWO SLUGS, and they are not interchangeable.
#
# The CHANGE-SET marker stays keyed on the bare basename, which is how the Stop
# hook that used to read it spelled the key (`$(basename "$repo")-$hash`,
# inline). That hook is gone, so the marker has no reader and the slug no
# longer has to match anything; it is left alone because changing a key nobody
# reads is churn.
#
# The TREE marker is new, and its only reader is validate.sh --require-qa in
# this same tree, so it gets the collision-safe slug: two `dashboard/`
# directories in different repos must not share one QA verdict.
legacy_slug="$(basename "$REPO")"
tree_slug="$(qa_repo_slug "$REPO")"

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  [[ -n "$TREE" ]] || { qa_err "mark-qa-done: --marker-path needs --tree <sha>"; exit 2; }
  printf '%s/%s-%s\n' "$DONE_DIR" "$tree_slug" "$TREE"
  exit 0
fi

mkdir -p "$DONE_DIR"

# `qa_change_hash` pipes `git status` into cksum, so under `set -euo pipefail`
# a target directory that is not itself a git checkout killed this script before
# it wrote anything — and the caller saw a clean exit code from a run that
# marked nothing. The change-set marker is best-effort by nature (it is the Stop
# hook's key, not a gate); the TREE marker below is the one a gate reads, and it
# does not depend on this at all.
hash="$(qa_change_hash "$REPO" 2>/dev/null || echo unknown)"
[[ -n "$hash" ]] || hash=unknown
touch "$DONE_DIR/$legacy_slug-$hash"
echo "qa: marked $legacy_slug QA'd for current change-set ($DONE_DIR/$legacy_slug-$hash)"

if [[ -n "$TREE" ]]; then
  # A served web app is not QA'd until its buttons were pressed on THIS tree
  # (step-3.7-interaction). CLI and render targets have
  # none, so they need no stamp.
  type="$(bash "$SCRIPT_DIR/detect-app.sh" "$REPO" 2>/dev/null | sed -n 's/^TYPE=//p' || true)"
  if [[ "$type" != "cli" && "$type" != "render" ]]; then
    stamp="$(qa_interaction_stamp_path "$REPO" "$TREE")"
    if [[ ! -e "$stamp" ]]; then
      qa_err "mark-qa-done: refusing — no clean interaction check for tree ${TREE:0:12} ($stamp)."
      qa_err "  Run step-3.7: interaction-check.sh --url <url> --pages '<routes>' --repo $REPO, fix what it finds, and mark again."
      exit 3
    fi
  fi
  touch "$DONE_DIR/$tree_slug-$TREE"
  echo "qa: marked $tree_slug QA'd for tree ${TREE:0:12} ($DONE_DIR/$tree_slug-$TREE)"
fi
