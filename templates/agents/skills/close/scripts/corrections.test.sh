#!/usr/bin/env bash
# corrections.test.sh — what survives the filter, and what each row looks like.
#
# Run: bash .agents/skills/close/scripts/corrections.test.sh
#
# The fixture database carries the message shapes T3 really writes, including
# a turn carrying two citations on one line.

set -uo pipefail
# Local time is the rows' clock; the fixtures' times are written for this zone.
export TZ=America/Los_Angeles

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/corrections.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', wanted '$3'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1: '$2' lacks '$3'" ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1: '$2' should not contain '$3'" ;; *) ok "$1" ;; esac; }

T3="${TMP}/t3"
mkdir -p "${T3}/userdata"
TID=ffffffff-1111-2222-3333-777777777777
OTHER=99999999-1111-2222-3333-888888888888

CITE1='[Assistant quote](t3-citation://v1/a/b/c?text=The+library+commit+swept&start=1&comment=How+can+we+prevent+that%3F)'
CITE2='[Assistant quote](t3-citation://v1/a/b/c?text=app-health.sh+exited+2&comment=what+hooks+do+we+need%2C+and+why%3F)'
NOCOMMENT='[Assistant quote](t3-citation://v1/a/b/c?text=just+a+quote&start=5&end=9)'

