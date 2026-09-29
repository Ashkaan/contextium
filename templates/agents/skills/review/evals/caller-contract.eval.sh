#!/usr/bin/env bash
# caller-contract.eval.sh — does the reviewer catch a broken caller it cannot
# see in the diff?
#
# Required by an eval suite for every app that calls a model: `code-review.sh verdict` is a
# declared ai_judgment_feature (SPEC front matter), and changing that script's
# prompt is a prompt change. This is the rerun.
#
# THE FIXTURE IS THE WHOLE ARGUMENT. One file changes: an exported function
# grows a second, REQUIRED parameter that its body immediately dereferences. The
# only caller lives in a second file that the diff does not touch and does not
# mention. Before the blast-radius pack there was nothing in the prompt that
# could lead a reviewer to that file — it would have to guess that a caller
# exists, guess where, and go read it. The pack puts `consumer.ts` in front of
# it by name, and this eval scores exactly one thing: does the review name the
# broken caller?
#
# WHAT IS NOT BEING SCORED. Not the reviewer's disposition, not its finding
# count, not its severity choice, not its prose. A review that reports the
# caller as `[must-fix]`, as `[should-fix]`, or in passing inside another
# finding all PASS. The claim under test is about what reached the prompt.
#
# This spends ONE real vendor call, on whichever vendor the `adversarial-review`
# row selects. It is not part of `npm test` for that reason — a suite that costs
# a vendor call per run stops being run.
#
# Usage:
#   bash .agents/skills/review/evals/caller-contract.eval.sh
#   bash .agents/skills/review/evals/caller-contract.eval.sh --pack-only
#
# `--pack-only` asserts the deterministic half — that the pack names the caller
# — and spends nothing. Useful for checking the fixture still bites after a
# packer change, and NOT a substitute for the rerun: a pack that reaches the
# prompt and a reviewer that acts on it are two different claims.
#
# Exit:
#   0  PASS — the review named the caller (or, with --pack-only, the pack did)
#   1  FAIL — it did not
#   2  the review did not happen (chain exhausted, timeout, caller error).
#      INCONCLUSIVE, not a failing grade: an outage must never read as a
#      model regression.
#
# peers:
#   .agents/skills/review/code-review.sh
#   .agents/skills/review/blast-radius.sh
#   .agents/skills/review/evals/README.md

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The scripts under eval sit one level up: this folder is .agents/skills/review/evals/.
CHECKS="$(cd "$SCRIPT_DIR/.." && pwd)"
REVIEW="$CHECKS/code-review.sh"
PACK="$CHECKS/blast-radius.sh"

PACK_ONLY=0
[[ "${1:-}" == "--pack-only" ]] && PACK_ONLY=1

TMP="$(mktemp -d "${TMPDIR:-/tmp}/caller-contract-eval.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repo"
mkdir -p "$REPO/src"
git -C "$REPO" init -q .
git -C "$REPO" config user.email eval@local
git -C "$REPO" config user.name eval

cat >"$REPO/src/api.ts" <<'EOF'
export interface User {
  id: string
  name: string
}

export function getUser(id: string): User {
  return { id, name: `user-${id}` }
}
EOF

# The caller. It is committed BEFORE the change and never touched again, so it
# appears in no hunk of the diff under review.
cat >"$REPO/src/consumer.ts" <<'EOF'
import { getUser } from './api'

export function greet(id: string): string {
  const user = getUser(id)
  return `hello ${user.name}`
}
EOF

cat >"$REPO/README.md" <<'EOF'
# fixture
A two-file module used by the review chain's caller-contract eval.
EOF

git -C "$REPO" add src README.md
git -C "$REPO" commit -qm "initial module"

# The change: a second parameter, required, and dereferenced on the first line
# of the body. Every existing caller now passes `undefined` and throws.
cat >"$REPO/src/api.ts" <<'EOF'
export interface User {
  id: string
  name: string
}

export interface LookupOptions {
  includeArchived: boolean
}

export function getUser(id: string, options: LookupOptions): User {
  const suffix = options.includeArchived ? '-archived' : ''
  return { id, name: `user-${id}${suffix}` }
}
EOF

git -C "$REPO" add src/api.ts
git -C "$REPO" commit -qm "add a lookup options parameter to getUser"

BASE="$(git -C "$REPO" rev-parse HEAD~1)"
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"

# ── The deterministic half ────────────────────────────────────────────

git -C "$REPO" diff "$BASE" "$HEAD_SHA" >"$TMP/fixture.diff"
pack="$(bash "$PACK" --repo "$REPO" --diff-file "$TMP/fixture.diff" --old-ref "$BASE" src/api.ts 2>/dev/null)"

if ! grep -qF 'src/consumer.ts' <<<"$pack"; then
  echo "FAIL: the pack itself does not name the caller — the fixture no longer bites." >&2
  printf '%s\n' "$pack" >&2
  exit 1
fi
echo "PASS: the pack names src/consumer.ts as a caller of getUser"

if [[ "$PACK_ONLY" -eq 1 ]]; then
  echo "caller-contract: PASS (pack-only; no vendor call spent)"
  exit 0
fi

# ── The rerun ─────────────────────────────────────────────────────────

echo "caller-contract: spending one vendor call on the adversarial-review row…"
rc=0
CODEX_REVIEW_REPO="$REPO" \
  CODE_REVIEW_ROUND_STATE_DIR="$TMP/rounds" \
  CODE_REVIEW_SNAP_STATE_DIR="$TMP/snaps" \
  bash "$REVIEW" "$BASE" "$HEAD_SHA" >"$TMP/review.out" 2>"$TMP/review.err" || rc=$?

if [[ "$rc" -ne 0 ]]; then
  echo "INCONCLUSIVE: the review did not complete (exit $rc). This is not a" >&2
  echo "failing grade — an exhausted chain or a timeout says nothing about the" >&2
  echo "prompt. Restore a vendor and re-run." >&2
  tail -20 "$TMP/review.err" >&2
  exit 2
fi

echo "--- review stdout ---"
cat "$TMP/review.out"
echo "--- end ---"

if grep -qiE 'consumer' "$TMP/review.out"; then
  echo "caller-contract: PASS — the review named the broken caller."
  exit 0
fi

echo "caller-contract: FAIL — the review did not name src/consumer.ts." >&2
echo "The pack put that file in the prompt by name and the caller is now" >&2
echo "passing \`undefined\` into a required parameter that is dereferenced on" >&2
echo "the first line of the body. Read the review above before changing the" >&2
echo "prompt: a single miss is one sample, not a regression." >&2
exit 1
