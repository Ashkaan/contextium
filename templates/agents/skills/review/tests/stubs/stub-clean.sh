#!/usr/bin/env bash
# stub-clean.sh — CODEX_BIN stub: reviews successfully and finds nothing,
# emitting the NO_FINDINGS sentinel exactly as the prompt instructs.
#
# The paired opposite of stub-empty.sh. These two differ ONLY by the sentinel
# line, which is the whole point: that one line is what makes "clean" and
# "crashed" distinguishable, so the gate must exit 0 here and 1 there.
set -euo pipefail
echo "NO_FINDINGS"
