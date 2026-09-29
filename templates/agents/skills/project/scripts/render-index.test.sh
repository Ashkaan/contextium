#!/usr/bin/env bash
# shellcheck disable=SC2016 # the backticks are markdown code spans, not command substitution
# render-index.test.sh — peer of render-index.sh. Run: bash render-index.test.sh
#
# The generator is replaced by a stub that prints a fixed compact index, so the
# suite checks the composition — the Completed line held back to the end, the
# lapsed block built from check-staleness.sh's rows, the closing prompt — and
# not the generator's own output, which its own tests cover.
# CONTEXT_CODE_REPO points render-index.sh at the fixture repo and its stub;
# CONTEXT_WRITE_ROOT points check-staleness.sh at the same fixture's projects.
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/render-index.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d "${TMPDIR:-/tmp}/render-index-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
tmp="$(cd "$tmp" && pwd -P)"
unset CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID

# GNU date, else BSD date (macOS).
PAST10=$(date -d "10 days ago" +%Y-%m-%d 2>/dev/null || date -v-10d +%Y-%m-%d)
PAST3=$(date -d "3 days ago" +%Y-%m-%d 2>/dev/null || date -v-3d +%Y-%m-%d)

# stub <body> → the fixture's generator prints <body>
stub() {
  mkdir -p "$tmp/.agents/generators"
  printf 'process.stdout.write(%s);\n' "$1" >"$tmp/.agents/generators/project-index.generate.ts"
}
INDEX='"**Active — 1**\n\n| | slug | one-line |\n|-|-|-|\n|●| `checkout-flow` | Retry failed payments |\n\n**Completed — 4**\n"'
mon() { # mon <slug> <monitoring-until or empty>
  local d="$tmp/projects/web/2026-01-01_$1"; mkdir -p "$d"
  if [[ -n "$2" ]]; then
    printf -- '---\nstatus: monitor\nmonitoring-until: %s\n---\n' "$2" >"$d/README.md"
  else
    printf -- '---\nstatus: monitor\n---\n' >"$d/README.md"
  fi
}
run() { CONTEXT_CODE_REPO="$tmp" CONTEXT_WRITE_ROOT="$tmp" bash "$SUT" 2>&1; }

# ── Nothing lapsed ────────────────────────────────────────────────────────
stub "$INDEX"; mkdir -p "$tmp/projects" "$tmp/journal"
out="$(run)"
t "no lapsed windows: index, Completed, prompt — no Lapsed block" '**Active — 1**

| | slug | one-line |
|-|-|-|
|●| `checkout-flow` | Retry failed payments |

**Completed — 4**

Which one to start? Type `/project [slug]`.' "$out"

# ── Lapsed windows ────────────────────────────────────────────────────────
mon sync-engine "$PAST3"; mon export-cap "$PAST10"; mon no-date ""
out="$(run)"
t "lapsed block sits between the index and Completed, oldest lapse first, undated last" "**Lapsed — 3**
- web/export-cap — ended $PAST10 (10 days ago)
- web/sync-engine — ended $PAST3 (3 days ago)
- web/no-date — monitor with no monitoring-until date

\`/project <slug>\` to close or extend.

**Completed — 4**

Which one to start? Type \`/project [slug]\`." "$(printf '%s\n' "$out" | sed -n '/^\*\*Lapsed/,$p')"
t "the index above the lapsed block is untouched" "|●| \`checkout-flow\` | Retry failed payments |" "$(printf '%s\n' "$out" | sed -n '5p')"
t "exit 0 on a full render" "0" "$(CONTEXT_CODE_REPO="$tmp" CONTEXT_WRITE_ROOT="$tmp" bash "$SUT" >/dev/null 2>&1; echo $?)"

# ── Failures are loud ─────────────────────────────────────────────────────
stub '"**Active — 1**\n**Monitoring — 0**\n"'
t "a generator whose last line is not Completed is refused" \
  "render-index: expected the generator's last line to be the Completed heading, got: **Monitoring — 0**|rc=1" \
  "$(run | tr '\n' '|')rc=$(CONTEXT_CODE_REPO="$tmp" CONTEXT_WRITE_ROOT="$tmp" bash "$SUT" >/dev/null 2>&1; echo $?)"

stub '"x\n"); process.exit(7'
t "a failing generator's exit status is passed through" "7" "$(CONTEXT_CODE_REPO="$tmp" CONTEXT_WRITE_ROOT="$tmp" bash "$SUT" >/dev/null 2>&1; echo $?)"

stub "$INDEX"
# A copy of the script beside a check-staleness.sh that fails: the scan reads
# the same root as the index, so its failure is simulated at the scan itself.
mkdir -p "$tmp/copy"; cp "$SUT" "$tmp/copy/render-index.sh"
printf '#!/usr/bin/env bash\nexit 3\n' >"$tmp/copy/check-staleness.sh"
t "a failing staleness scan is not rendered as no lapsed projects" \
  "render-index: check-staleness.sh --expired-only failed; not rendering a lapsed list from nothing" \
  "$(CONTEXT_CODE_REPO="$tmp" bash "$tmp/copy/render-index.sh" 2>&1 >/dev/null | tail -n 1)"

rm -rf "$tmp/.agents"
t "a missing generator names where it looked" \
  "render-index: no project-index generator at $tmp/.agents/generators/project-index.generate.ts (set CONTEXT_CODE_REPO)|rc=1" \
  "$(run | tr '\n' '|')rc=$(CONTEXT_CODE_REPO="$tmp" bash "$SUT" >/dev/null 2>&1; echo $?)"

# ── One checkout for both halves ──────────────────────────────────────────
# The index and the lapsed scan read the SAME tree: the session's write root.
# With only CONTEXT_WRITE_ROOT set, the generator that runs is that root's, not
# the one beside this script (which, reached through a home link, is another
# checkout).
stub '"**Active — 0**\n\n**Completed — 9**\n"'
t "the generator runs from the write root, not the script's checkout" "**Completed — 9**" \
  "$(CONTEXT_WRITE_ROOT="$tmp" bash "$SUT" 2>/dev/null | grep -F '**Completed')"
rm -rf "$tmp/.agents"
t "a write root with no generator is named, not bypassed" \
  "render-index: no project-index generator at $tmp/.agents/generators/project-index.generate.ts (set CONTEXT_CODE_REPO)" \
  "$(CONTEXT_WRITE_ROOT="$tmp" bash "$SUT" 2>&1 >/dev/null | head -n 1)"

# ── A Node too old to run TypeScript is named, not a crash ────────────────
stub "$INDEX"
mkdir -p "$tmp/oldnode"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo v22.5.0; exit 0; }\nexit 9\n' >"$tmp/oldnode/node"; chmod +x "$tmp/oldnode/node"
t "Node older than 22.6 is refused with the version it found" \
  "render-index: blank /project needs Node 22.6 or newer to run the index generator (found v22.5.0)|rc=1" \
  "$(PATH="$tmp/oldnode:$PATH" CONTEXT_CODE_REPO="$tmp" bash "$SUT" 2>&1 >/dev/null | head -n 1)|rc=$(PATH="$tmp/oldnode:$PATH" CONTEXT_CODE_REPO="$tmp" bash "$SUT" >/dev/null 2>&1; echo $?)"

echo "render-index.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
