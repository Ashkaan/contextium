#!/usr/bin/env bash
# corrections.sh — what the user actually typed in this thread, in their words.
#
# Every other section of a journal entry is the agent writing about its own
# session — lossy, and written by the party being graded. The Corrections
# section is the one part the agent does not author, so it must not be recalled
# from memory: a remembered quote is a paraphrase wearing quote marks.
#
# WHY THE T3 DATABASE FIRST. In T3 Code, `projection_thread_messages` is the one
# source every harness T3 runs writes to, because T3 is what renders the
# conversation — Claude Code, Codex and Antigravity alike, including one that
# keeps no session file of its own. OUTSIDE T3 — or in a thread the database
# does not know — the harness's own transcript is read instead, by
# transcripts.sh (Claude Code's and Codex's session files), with the same
# output shape.
#
# WHAT IS DROPPED, and why each is not something the user said:
#   - The citation links themselves. T3 inserts `[Assistant quote](t3-citation://…)`
#     when the user quotes the assistant back at it, and the quoted words are
#     the agent's. But the link's `comment=` parameter is NOT the agent's — it is
#     what the user typed about the quote, and it is often the sharpest line in
#     the session ("How can we prevent that?"). So the links are stripped and
#     their comments are kept as the user's words. Dropping the whole message,
#     which is what a citation-only filter does, silently loses those.
#   - Skill invocations. `$close`, `/implement foo bar` — an envelope, not a
#     turn. A message that invokes a skill AND says something keeps the
#     something.
#
# WHY ACTIVITIES ARE READ AS WELL AS MESSAGES. An `AskUserQuestion` answer is
# not a message — T3 records it on `projection_thread_activities` as
# `user-input.resolved`. Reading messages alone makes every such reply
# invisible, and those replies are often the ones that redirect a session ("Run
# the two serially instead"). A section whose whole purpose is the signal the
# agent did not author cannot be blind to the channel the user answers
# questions on.
#
# SELECTION VERSUS FREE TEXT, and why the row says which. The options were
# written by the agent; picking one is the user's decision but not their words.
# Free text ("Other") is their words. This is the same split the script already
# makes on a citation — `text=` is the agent's, `comment=` is the user's — so a
# chosen option is prefixed `[chose] ` and a free-text answer is emitted bare,
# like a typed turn. The journal may quote a bare row verbatim; a `[chose] ` row
# is reported as a choice the user made, never as something they said.
#
# WHAT IS NOT DROPPED: the judgment about which rows are corrections. That
# stays with the skill (`references/journal-entry.md` § Corrections) — keep the
# rows where the user corrected, redirected or rejected something; drop the ones
# that only move work along. A script cannot tell "next" from "no, not like that".
#
# Usage:
#   corrections.sh              — one `HH:MM <TAB> <first line>` row per turn
#   corrections.sh --full       — the whole turn, newlines escaped as \n, so a
#                                 correction that spans lines can be quoted
#                                 without truncating it
#   corrections.sh --thread <id>
#   corrections.sh --since <iso> --until <iso> --json
#                               — WINDOW MODE: every thread in the database, not
#                                 this one, keeping what the user said with
#                                 since <= created_at < until. One JSON object:
#                                 { since, until, threads: [{ thread_id, title,
#                                 harness, deleted, items: [{ at, text,
#                                 reply_to }] }] }. `text` is the --full turn
#                                 with real newlines; `reply_to` is the first
#                                 600 characters of the latest assistant message
#                                 in that thread before it, or null. Threads with
#                                 nothing kept are omitted; deleted threads are
#                                 kept and marked, because what the user said in
#                                 a thread they later threw away is still what
#                                 they said. Threads run oldest first by their first
#                                 item. A consumer in another repo validates this
#                                 with a strict schema, so add no key it lacks.
#                                 All three flags or none: --json means nothing
#                                 without a window, and a window has no
#                                 tab-separated shape.
#
# WHY ONE PROGRAM FOR BOTH MODES. The window mode exists so a reader of many
# threads gets exactly the rows a close would have journaled, not a second
# opinion about them. So the two queries, the merge, the `[chose] ` label, the
# citation and invocation filters are one function, `said()`, and each mode only
# chooses its scope and renders the result. A copy of that logic for the window
# would drift from the per-thread rows the first time either was fixed.
#
# Env:
#   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.sh (per-thread mode only;
#   window mode never resolves a thread). T3CODE_HOME also locates the database.
#
# peers:
#   .agents/skills/close/scripts/corrections.test.sh
#   .agents/skills/close/references/journal-entry.md  (the keep/drop rule)
#
# Exit: 0 ok (rows on stdout; none is a normal outcome) · 2 no thread, no db,
# or bad usage (including a window bound that is not a date)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THREAD="${SCRIPT_DIR}/thread.sh"
DB="${T3CODE_HOME:-${HOME}/.t3}/userdata/state.sqlite"

