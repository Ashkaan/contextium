#!/usr/bin/env bash
# stub-hang.sh — CODEX_BIN stub: sleeps well past any sane review timeout.
#
# Stands in for a review that hangs until killed. Run this with a short
# POLICY_CHAIN_SLOT_TIMEOUT_S so the assertion is fast.
#
# Expected: code-review.sh exits 124 (coreutils timeout convention).
set -euo pipefail
sleep 600