# shellcheck disable=SC2016  # the JS below must reach node unexpanded —
# bash interpolating `$` inside it is the bug, not the quoting.
node -e '
const { DatabaseSync } = require("node:sqlite");
const [dbPath, tid, other, cite1, cite2, nocomment] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(`create table projection_thread_messages (
  message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT,
  role TEXT NOT NULL, text TEXT NOT NULL, is_streaming INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
const ins = db.prepare(`insert into projection_thread_messages
  (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
  values (?,?,?,?,?,0,?,?)`);
let n = 0;
const add = (thread, role, text, at) =>
  ins.run("m" + n++, thread, "t", role, text, at, at);

// 03:15 UTC on the 14th is 20:15 on the 13th in Los Angeles.
add(tid, "user", "This is way too long.  What are my options simply?", "2026-09-14T03:15:00.000Z");
add(tid, "assistant", "a long answer nobody asked to be quoted", "2026-09-14T03:16:00.000Z");
add(tid, "user", "$close", "2026-09-14T03:17:00.000Z");
add(tid, "user", "/implement checkout-flow r2", "2026-09-14T03:18:00.000Z");
add(tid, "user", cite1 + " " + cite2, "2026-09-14T03:19:00.000Z");
add(tid, "user", nocomment, "2026-09-14T03:20:00.000Z");
add(tid, "user", nocomment + "\nso what do we do about it?", "2026-09-14T03:21:00.000Z");
add(tid, "user", "Close should create the work tree.\n\nAre you sure this is the right shape?",
  "2026-09-14T03:22:00.000Z");
add(tid, "user", "/close but first tell me why the push failed", "2026-09-14T03:23:00.000Z");
add(other, "user", "a turn in somebody else thread", "2026-09-14T03:24:00.000Z");

// The AskUserQuestion channel. T3 records the offered options on
// `user-input.requested` and the answer given on `user-input.resolved`, keyed by
// requestId. An answer equal to an offered label is a SELECTION (the agent wrote
// those words); anything else is free text the user typed.
db.exec(`create table projection_thread_activities (
  activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT,
  tone TEXT, kind TEXT NOT NULL, summary TEXT, payload_json TEXT,
  created_at TEXT NOT NULL, sequence INTEGER)`);
const act = db.prepare(`insert into projection_thread_activities
  (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
  values (?,?,?,?,?,?,?,?,?)`);
let a = 0;
const addAct = (thread, kind, payload, at) =>
  act.run("a" + a++, thread, "t", "info", kind, "s", JSON.stringify(payload), at, a);

const Q1 = "Keep the fold shard or drop it?";
const Q2 = "Do you ever use a bare /loop?";
addAct(tid, "user-input.requested", { requestId: "r1", questions: [
  { id: Q1, question: Q1, options: [
    { label: "Keep the fold shard (Recommended)", description: "d" },
    { label: "Run the two serially instead", description: "d" }] },
  { id: Q2, question: Q2, options: [
    { label: "Always a fixed interval", description: "d" }] },
]}, "2026-09-14T03:25:00.000Z");
addAct(tid, "user-input.resolved", { requestId: "r1", answers: {
  [Q1]: "Run the two serially instead",
  [Q2]: "I never use loop at all.",
}}, "2026-09-14T03:26:00.000Z");
addAct(other, "user-input.resolved", { requestId: "r9", answers: {
  "someone else question": "someone else answer" }}, "2026-09-14T03:27:00.000Z");
' "${T3}/userdata/state.sqlite" "${TID}" "${OTHER}" "${CITE1}" "${CITE2}" "${NOCOMMENT}"

E=("T3CODE_HOME=${T3}" "HOME=${TMP}/home" "WORKBENCH_THREAD_ID=${TID}")

OUT="$(env ${E[@]+"${E[@]}"} bash "${SCRIPT}" 2>&1)"
RC=$?
FULL="$(env ${E[@]+"${E[@]}"} bash "${SCRIPT}" --full 2>&1)"

is "exits 0" "${RC}" "0"

# ── Ordinary turns ─────────────────────────────────────────────────────────

has "a typed turn is one row, local time first" "${OUT}" \
  "$(printf '20:15\tThis is way too long.  What are my options simply?')"

has "a multi-line turn prints its first line" "${OUT}" \
  "$(printf '20:22\tClose should create the work tree.')"
hasnt "…and not its later lines" "${OUT}" "Are you sure this is the right shape?"

has "--full keeps every line, newlines escaped" "${FULL}" \
  'Close should create the work tree.\nAre you sure this is the right shape?'

# ── Skill invocations are envelopes, not turns ─────────────────────────────

# shellcheck disable=SC2016  # `$close` is the literal text of a skill
# invocation being asserted on, not a variable.
hasnt "a bare \$close is dropped" "${OUT}" '$close'
hasnt "a slash invocation with arguments is dropped" "${OUT}" "harness-config-parity"
has "an invocation that also says something keeps the something" "${OUT}" \
  "but first tell me why the push failed"

# ── Citations ──────────────────────────────────────────────────────────────

has "a citation's comment is the user's words and is kept" "${OUT}" \
  "$(printf '20:19\tHow can we prevent that?')"
has "two citations on one line both yield their comments" "${FULL}" \
  'How can we prevent that?\nwhat hooks do we need, and why?'
hasnt "the quoted assistant text is never attributed to the user" "${OUT}" \
  "The library commit swept"
hasnt "…nor the second quote" "${OUT}" "app-health.sh exited 2"
hasnt "a citation with no comment is dropped entirely" "${OUT}" "just a quote"
has "a citation with no comment still keeps the prose beside it" "${OUT}" \
  "$(printf '20:21\tso what do we do about it?')"

# ── Scope ──────────────────────────────────────────────────────────────────

hasnt "another thread's turns are not this thread's" "${OUT}" "somebody else"
hasnt "assistant rows are not corrections" "${OUT}" "a long answer"

# Seven rows survive: five of the nine typed turns (the two invocations and the
# comment-less citation are the four that do not), plus the two AskUserQuestion
# answers.
is "every kept row and no more" "$(printf '%s\n' "${OUT}" | grep -c .)" "7"

# ── Ordering ───────────────────────────────────────────────────────────────

is "rows come out in the order the user said them" \
  "$(printf '%s\n' "${OUT}" | cut -f1 | tr '\n' ' ')" \
  "20:15 20:19 20:21 20:22 20:23 20:26 20:26 "

# ── AskUserQuestion answers ─────────────────────────────────────────────
#
# Replies given through a question prompt are activities, not messages, and a
# script reading messages alone never sees them. The Corrections section is the
# one part of a journal entry the agent does not author, so a blind spot here loses
# exactly the signal it exists to carry.

has "a free-text answer is kept as the user's words" "${OUT}" "I never use loop at all."
has "a chosen option is kept, marked as a choice" "${OUT}" "[chose] Run the two serially instead"
hasnt "another thread's answers stay out" "${OUT}" "someone else answer"
hasnt "an offered option the user did not pick is not a row" "${OUT}" "Always a fixed interval"
hasnt "the question text is not a row" "${OUT}" "Do you ever use a bare"

# A selection is the agent's wording that the user picked; free text is their
# own. Same distinction the script already makes between a citation's `text=`
# (the agent's) and its `comment=` (the user's) — it decides whether the journal may quote the row
# or must report it as a choice.
hasnt "free text is not marked as a choice" "${OUT}" "[chose] I never use loop"

has "answers carry a time like every other row" "${OUT}" "20:26"

# ── A thread nobody typed in ───────────────────────────────────────────────

EMPTY="$(env "T3CODE_HOME=${T3}" "HOME=${TMP}/home" "WORKBENCH_THREAD_ID=${OTHER}" \
  bash "${SCRIPT}" --thread no-such-thread 2>&1)"
is "a thread with no turns prints nothing" "${EMPTY}" ""

# ── A missing database is named, not guessed around ────────────────────────

MISS="$(env "T3CODE_HOME=${TMP}/nowhere" "HOME=${TMP}/home" \
  "WORKBENCH_THREAD_ID=${TID}" bash "${SCRIPT}" 2>&1)"
MISS_RC=$?
is "a missing database exits 2" "${MISS_RC}" "2"
has "naming the path it tried" "${MISS}" "${TMP}/nowhere/userdata/state.sqlite"

# ── Window mode: every thread, one JSON object (added 2026-09-23) ──────────
#
# A reader of many threads must get the rows a close would have journaled,
# so this fixture reuses the shapes above — a chosen option, a citation
# comment, an invocation — across threads on three harnesses, and adds what
# only the window can get wrong: its two bounds, deleted and assistant-only
# threads, missing metadata, and the assistant message each row answered.

W3="${TMP}/w3"
mkdir -p "${W3}/userdata"
WDB="${W3}/userdata/state.sqlite"
WA=aaaaaaaa-0000-0000-0000-000000000001   # claudeAgent
WB=bbbbbbbb-0000-0000-0000-000000000002   # codex, deleted
WC=cccccccc-0000-0000-0000-000000000003   # grok
WD=dddddddd-0000-0000-0000-000000000004   # assistant only
WE=eeeeeeee-0000-0000-0000-000000000005   # typed only outside the window
WF=ffffffff-0000-0000-0000-000000000006   # no thread row, no session row

# shellcheck disable=SC2016  # the JS below must reach node unexpanded.
node -e '
const { DatabaseSync } = require("node:sqlite");
const [dbPath, A, B, C, D, E, F, cite] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(`create table projection_thread_messages (
  message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT,
  role TEXT NOT NULL, text TEXT NOT NULL, is_streaming INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
db.exec(`create table projection_thread_activities (
  activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT,
  tone TEXT, kind TEXT NOT NULL, summary TEXT, payload_json TEXT,
  created_at TEXT NOT NULL, sequence INTEGER)`);
db.exec(`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`);
db.exec(`create table projection_thread_sessions (
  thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, provider_name TEXT,
  updated_at TEXT NOT NULL)`);
const ins = db.prepare(`insert into projection_thread_messages
  (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
  values (?,?,?,?,?,0,?,?)`);
let n = 0;
const add = (thread, role, text, at) => ins.run("m" + n++, thread, "t", role, text, at, at);
const act = db.prepare(`insert into projection_thread_activities
  (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
  values (?,?,?,?,?,?,?,?,?)`);
let a = 0;
const addAct = (thread, kind, payload, at) =>
  act.run("a" + a++, thread, "t", "info", kind, "s", JSON.stringify(payload), at, a);
const thr = db.prepare("insert into projection_threads values (?,?,?,?,?,?)");
const ses = db.prepare("insert into projection_thread_sessions values (?,?,?,?)");
const T0 = "2026-09-20T00:00:00.000Z";
thr.run(A, "p", "Alpha thread", T0, T0, null);
thr.run(B, "p", "Bravo thread", T0, T0, "2026-09-22T20:00:00.000Z");
thr.run(C, "p", "Charlie thread", T0, T0, null);
thr.run(D, "p", "Delta thread", T0, T0, null);
thr.run(E, "p", "Echo thread", T0, T0, null);
ses.run(A, "idle", "claudeAgent", T0);
ses.run(B, "idle", "codex", T0);
ses.run(C, "idle", "grok", T0);
ses.run(D, "idle", "claudeAgent", T0);

// Alpha: a 700-character assistant turn answered on the lower bound itself,
// then a short one answered with a citation comment. Rows either side of the
// window, and one exactly on the upper bound, stay out.
add(A, "user", "typed before the window", "2026-09-21T23:59:59.999Z");
add(A, "assistant", "L".repeat(599) + "M" + "overflow".repeat(100), "2026-09-21T23:59:59.000Z");
add(A, "user", "on the lower bound\nand a second line", "2026-09-22T00:00:00.000Z");
add(A, "assistant", "short answer", "2026-09-22T06:00:00.000Z");
add(A, "user", cite, "2026-09-22T07:00:00.000Z");
add(A, "assistant", "an answer after the last turn", "2026-09-22T07:30:00.000Z");
add(A, "user", "on the upper bound", "2026-09-23T00:00:00.000Z");

// Charlie: an invocation (dropped) and a typed turn with no assistant before it.
add(C, "user", "$close", "2026-09-22T04:00:00.000Z");
add(C, "user", "grok turn with nothing before it", "2026-09-22T05:00:00.000Z");
add(C, "assistant", "grok answer", "2026-09-22T05:01:00.000Z");

// Bravo: the question was asked BEFORE the window and answered inside it, so
// the offered options must be read unwindowed or the choice reads as free text.
add(B, "assistant", "which way?", "2026-09-21T22:00:00.000Z");
addAct(B, "user-input.requested", { requestId: "r1", questions: [
  { id: "q", question: "q", options: [{ label: "Run them serially", description: "d" }] },
  { id: "q2", question: "q2", options: [{ label: "Unpicked option", description: "d" }] }]},
  "2026-09-21T22:00:01.000Z");
addAct(B, "user-input.resolved", { requestId: "r1", answers: {
  q: "Run them serially", q2: "my own words" }}, "2026-09-22T12:00:00.000Z");

add(D, "assistant", "delta talks to itself", "2026-09-22T09:00:00.000Z");
add(E, "user", "echo typed only tomorrow", "2026-09-23T09:00:00.000Z");
add(F, "user", "a thread T3 no longer has a row for", "2026-09-22T13:00:00.000Z");
' "${WDB}" "${WA}" "${WB}" "${WC}" "${WD}" "${WE}" "${WF}" "${CITE1}"

# No WORKBENCH_THREAD_ID: window mode must never ask thread.sh for one.
WE_=("T3CODE_HOME=${W3}" "HOME=${TMP}/home")
WIN="$(env ${WE_[@]+"${WE_[@]}"} bash "${SCRIPT}" --since 2026-09-22T00:00:00Z --until 2026-09-23T00:00:00Z --json 2>&1)"
WIN_RC=$?
is "window mode exits 0 with no thread to resolve" "${WIN_RC}" "0"

# q '<js expression over j>' — read one value out of the window object.
q() { printf '%s' "${WIN}" | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const v = new Function("j", "return " + process.argv[1])(j);
  process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));' "$1" 2>&1; }

is "the bounds are echoed as given" "$(q '[j.since, j.until]')" \
  '["2026-09-22T00:00:00Z","2026-09-23T00:00:00Z"]'
is "exactly the contract keys at the top" "$(q 'Object.keys(j)')" '["since","until","threads"]'
is "exactly the contract keys on a thread" "$(q 'Object.keys(j.threads[0])')" \
  '["thread_id","title","harness","deleted","items"]'
is "exactly the contract keys on an item" "$(q 'Object.keys(j.threads[0].items[0])')" \
  '["at","text","reply_to"]'

is "threads with a kept row, oldest first item first; assistant-only and out-of-window threads omitted" \
  "$(q 'j.threads.map(t => t.thread_id)')" "[\"${WA}\",\"${WC}\",\"${WB}\",\"${WF}\"]"
is "each thread names its harness, unknown when T3 has no session" \
  "$(q 'j.threads.map(t => t.harness)')" '["claudeAgent","grok","codex","unknown"]'
is "titles come from the thread row, empty when there is none" \
  "$(q 'j.threads.map(t => t.title)')" '["Alpha thread","Charlie thread","Bravo thread",""]'
is "a deleted thread is kept and marked" "$(q 'j.threads.map(t => t.deleted)')" \
  '[false,false,true,false]'

is "the window keeps its lower bound and drops its upper, and rows outside it" \
  "$(q 'j.threads[0].items.map(i => i.at)')" \
  '["2026-09-22T00:00:00.000Z","2026-09-22T07:00:00.000Z"]'
is "text is the whole turn with real newlines" "$(q 'j.threads[0].items[0].text')" \
  "$(printf 'on the lower bound\nand a second line')"
is "a citation is reduced to its comment" "$(q 'j.threads[0].items[1].text')" \
  "How can we prevent that?"
is "an invocation is dropped here too" "$(q 'j.threads[1].items.map(i => i.text)')" \
  '["grok turn with nothing before it"]'
is "an answer to an option offered before the window is still a choice" \
  "$(q 'j.threads[2].items.map(i => i.text)')" '["[chose] Run them serially","my own words"]'

is "reply_to is the earlier assistant turn cut to 600 characters" \
  "$(q 'j.threads[0].items[0].reply_to')" "$(printf 'L%.0s' $(seq 599))M"
is "reply_to is the LATEST earlier assistant turn, not a later one" \
  "$(q 'j.threads[0].items[1].reply_to')" "short answer"
is "reply_to is null when nothing came before" "$(q 'j.threads[1].items[0].reply_to')" "null"
is "an answer pairs with the assistant turn that asked" "$(q 'j.threads[2].items[0].reply_to')" \
  "which way?"

# ── Window mode usage: all three flags or none ─────────────────────────────

usage_rc() { env ${WE_[@]+"${WE_[@]}"} bash "${SCRIPT}" "$@" >/dev/null 2>&1; echo $?; }
is "--since without --until exits 2" "$(usage_rc --since 2026-09-22T00:00:00Z --json)" "2"
is "--until without --since exits 2" "$(usage_rc --until 2026-09-22T00:00:00Z --json)" "2"
is "a window without --json exits 2" \
  "$(usage_rc --since 2026-09-22T00:00:00Z --until 2026-09-23T00:00:00Z)" "2"
is "--json without a window exits 2" "$(usage_rc --json)" "2"
is "--full does not ride along with a window" \
  "$(usage_rc --since 2026-09-22T00:00:00Z --until 2026-09-23T00:00:00Z --json --full)" "2"
USAGE_ERR="$(env ${WE_[@]+"${WE_[@]}"} bash "${SCRIPT}" --since x --json 2>&1)"
has "a usage error prints the usage" "${USAGE_ERR}" "--since <iso> --until <iso> --json"
BADDATE="$(env ${WE_[@]+"${WE_[@]}"} bash "${SCRIPT}" --since yesterday --until 2026-09-23T00:00:00Z --json 2>&1)"
BADDATE_RC=$?
is "a bound that is not a date exits 2" "${BADDATE_RC}" "2"
has "…naming the bound" "${BADDATE}" "--since is not a date: yesterday"
REVERSED="$(env ${WE_[@]+"${WE_[@]}"} bash "${SCRIPT}" --since 2026-09-23T00:00:00Z --until 2026-09-22T00:00:00Z --json 2>&1)"
REVERSED_RC=$?
is "a reversed window exits 2 rather than reading as silence" "${REVERSED_RC}" "2"
has "…saying which way round" "${REVERSED}" "--since must be before --until"
EMPTY_RC=0
env ${WE_[@]+"${WE_[@]}"} bash "${SCRIPT}" --since 2026-09-22T00:00:00Z --until 2026-09-22T00:00:00Z --json > /dev/null 2>&1 || EMPTY_RC=$?
is "an empty window (since = until) exits 2" "${EMPTY_RC}" "2"
FEB30="$(env ${WE_[@]+"${WE_[@]}"} bash "${SCRIPT}" --since 2026-02-30T00:00:00Z --until 2026-03-05T00:00:00Z --json 2>&1)"
FEB30_RC=$?
is "a day that does not exist (Feb 30) exits 2 rather than becoming March 2" "${FEB30_RC}" "2"
has "…naming the bound" "${FEB30}" "--since is not a date: 2026-02-30"

WMISS="$(env "T3CODE_HOME=${TMP}/nowhere" "HOME=${TMP}/home" bash "${SCRIPT}" \
  --since 2026-09-22T00:00:00Z --until 2026-09-23T00:00:00Z --json 2>&1)"
WMISS_RC=$?
is "window mode on a missing database exits 2" "${WMISS_RC}" "2"
has "…naming the path it tried" "${WMISS}" "${TMP}/nowhere/userdata/state.sqlite"

echo
echo "corrections.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
