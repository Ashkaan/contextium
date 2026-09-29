#!/usr/bin/env bash
# stub-prose.sh — CODEX_BIN stub: returns unparseable prose and no sentinel.
#
# Models a reviewer that ignored the strict output format. A review whose
# output could not be parsed has not happened, so the gate must exit 1 with the
# prose diverted to stderr and stdout left empty.
set -euo pipefail
echo "I took a look at the changes and they seem reasonable overall."
echo "Nothing jumped out at me as a serious problem."
