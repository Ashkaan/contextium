#!/usr/bin/env bash
# check-harness-config-links.sh — prove that every harness link is still a
# SYMLINK into this workbench, and that every hook manifest still names both
# pre-tool guards.
#
# WHY. The harness homes reach the workbench's skills and agents through links,
# so what every harness runs is versioned, diffable and restorable. The failure
# is silent: a harness that writes its own copy over a link leaves the
# workbench copy stale and nothing says so. This check reports it.
#
# WHY NOT JUST RELINK. Relinking a clobbered path by default erases the
# evidence — and the machine-written content — this check exists to report. So:
# report by default, `--fix` on request (the installer runs `--fix` after it
# has moved any real folder aside).
#
# WHY THE MANIFEST HALF LIVES HERE TOO. A link that is right can point at a
# manifest that quietly lost a guard. The assertions are MAPPINGS, not
# set-equality: two manifests that both dropped the write guard are equal to
# each other, and a right set of scripts behind a wrong matcher never fires.
#
# Usage:
#   check-harness-config-links.sh          report drift, exit 1 if any
#   check-harness-config-links.sh --fix    relink, moving any occupying file to
#                                          <path>.pre-link first
#
# Environment (tests only; nothing in a real run sets these):
#   HARNESS_LINKS_HOME     stand in for $HOME
#   HARNESS_LINKS_REPO     stand in for the main checkout
#
# Exit: 0 clean · 1 drift (or a --fix that could not complete)
#
# Needs jq for the manifest half; without it the manifests are skipped and
# the run says so. bash 3.2 compatible: no GNU realpath, no `mv -T`.

set -euo pipefail

FIX=0
case "${1:-}" in
  "") ;;
  --fix) FIX=1 ;;
  *)
    echo "usage: check-harness-config-links.sh [--fix]" >&2
    exit 1
    ;;
esac

H="${HARNESS_LINKS_HOME:-$HOME}"

# The MAIN checkout, never this worktree: a link into a worktree dies with it.
# --git-common-dir answers with the main checkout's .git from inside a worktree
# and with our own from inside the checkout, so one expression covers both.
if [[ -n "${HARNESS_LINKS_REPO:-}" ]]; then
  MAIN="$HARNESS_LINKS_REPO"
else
  MAIN="$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)"
fi

# The checkout this run is standing in — the manifests it asserts are this
# tree's, so a worktree is checked against its own copies rather than main's.
HERE="${HARNESS_LINKS_REPO:-$(git rev-parse --show-toplevel)}"

# ── The inventory ─────────────────────────────────────────────────────────
#
# TAB-separated: <link path> <expected target> <kind>. The skills rows are the
# whole folder, not a file: ~/.agents/skills is how every harness reaches the
# workbench's skills, and ~/.claude/skills and ~/.gemini/config/skills are
# Claude Code's and Antigravity's names for the same place.
# ~/.claude/output-styles is Claude Code's only: no other harness has output
# styles, and /author writes them to .agents/output-styles/.
#
# The hook rows exist only for a harness the installer was asked to wire, so a
# MISSING one is not drift — but one that exists must be right. <kind> says
# which: `required`; `optional` (missing is fine); `optional-file` (missing is
# fine, and so is a file of the user's own, into which the installer merged the
# guards instead of linking — the Codex case); `tool:<name>` (required while
# the workbench's .agents/harness `tools=` line names <name>, and not asked for
# when it does not; with no tools= line, required as before).
#
# ORDER IS LOAD-BEARING for --fix: two rows point at another link rather than
# at the workbench, and --fix refuses a target that does not exist yet.
# Workbench-backed rows first, chained rows after.
# The heredoc is read into a variable, not run inside "$(…)": bash 3.2 (the
# macOS default) mis-parses a $(…) whose heredoc body holds an unmatched
# quote or parenthesis, and the whole script then fails to parse.
IFS= read -r -d '' LINKS <<ROWS || true
${H}/.agents/skills	${MAIN}/.agents/skills	required
${H}/.claude/agents	${MAIN}/.agents/agents	tool:claude
${H}/.claude/output-styles	${MAIN}/.agents/output-styles	tool:claude
${H}/.codex/hooks.json	${MAIN}/.agents/hooks/claude-hooks.json	optional-file
${H}/.grok/hooks/contextium.json	${MAIN}/.agents/hooks/claude-hooks.json	optional
${HERE}/.gemini/settings.json	${HERE}/.agents/gemini-settings.json	optional
${H}/.claude/skills	${H}/.agents/skills	tool:claude
${H}/.gemini/config/skills	${H}/.agents/skills	tool:antigravity
ROWS
LINKS="${LINKS%$'\n'}"

