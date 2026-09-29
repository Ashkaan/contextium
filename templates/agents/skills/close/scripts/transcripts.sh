#!/usr/bin/env bash
# transcripts.sh — corrections.sh's rows for a session T3 Code did not record:
# the user's own turns, read from the harness's own transcript file.
#
# corrections.sh reads T3 Code's database, which renders every harness T3 runs.
# A session outside T3 has no row there, so its record is the harness's own
# session file — whichever exists, first match wins:
#
#   claude  ~/.claude/projects/<dir>/<session>.jsonl — by CLAUDE_CODE_SESSION_ID
#           when the shell has one (an id with no record is no record), else
#           the newest one for this worktree or its main checkout. Claude
#           Code names the folder after the directory, every character that is
#           not a letter or digit turned into `-`.
#   codex   ~/.codex/sessions/**/rollout-*.jsonl — the one whose session id is
#           CODEX_THREAD_ID (or CODEX_SESSION_ID) when the shell has one, else
#           the newest from the last two days whose session ran in this
#           worktree or its main checkout. Two Codex sessions in one tree are
#           told apart only by the id, so an id with no record is no record.
#
# The same drops as corrections.sh, for the same reasons: tool results, the
# harness's injected instructions and reminders, and a turn that is nothing but
# a skill invocation. An answer given through a question prompt is prefixed
# `[answered] ` — Claude Code's record does not say whether it was one of the
# agent's options or the user's own words, so it is never quoted as theirs.
#
# Usage:
#   transcripts.sh [--full] [--source claude|codex]
#     one `HH:MM <TAB> <first line>` row per turn, local time;
#     --full prints the whole turn with newlines escaped as \n
#
# Env: CLAUDE_CONFIG_DIR (~/.claude), CODEX_HOME (~/.codex), CLAUDE_CODE_SESSION_ID,
#      CODEX_THREAD_ID / CODEX_SESSION_ID.
#
# Exit: 0 rows on stdout (none is a normal outcome) · 2 no transcript found for
#       this session, no Node, or bad usage. The file read goes to stderr.
#
# peers:
#   .agents/skills/close/scripts/transcripts.test.sh
#   .agents/skills/close/scripts/corrections.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "corrections: $*" >&2; exit 2; }

FULL=0
SOURCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full) FULL=1 ;;
    --source) SOURCE="${2:-}"; shift; [[ "$SOURCE" =~ ^(claude|codex)$ ]] || fail "--source is claude or codex" ;;
    *) fail "usage: transcripts.sh [--full] [--source claude|codex]" ;;
  esac
  shift
done
command -v node >/dev/null 2>&1 || fail "needs Node to read the session record"

TOP="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; TOP="$(cd "$TOP" && pwd -P)"
MAIN="$(bash "$SCRIPT_DIR/write-root.sh" --main . 2>/dev/null || printf '%s' "$TOP")"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"