fail() { echo "corrections: $*" >&2; exit 2; }

USAGE="usage: corrections.sh [--full] [--thread <id>] | --since <iso> --until <iso> --json"

FULL=0
TID=""
JSON=0
SINCE=""
UNTIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full)   FULL=1; shift ;;
    --thread) TID="${2:?--thread needs an id}"; shift 2 ;;
    --since)  [ $# -ge 2 ] && [ -n "$2" ] || fail "${USAGE}"; SINCE="$2"; shift 2 ;;
    --until)  [ $# -ge 2 ] && [ -n "$2" ] || fail "${USAGE}"; UNTIL="$2"; shift 2 ;;
    --json)   JSON=1; shift ;;
    *) fail "${USAGE}" ;;
  esac
done

# Any one of the three window flags selects window mode, and then all three are
# required and nothing per-thread may ride along: a half-given window is a
# typo, and guessing the missing bound would silently widen or empty it.
MODE=thread
if [ "${JSON}" = 1 ] || [ -n "${SINCE}" ] || [ -n "${UNTIL}" ]; then
  [ "${JSON}" = 1 ] && [ -n "${SINCE}" ] && [ -n "${UNTIL}" ] || fail "${USAGE}"
  [ "${FULL}" = 0 ] && [ -z "${TID}" ] || fail "${USAGE}"
  MODE=window
fi

if [ "${MODE}" = thread ] && [ -z "${TID}" ]; then
  TID="$(bash "${THREAD}" --id 2>&1)" || fail "${TID#thread: }"
  # Not a thread the T3 database knows (or no T3 at all): the harness's own
  # transcript is the record. An explicit --thread, or the WORKBENCH_THREAD_ID
  # override, always means T3. "Knows" is a definite answer — a database that
  # cannot be read is reported below, not routed around.
  KNOWN=0
  if [ -n "${WORKBENCH_THREAD_ID:-}" ]; then
    KNOWN=1
  elif [ -f "${DB}" ]; then
    node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
let db;
try { db = new DatabaseSync(process.argv[1], { readOnly: true }); } catch { process.exit(0); }
for (const t of ["projection_threads", "projection_thread_messages"]) {
  try {
    if (db.prepare("select 1 from " + t + " where thread_id = ? limit 1").get(process.argv[2])) process.exit(0);
  } catch {}
}
process.exit(1);
' "${DB}" "${TID}" 2>/dev/null && KNOWN=1
  fi
  if [ "${KNOWN}" = 0 ]; then
    if [ "${FULL}" = 1 ]; then exec bash "${SCRIPT_DIR}/transcripts.sh" --full; fi
    exec bash "${SCRIPT_DIR}/transcripts.sh"
  fi
fi

[ -f "${DB}" ] || fail "no T3 database at ${DB}"

if [ "${MODE}" = thread ]; then ARGS=("${TID}" "${FULL}"); else ARGS=("${SINCE}" "${UNTIL}"); fi

# shellcheck disable=SC2016  # the JS below must reach node unexpanded —
# bash interpolating `$` inside it is the bug, not the quoting.
# Node 22 warns on stderr when node:sqlite loads; the flag, on every Node that
# has node:sqlite (22.5+), keeps the report free of it.
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
// thread mode: <db> thread <thread id> <full 0|1>
// window mode: <db> window <since> <until>
const [dbPath, mode, arg1, arg2] = process.argv.slice(1);

function die(message) {
  process.stderr.write("corrections: " + message + "\n");
  process.exit(2);
}

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (e) {
  die("cannot read " + dbPath + ": " + e.message);
}

function parse(json) {
  try {
    return JSON.parse(json ?? "");
  } catch {
    return null;
  }
}