# The tools this workbench has wired, from .agents/harness (empty when the file
# or its tools= line is absent: every tool row is then asked for, as before).
TOOLS_REC="$(sed -n 's/^tools=//p' "${HERE}/.agents/harness" 2>/dev/null | head -n 1 || true)"
tool_wired() { [[ -z "$TOOLS_REC" || " $TOOLS_REC " == *" $1 "* ]]; }

rc=0
n_ok=0
n_skip=0
errors=""

err() { errors="${errors}$1"$'\n'; rc=1; }

# Normalize WITHOUT following symlinks: absolute, `.`/`..` folded. The chained
# rows are links to links on purpose, and resolving all the way through would
# compare a row against the folder instead of against the link it must name.
norm() {
  local p="$1"
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  awk -v p="$p" 'BEGIN {
    n = split(p, a, "/"); k = 0
    for (i = 1; i <= n; i++) {
      if (a[i] == "" || a[i] == ".") continue
      if (a[i] == "..") { if (k > 0) k--; continue }
      s[++k] = a[i]
    }
    out = ""; for (i = 1; i <= k; i++) out = out "/" s[i]
    print (out == "" ? "/" : out)
  }'
}

# Replace <link> with <new> in one rename(2), so a concurrent reader sees the
# old entry or the new link and never a missing path. `mv` cannot: without
# GNU's -T it moves INTO a link that points at a directory. perl's rename is
# the call itself, and perl ships with macOS; without it, a remove-then-move
# leaves a moment with no link at all, which is the fallback, not the way.
swap() {
  local new="$1" link="$2"
  if command -v perl >/dev/null 2>&1; then
    perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\n"' "$new" "$link"
  else
    rm -f "$link" && mv "$new" "$link"
  fi
}

relink() {
  local link="$1" target="$2" tmp="$1.tmp-link" keep n
  # BEFORE anything is renamed. A link to a target that does not exist leaves
  # the harness with nothing to read, and preserving the displaced file does
  # not help a harness about to start. Return 2 so the caller can say WHY.
  [[ -e "$target" ]] || return 2
  # A real DIRECTORY is never relinked here: moving one aside is the
  # installer's step, said out loud, not a side effect of a check. Return 3.
  [[ -d "$link" && ! -L "$link" ]] && return 3
  rm -f "$tmp"
  if [[ -e "$link" && ! -L "$link" ]]; then
    # NEVER clobber an existing .pre-link: it may be the only copy of content
    # a harness wrote and that never reached the workbench.
    keep="$link.pre-link"
    if [[ -e "$keep" ]]; then
      keep="$link.pre-link.$(date +%Y%m%dT%H%M%S)"
      n=0
      while [[ -e "$keep" ]]; do
        n=$((n + 1))
        keep="$link.pre-link.$(date +%Y%m%dT%H%M%S).$n"
      done
    fi
    cp -pR -- "$link" "$keep" || return 1
    echo "kept the displaced file at $keep"
  fi
  ln -s "$target" "$tmp" || return 1
  if ! swap "$tmp" "$link"; then
    rm -f "$tmp"
    return 1
  fi
  # The target could vanish between the guard and the swap, and a "repair"
  # that returns 0 over a dangling link is how the gate would pass a harness
  # that cannot read its skills.
  [[ -e "$link" ]]
}