claude_file() {
  local sid="${CLAUDE_CODE_SESSION_ID:-}" f d slug
  if [[ -n "$sid" ]]; then
    # The session's own transcript, or none: an id with no record is a lookup
    # that failed, never a reason to read the newest one in this tree.
    for f in "$CLAUDE_DIR"/projects/*/"$sid".jsonl; do [[ -f "$f" ]] && { printf '%s' "$f"; return 0; }; done
    return 1
  fi
  for d in "$TOP" "$MAIN"; do
    slug="$(printf '%s' "$d" | sed 's/[^A-Za-z0-9]/-/g')"
    # shellcheck disable=SC2012  # newest by mtime; the names are uuids
    f="$(ls -t "$CLAUDE_DIR/projects/$slug"/*.jsonl 2>/dev/null | head -n 1)"
    [[ -n "$f" ]] && { printf '%s' "$f"; return 0; }
  done
  return 1
}
codex_file() {
  [[ -d "$CODEX_DIR/sessions" ]] || return 1
  local cid="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}"
  if [[ -n "$cid" ]]; then
    # The session's own record: its session_meta names the id (the file name
    # usually carries it too, but the record is what is read). An id with no
    # record is a lookup that failed — never a reason to read the newest
    # rollout in this tree, which may be another session's.
    find "$CODEX_DIR/sessions" -name 'rollout-*.jsonl' 2>/dev/null | node -e '
      const fs = require("fs");
      const want = process.argv[1];
      for (const f of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) {
        try {
          const meta = JSON.parse(fs.readFileSync(f, "utf8").split("\n", 1)[0]);
          if (meta?.payload?.id === want) { process.stdout.write(f); process.exit(0); }
        } catch {}
      }
      process.exit(1);
    ' "$cid"
    return
  fi
  find "$CODEX_DIR/sessions" -name 'rollout-*.jsonl' -mtime -2 2>/dev/null | node -e '
    const fs = require("fs");
    const want = new Set(process.argv.slice(1));
    const files = fs.readFileSync(0, "utf8").split("\n").filter(Boolean)
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files) {
      const first = fs.readFileSync(f, "utf8").split("\n", 1)[0];
      try {
        const cwd = JSON.parse(first)?.payload?.cwd;
        if (cwd && want.has(fs.realpathSync(cwd))) { process.stdout.write(f); process.exit(0); }
      } catch {}
    }
    process.exit(1);
  ' "$TOP" "$MAIN"
}

KIND="" ARG=""
# AN EXPLICIT SESSION ID IS THE ANSWER OR NOTHING, for either harness. With an
# id, the record is that session's file; if it is missing the lookup fails
# rather than falling back to the newest transcript in this tree, or to the
# other harness's — either could be another session's words, quoted in the
# journal as this user's. Only with no id at all is the newest record for this
# tree the answer, Codex first (it records the directory it ran in).
CL_ID="${CLAUDE_CODE_SESSION_ID:-}"
CX_ID="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}"
if [[ ( -z "$SOURCE" || "$SOURCE" == claude ) && -n "$CL_ID" ]]; then
  F="$(claude_file)" || fail "no Claude Code record of session $CL_ID"
  KIND=claude; ARG="$F"
elif [[ ( -z "$SOURCE" || "$SOURCE" == codex ) && -n "$CX_ID" ]]; then
  F="$(codex_file)" || fail "no Codex record of session $CX_ID"
  KIND=codex; ARG="$F"
else
  if [[ -z "$SOURCE" || "$SOURCE" == codex ]]; then
    F="$(codex_file)" && { KIND=codex; ARG="$F"; }
  fi
  if [[ -z "$KIND" && ( -z "$SOURCE" || "$SOURCE" == claude ) ]]; then
    F="$(claude_file)" && { KIND=claude; ARG="$F"; }
  fi
fi
[[ -n "$KIND" ]] || fail "no record of this session found (${SOURCE:-T3 Code, Claude Code or Codex}) for $TOP"
echo "corrections: source $KIND ($ARG)" >&2

# shellcheck disable=SC2016  # the JavaScript must reach node unexpanded
node -e '
const fs = require("fs");
const [kind, file, full] = process.argv.slice(1);

// A turn that is nothing but a skill invocation: at most four slug-shaped
// arguments after the command, the same rule corrections.sh applies.
const COMMAND = /^[/$][a-zA-Z][a-zA-Z0-9_:-]*$/;
const SLUG_ARG = /^[A-Za-z0-9._/@=+-]+$/;
const invocationOnly = (s) => {
  const t = s.trim().split(/\s+/);
  return COMMAND.test(t[0]) && t.length <= 5 && t.slice(1).every((a) => SLUG_ARG.test(a));
};
// What a harness injects into a user turn, not what the user typed.
const INJECTED = /^(<(system-reminder|command-name|command-message|command-args|local-command-std(out|err)|environment_context|user_instructions|INSTRUCTIONS)\b|# AGENTS\.md instructions|Caveat: The messages below)/;
const clean = (text) => String(text ?? "")
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
  .split("\n").map((l) => l.trimEnd()).join("\n").trim();

const out = [];
const add = (at, text) => {
  text = clean(text);
  if (!text || INJECTED.test(text) || invocationOnly(text)) return;
  out.push({ at, text });
};
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

if (kind === "claude") {
  for (const r of rows) {
    if (r.type !== "user" || r.isMeta || r.isSidechain) continue;
    const c = r.message?.content;
    if (typeof c === "string") { add(r.timestamp, c); continue; }
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (part?.type === "text") add(r.timestamp, part.text);
      else if (part?.type === "tool_result") {
        const t = typeof part.content === "string" ? part.content
          : Array.isArray(part.content) ? part.content.map((x) => x?.text ?? "").join("\n") : "";
        const m = /^User has answered your questions?:\s*([\s\S]*)$/.exec(t.trim());
        if (m) add(r.timestamp, "[answered] " + m[1]);
      }
    }
  }
} else {
  // Newer Codex logs each typed turn as an event; older ones only as a
  // response item, among the instructions it injects.
  const events = rows.filter((r) => r.type === "event_msg" &&
    (r.payload?.type === "user_message" || (r.payload?.type === "item_completed" && r.payload?.item?.type === "UserMessage")));
  if (events.length) {
    for (const r of events) {
      if (r.payload.type === "user_message") add(r.timestamp, r.payload.message);
      else add(r.timestamp, (r.payload.item.content ?? []).map((x) => x?.text ?? "").join("\n"));
    }
  } else {
    for (const r of rows) {
      const p = r.payload;
      if (r.type !== "response_item" || p?.type !== "message" || p?.role !== "user") continue;
      add(r.timestamp, (p.content ?? []).map((x) => x?.text ?? "").join("\n"));
    }
  }
}

out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
const pad = (n) => String(n).padStart(2, "0");
for (const { at, text } of out) {
  const t = new Date(at);
  const hhmm = Number.isNaN(t.getTime()) ? "--:--" : pad(t.getHours()) + ":" + pad(t.getMinutes());
  const body = full === "1" ? text.replace(/\n/g, "\\n") : text.split("\n").find((l) => l.trim()) ?? "";
  process.stdout.write(hhmm + "\t" + body + "\n");
}
' "$KIND" "$ARG" "$FULL" || fail "could not read $ARG"
