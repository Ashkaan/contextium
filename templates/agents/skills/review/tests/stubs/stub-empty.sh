#!/usr/bin/env bash
# stub-empty.sh — CODEX_BIN stub: exits 0 having printed nothing at all.
#
# This is the highest-severity boundary a review gate has: without the
# NO_FINDINGS sentinel, "reviewed and found nothing" and "crashed silently" are
# byte-identical, and a gate that reads this as a pass ships unreviewed code
# while still carrying the gate's assurance.
#
# Expected: code-review.sh exits 1 (FAILED review, not a clean pass).
set -euo pipefail
exit 0