while IFS=$'\t' read -r link target kind; do
  [[ -n "$link" ]] || continue

  case "$kind" in
    tool:*)
      tool_wired "${kind#tool:}" || continue
      kind=required
      ;;
  esac
  if [[ "$kind" != required && ! -e "$link" && ! -L "$link" ]]; then
    continue
  fi
  if [[ "$kind" == optional-file && -f "$link" && ! -L "$link" ]]; then
    continue
  fi

  # A box without ~/.gemini is not drift, it is a box without that harness.
  # Skip on the PARENT being absent, so a missing link inside a directory that
  # DOES exist still reports.
  if [[ ! -d "$(dirname "$link")" ]]; then
    echo "note: $(dirname "$link") does not exist on this host, skipping $link" >&2
    n_skip=$((n_skip + 1))
    continue
  fi

  want="$(norm "$target")"
  raw=""
  got=""
  if [[ -L "$link" ]]; then
    raw="$(readlink "$link")"
    case "$raw" in
      /*) got="$(norm "$raw")" ;;
      *) got="$(norm "$(dirname "$link")/$raw")" ;;
    esac
  fi

  problem=""
  if [[ ! -L "$link" && -d "$link" ]]; then
    problem="is a real directory, not a symlink — a harness made the folder
    itself, or an earlier setup put a copy there"
  elif [[ ! -L "$link" && -e "$link" ]]; then
    problem="is a regular file, not a symlink — a harness wrote through and
    replaced the link, so the workbench copy is now stale"
  elif [[ ! -L "$link" ]]; then
    problem="is missing"
  elif [[ "$got" != "$want" ]]; then
    problem="points at ${raw}, not at the workbench copy"
  elif [[ ! -e "$link" ]]; then
    problem="is a DANGLING link to ${raw}"
  fi

  if [[ -z "$problem" ]]; then
    n_ok=$((n_ok + 1))
    continue
  fi

  if [[ "$FIX" -eq 1 ]]; then
    # `|| rc_relink=$?` and not a bare call: under `set -e` a non-zero from
    # relink kills the script before `case` ever sees it.
    rc_relink=0
    relink "$link" "$target" || rc_relink=$?
    case "$rc_relink" in
      0)
        echo "fixed: $link -> $target"
        n_ok=$((n_ok + 1))
        ;;
      2)
        err "Error: refusing to relink ${link} — its target does not exist:
      ${target}
    ${link} is LEFT AS IT IS, because a link to a missing folder leaves that
    harness with nothing to read. Install the layer first, then re-run --fix."
        ;;
      3)
        err "Error: refusing to relink ${link} — it is a real directory.
    Move it aside (the installer does: <path>.pre-link) and re-run --fix;
    this script does not copy or rename a directory."
        ;;
      *)
        err "Error: could not relink ${link} -> ${target}"
        ;;
    esac
    continue
  fi

  err "Error: ${link} ${problem}
    want: ${target}"
done <<< "$LINKS"

# ── The manifests ─────────────────────────────────────────────────────────
#
# Required (manifest, TOOL NAME, script) mappings. Asserting the TOOL rather
# than the matcher string is deliberate: a matcher is a regex, two spellings of
# the same set are both correct, and what actually matters is whether the tool
# a harness is about to run routes to the guard. Grok Build reads the same
# Claude-shape file Codex links to, under its own tool names; Gemini CLI's
# guards sit in its settings.json under BeforeTool.
INFRA="check-host-infra-safety.sh"
WRITE="check-shared-checkout-write.sh"
n_manifests=0

manifest_misses() {   # <shape: claude|gemini|agy> <manifest> <tool:script ...>
  local shape="$1" mf="$2" pair tool script groups
  case "$shape" in
    claude) groups='[.hooks.PreToolUse[]?]' ;;
    gemini) groups='[.hooks.BeforeTool[]?]' ;;
    *) groups='[.[] | objects | .PreToolUse[]?]' ;;
  esac
  for pair in $3; do
    tool="${pair%%:*}"
    script="${pair#*:}"
    if ! jq -e --arg t "$tool" --arg s "$script" "$groups"' | any(.[];
        ((.matcher // ".*") as $m | $t | test("^(" + $m + ")$"))
        and any(.hooks[]?; (.command // "") | contains($s)))' "$mf" >/dev/null 2>&1; then
      printf 'MISS\t%s\t%s\n' "$tool" "$script"
    fi
  done
}

check_manifest() {    # <label> <shape> <manifest> <tool:script ...>
  local label="$1" shape="$2" mf="$3" want="$4" out line tool script
  n_manifests=$((n_manifests + 1))
  if [[ ! -e "$mf" ]]; then
    err "Error: ${label} manifest missing at ${mf}"
    return
  fi
  if ! jq -e . "$mf" >/dev/null 2>&1; then
    err "Error: ${label} manifest at ${mf} is not readable JSON"
    return
  fi
  out="$(manifest_misses "$shape" "$mf" "$want")"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    tool="$(printf '%s' "$line" | cut -f2)"
    script="$(printf '%s' "$line" | cut -f3)"
    err "Error: ${label} manifest does not route ${tool} to ${script}.
    Either the guard is absent or its matcher does not match that tool."
  done <<< "$out"
}

CLAUDE_WANT="Bash:${INFRA} Bash:${WRITE} Edit:${WRITE} Write:${WRITE} MultiEdit:${WRITE} NotebookEdit:${WRITE}"
GROK_WANT="run_terminal_command:${INFRA} run_terminal_command:${WRITE} write:${WRITE} search_replace:${WRITE}"
GEMINI_WANT="run_shell_command:${INFRA} run_shell_command:${WRITE} write_file:${WRITE} replace:${WRITE}"
if ! command -v jq >/dev/null 2>&1; then
  echo "note: jq is not installed, so the hook manifests were not checked" >&2
else
  # Each manifest is asserted where its harness is wired: Claude Code's where
  # ~/.claude exists and tools= (if recorded) names it, Codex's and Grok Build's where their hooks file exists,
  # Gemini CLI's where this checkout's .gemini/settings.json exists, and
  # Antigravity's where .agents/hooks.json exists (the installer ships it only
  # while Antigravity is picked).
  if [[ -d "${H}/.claude" ]] && tool_wired claude; then
    check_manifest "Claude Code" claude "${H}/.claude/settings.json" "$CLAUDE_WANT"
  fi
  if [[ -e "${H}/.codex/hooks.json" ]]; then
    check_manifest "Codex" claude "${H}/.codex/hooks.json" "$CLAUDE_WANT apply_patch:${WRITE}"
    # Codex throws a manifest away whole when it carries any top-level key
    # besides `hooks` or `description` — both guards stop running there, with
    # no error anywhere.
    extra="$(jq -r 'keys - ["hooks", "description"] | join(", ")' "${H}/.codex/hooks.json" 2>/dev/null || true)"
    if [[ -n "$extra" ]]; then
      err "Error: ${H}/.codex/hooks.json carries top-level key(s) besides hooks: ${extra}
    Codex throws the WHOLE manifest away when it carries anything but hooks or
    description, so both guards stop running there."
    fi
  fi
  if [[ -e "${H}/.grok/hooks/contextium.json" ]]; then
    check_manifest "Grok Build" claude "${H}/.grok/hooks/contextium.json" "$GROK_WANT"
  fi
  if [[ -e "${HERE}/.gemini/settings.json" ]]; then
    check_manifest "Gemini CLI" gemini "${HERE}/.gemini/settings.json" "$GEMINI_WANT"
  fi
  if [[ -e "${HERE}/.agents/hooks.json" ]]; then
    check_manifest "Antigravity" agy "${HERE}/.agents/hooks.json" \
      "run_command:${INFRA} run_command:${WRITE} write_to_file:${WRITE} replace_file_content:${WRITE}"
  fi
fi

if [[ "$rc" -ne 0 ]]; then
  printf '%s' "$errors" >&2
  echo >&2
  echo "Relink with: bash $0 --fix" >&2
  echo "It moves any occupying file to <path>.pre-link first, so content a harness" >&2
  echo "wrote that has not reached the workbench yet is preserved rather than lost." >&2
  exit 1
fi

if [[ "$n_skip" -gt 0 ]]; then
  echo "OK — ${n_ok} links verified (${n_skip} skipped: no such home), ${n_manifests} manifests carry the required hooks"
else
  echo "OK — ${n_ok} links verified, ${n_manifests} manifests carry the required hooks"
fi