// A citation T3 built, in either spelling: a markdown link around the scheme,
// or the bare scheme. More than one can share a line.
const CITATION_LINK = /\[[^\]]*\]\(t3-citation:\/\/[^)]*\)|t3-citation:\/\/\S+/g;

// `?text=` is the assistant sentence the user highlighted; `&comment=` is what
// they typed about it. Only the second is theirs.
function commentsIn(text) {
  const out = [];
  for (const link of text.match(CITATION_LINK) ?? []) {
    const query = link.slice(link.indexOf("?") + 1).replace(/\)$/, "");
    if (!link.includes("?")) continue;
    for (const pair of query.split("&")) {
      const [key, ...rest] = pair.split("=");
      if (key !== "comment") continue;
      let value = "";
      try {
        value = decodeURIComponent(rest.join("=").replace(/\+/g, " "));
      } catch {
        value = rest.join("=");
      }
      if (value.trim() !== "") out.push(value.trim());
    }
  }
  return out;
}

// The whole turn is one skill invocation: `$close`, `/implement a b`.
//
// BIASED TOWARDS KEEPING, deliberately. The judgment filter in the skill can
// drop a stray invocation that got through — "drop rows that only move work
// along" — but nothing downstream can recover a real correction this threw
// away. So a turn only counts as an invocation when what follows the command
// looks like ARGUMENTS: at most four tokens, each slug-shaped. The first cut
// matched any words at all after the command and swallowed "/close but first
// tell me why the push failed", which is a correction, not an envelope.
const COMMAND = /^[/$][a-zA-Z][a-zA-Z0-9_-]*$/;
const SLUG_ARG = /^[A-Za-z0-9._/@=+-]+$/;

function isInvocationOnly(line) {
  const tokens = line.trim().split(/\s+/);
  if (!COMMAND.test(tokens[0])) return false;
  const args = tokens.slice(1);
  return args.length <= 4 && args.every((a) => SLUG_ARG.test(a));
}

