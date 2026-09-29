#!/usr/bin/env bash
# stub-fail.sh — CODEX_BIN stub: exits non-zero with a diagnostic, standing in
# for an unreachable / broken codex (container down, auth expired).
#
# Simulating the failure with a stub rather than stopping the real container
# keeps a failed test run from leaving the review path broken on what is a
# workstation someone may be mid-session on.
#
# Expected: code-review.sh exits 1 (review did NOT complete).
set -euo pipefail
echo "stub-fail: simulated codex failure" >&2
exit 3