// Everything the user said, in one thread (`tid`) or in all of them (`tid` null),
// as one timeline. Each entry is either a typed turn — `kept`, its surviving
// lines, citation comments first — or an `answer` to a question prompt. The
// modes differ only in how an entry is rendered, never in which survive.
function said(tid) {
  const scope = tid === null ? "" : "thread_id = ? and ";
  const scoped = tid === null ? [] : [tid];

  const rows = db
    .prepare(
      "select thread_id, text, created_at from projection_thread_messages " +
        "where " + scope + "role = ? order by created_at",
    )
    .all(...scoped, "user");

  // The AskUserQuestion channel. `user-input.requested` carries the options
  // the agent offered; `user-input.resolved` carries what the user chose, keyed by the
  // same requestId.
  const activities = db
    .prepare(
      "select thread_id, kind, payload_json, created_at from projection_thread_activities " +
        "where " + scope + "kind in (?, ?) order by created_at",
    )
    .all(...scoped, "user-input.requested", "user-input.resolved");

  // (thread, requestId) -> every option label offered in that request. The
  // thread is part of the key because a requestId is only known to be unique
  // within its own thread, and the window mode reads all of them at once.
  const key = (row, payload) => row.thread_id + "\u0000" + payload.requestId;
  const offered = new Map();
  for (const row of activities) {
    if (row.kind !== "user-input.requested") continue;
    const payload = parse(row.payload_json);
    if (!payload?.requestId) continue;
    const labels = offered.get(key(row, payload)) ?? new Set();
    for (const question of payload.questions ?? []) {
      for (const option of question.options ?? []) {
        if (typeof option?.label === "string") labels.add(option.label.trim());
      }
    }
    offered.set(key(row, payload), labels);
  }

  const out = [];

  for (const row of rows) {
    const raw = String(row.text ?? "");
    const kept = [
      ...commentsIn(raw),
      ...raw
        .replace(CITATION_LINK, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ];
    if (kept.length === 0) continue;
    if (kept.length === 1 && isInvocationOnly(kept[0])) continue;
    out.push({ thread_id: row.thread_id, created_at: row.created_at, kept });
  }

  // One entry per answer, tagged by whether the user picked wording the agent
  // wrote or supplied their own. An unmatched requestId means the request was never
  // recorded — treat the answer as free text rather than dropping it, per the
  // keep-biased rule.
  for (const row of activities) {
    if (row.kind !== "user-input.resolved") continue;
    const payload = parse(row.payload_json);
    if (!payload?.answers) continue;
    const labels = offered.get(key(row, payload)) ?? new Set();
    for (const value of Object.values(payload.answers)) {
      const answer = String(value ?? "").trim();
      if (answer === "") continue;
      out.push({
        thread_id: row.thread_id,
        created_at: row.created_at,
        answer: labels.has(answer) ? "[chose] " + answer : answer,
      });
    }
  }

  // One timeline, in the order the user said them — a typed turn and an answer
  // to a question are both things they said, and separating them would misrepresent
  // the shape of the conversation. The sort is stable, so a turn and an answer
  // sharing a timestamp keep turns first.
  out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return out;
}

if (mode === "thread") {
  const full = arg2 === "1";
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  for (const entry of said(arg1)) {
    const body = entry.kept
      ? (full ? entry.kept.join("\n").replace(/\n/g, "\\n") : entry.kept[0]).trim()
      : entry.answer.replace(/\n/g, full ? "\\n" : " ").trim();
    process.stdout.write(time.format(new Date(entry.created_at)) + "\t" + body + "\n");
  }
  process.exit(0);
}

// ── Window mode ────────────────────────────────────────────────────────────
//
// The bounds are compared as normalised ISO instants, not as the strings as
// typed: `2026-09-22T00:00:00Z` sorts AFTER the stored
// `2026-09-22T00:00:00.000Z` (`.` < `Z`), so a raw string compare would drop a
// row stamped exactly on the lower bound. The object echoes them as given.
// A calendar check as well as a parse: `new Date("2026-02-30T00:00:00Z")` is a
// valid instant (March 2), so a typo would silently move the window rather than
// fail. The Y-M-D as typed must survive as a real day.
function instant(flag, value) {
  const at = new Date(value);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (Number.isNaN(at.getTime()) || !ymd) die(flag + " is not a date: " + value);
  const day = new Date(Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3]));
  if (day.getUTCFullYear() !== +ymd[1] || day.getUTCMonth() !== +ymd[2] - 1 || day.getUTCDate() !== +ymd[3]) {
    die(flag + " is not a date: " + value);
  }
  return at.toISOString();
}
const since = instant("--since", arg1);
const until = instant("--until", arg2);
// A reversed or empty window would print an empty list, which reads exactly
// like "the user said nothing" — so it is refused, not answered.
if (since >= until) die("--since must be before --until: " + arg1 + " is not before " + arg2);

const threadRow = db.prepare(
  "select title, deleted_at from projection_threads where thread_id = ?",
);
const sessionRow = db.prepare(
  "select provider_name from projection_thread_sessions where thread_id = ?",
);
// What the user was answering: the latest assistant message in the thread strictly
// before this item. Stored timestamps share one ISO shape, so the string
// compare in SQL is an instant compare.
const replyRow = db.prepare(
  "select text from projection_thread_messages " +
    "where thread_id = ? and role = ? and created_at < ? " +
    "order by created_at desc limit 1",
);

// Map insertion order is first-item order, because said() is already sorted.
const threads = new Map();
for (const entry of said(null)) {
  const at = new Date(entry.created_at);
  if (Number.isNaN(at.getTime())) continue;
  const iso = at.toISOString();
  if (iso < since || iso >= until) continue;

  let thread = threads.get(entry.thread_id);
  if (!thread) {
    const meta = threadRow.get(entry.thread_id);
    const session = sessionRow.get(entry.thread_id);
    thread = {
      thread_id: entry.thread_id,
      title: meta?.title ?? "",
      harness: session?.provider_name || "unknown",
      deleted: meta?.deleted_at != null,
      items: [],
    };
    threads.set(entry.thread_id, thread);
  }

  const reply = replyRow.get(entry.thread_id, "assistant", entry.created_at);
  thread.items.push({
    at: entry.created_at,
    // The --full body with its newlines left real: JSON escapes them itself.
    text: (entry.kept ? entry.kept.join("\n") : entry.answer).trim(),
    reply_to: reply ? String(reply.text ?? "").slice(0, 600) : null,
  });
}

process.stdout.write(
  JSON.stringify({ since: arg1, until: arg2, threads: [...threads.values()] }) + "\n",
);
' "${DB}" "${MODE}" ${ARGS[@]+"${ARGS[@]}"}
