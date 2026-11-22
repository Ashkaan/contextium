#!/usr/bin/env -S node --experimental-strip-types
// end-of-turn.ts — at the end of every turn, did the close reach the user, and
// has a thread that closed closed again?
//
// WHY. Two close failures happen after /close has finished, where no step of
// it can see them:
//   - the reply leaves out the proof line land.ts printed, so the user cannot
//     tell whether the session closed, and
//   - the thread keeps working after its close and never closes again, so its
//     later work sits unlanded.
// Both are visible only when a turn ends, so this runs as each harness's
// end-of-turn (Stop) hook, through .agents/hooks/check-close-reached.sh.
//
// THE COST, ACCEPTED. A refused reply makes the model write a second one, and
// a chat client shows both. It refuses at every turn end until the problem is
// fixed; the second stop of a turn always passes, so no turn loops, and this
// never judges a reply's style.
//
// THE RULES, in order:
//   0. A harness not in COVERED, or a missing --harness: allow.
//   0a. A review-chain vendor subprocess (WORKBENCH_REVIEW_SLOT): allow.
//   0b. A helper's turn: the payload's session id (`session_id`, else Grok's
//      `sessionId`) is one T3 records on a thread other than the folder's
//      (t3-db.ts sessionThread). A delegated helper works in its parent's
//      worktree, so the folder names the parent; refusing it would turn a
//      helper's answer into "run /close". Allowed and logged in the thread's
//      own log, no marker touched. Looked up only once the thread has a state
//      folder; an absent, unknown or own-thread id, or a failed read (logged),
//      leaves rules 1–7 as they are.
//   1. The reply carries the saved report's last line → `report-delivered`.
//   2. `paused` holds a recorded question → a reply that carries it
//      (whitespace collapsed), at either stop, writes `asked`, ends the pause
//      and is allowed; a first stop without it is refused, naming it, and the
//      pause is kept for the retry; a second stop without it ends the pause
//      unasked and is allowed. Before the hold below, so a held close's
//      question is checked too.
//   3. The second stop of a turn → allow.
//   4. `held` (a close waiting on its live checks) → allow.
//   5. `reopened` (a session paused for the user's answer) → refuse until a new
//      close lands; land.ts removes it when it writes `closed`.
//   6. `report` saved and not delivered → refuse: paste it.
//   7. `closed` (or `closed-once`, which a refused later landing keeps) and
//      ledger work not landed (land.ts unlandedWork) → refuse:
//      run /close.
// Anything that goes wrong allows the reply and logs a line: a broken check
// must not trap every reply. A refusal says how to ask the user a question.
//
// A QUESTION FOR THE USER. The AI may need to ask the user something; the
// question pauses the close until it is answered and dealt with:
//   end-of-turn.ts --pause "<question>"
// records the question (`paused`) and pauses the session (`reopened`), at
// any point: after a close, while one is held, or before any. The turn that
// asks it passes when the reply carries the words, and only then is `asked`
// written: the record that a question reached the user, and when, which a
// per-session monitor can read.
// Every later turn end is refused until a new close lands, or the AI pauses
// again.
//
// STATE, under ~/.cache/workbench/threads/<thread id>/ (land.ts writes the
// first three): `report` (the close's final block), `closed`, `held`,
// the ledger `worktrees`; this script's own `report-delivered`, `paused`,
// `reopened`, `asked` and `end-of-turn.log`. Errors with no thread go to
// ~/.cache/workbench/end-of-turn.log.
//
// Usage:
//   end-of-turn.ts --harness <claude|codex|grok|antigravity>   (payload on stdin)
//   end-of-turn.ts --pause "<question>"
//
// Env:
//   WORKBENCH_THREAD_ID — read by thread.ts (the suites set it).
//   END_OF_TURN_TEST_COVERED — the suite's covered list (comma-separated);
//                              nothing in a real session sets it.
//
// peers:
//   .agents/skills/close/scripts/end-of-turn.test.ts   (the suite, run as a program)
//   .agents/hooks/check-close-reached.sh       (the hook wrapper the manifests name)
//   .agents/skills/close/scripts/land.ts       (writes the state; unlandedWork)
//   .agents/skills/close/scripts/thread.ts     (the thread from the payload's cwd)
//   .agents/checks/check-harness-config-links.ts (asserts the wiring)
//
// Exit: 0 allow (or a pause recorded) · 2 refuse (or a --pause refused)

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isFile } from "./trunk.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const THREAD = join(dirname(SCRIPT), "thread.ts");
const CACHE = join(process.env.HOME ?? "", ".cache", "workbench");

const HARNESSES = ["claude", "codex", "grok", "antigravity"] as const;
type Harness = (typeof HARNESSES)[number];

/** The harnesses whose end-of-turn hook was measured blocking a reply and
 *  passing its second stop, in three of three runs each: Claude Code, Codex,
 *  and Grok Build, whose Stop payload `senderOf` tells apart from the handler
 *  it runs (Claude Code's or Codex's), so no handler of Grok's own is added.
 *  Not covered: Antigravity (its workspace asks to trust its hooks first).
 *  The harness comes from --harness, which each manifest passes — Claude Code
 *  and Codex send the same fields. */
export const COVERED: readonly Harness[] = ["claude", "codex", "grok"];

const covered = (): readonly string[] =>
  process.env.END_OF_TURN_TEST_COVERED === undefined
    ? COVERED
    : process.env.END_OF_TURN_TEST_COVERED.split(",").filter(Boolean);

class Allow extends Error {}

const PAUSE_HINT = `If you need to ask the user something first, run \`node --experimental-strip-types ${SCRIPT} --pause "<question>"\` and ask it.`;

function logTo(file: string, line: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()}\t${line}\n`);
  } catch {
    // Nowhere to say it; the reply is allowed either way.
  }
}

/** Collapse whitespace, so a reply that rewraps a line still carries it. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The thread a directory belongs to, or an Allow naming why not. `--keep`: a
 *  session whose harness exports no id is named by its checkout, and once its
 *  close lands the next thread.ts call starts a new id — this check, and a
 *  --pause after the close, are about the session that closed, so they ask
 *  for the id the checkout names now. A new id read an empty state, and a
 *  reply without the close's proof passed. */
function threadOf(cwd: string): string {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", THREAD, "--id", "--keep"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  const id = (r.stdout ?? "").trim();
  if (r.status !== 0 || !id) {
    const why = (r.stderr ?? "").split("\n").find((l) => l.startsWith("thread: ")) ?? `thread.ts exited ${r.status}`;
    throw new Allow(`no thread for ${cwd}: ${why}`);
  }
  return id;
}

// ── The payload ────────────────────────────────────────────────────────────

interface Turn {
  cwd: string;
  second: boolean;
  reply: string;
  /** The harness's own session id, or "" when the payload carries none. */
  session: string;
}

/** `session_id` (Claude Code, Codex, and Grok's copy), else Grok's `sessionId`. */
const sessionOf = (o: Record<string, unknown>): string =>
  typeof o.session_id === "string" && o.session_id ? o.session_id : typeof o.sessionId === "string" ? o.sessionId : "";

const str = (o: Record<string, unknown>, k: string): string => {
  if (typeof o[k] !== "string") throw new Allow(`payload field ${k} is ${o[k] === null ? "null" : typeof o[k]}`);
  return o[k] as string;
};
const bool = (o: Record<string, unknown>, k: string): boolean => {
  if (typeof o[k] !== "boolean") throw new Allow(`payload field ${k} is ${typeof o[k]}`);
  return o[k] as boolean;
};

/** Grok's reply when its payload carries no text (a Stop payload with
 *  only `transcriptPath`): the `agent_message_chunk` texts after
 *  the turn's last `user_message_chunk` in its ACP update log. Only this
 *  turn's: no user prompt in the file is no reply. */
export function grokTranscriptReply(text: string): string {
  const rows: { kind: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const u = (j as { params?: { update?: { sessionUpdate?: unknown; content?: { text?: unknown } } } })?.params
      ?.update;
    if (typeof u?.sessionUpdate !== "string") continue;
    rows.push({ kind: u.sessionUpdate, text: typeof u.content?.text === "string" ? u.content.text : "" });
  }
  const start = rows.map((r) => r.kind).lastIndexOf("user_message_chunk");
  if (start < 0) throw new Allow("the transcript holds no user prompt for this turn");
  const reply = rows
    .slice(start + 1)
    .filter((r) => r.kind === "agent_message_chunk")
    .map((r) => r.text)
    .join("");
  if (!reply.trim()) throw new Allow("the transcript holds no assistant message for this turn");
  return reply;
}

function parse(raw: string): Record<string, unknown> {
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    throw new Allow("the payload is not JSON");
  }
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Allow("the payload is not an object");
  return p as Record<string, unknown>;
}

/** The harness that sent a payload. Grok Build runs the hooks in Claude
 *  Code's settings file (`--harness claude`) and in the manifest Codex reads,
 *  which ~/.grok/hooks/contextium.json links to (`--harness codex`), so a
 *  payload through either is Grok's when it carries Grok's own camelCase
 *  fields (`hookEventName`, `stopHookActive`; it sends the snake_case ones as
 *  well). */
export function senderOf(arg: Harness, o: Record<string, unknown>): Harness {
  return (arg === "claude" || arg === "codex") && ("hookEventName" in o || "stopHookActive" in o) ? "grok" : arg;
}

function readTurn(h: Harness, o: Record<string, unknown>): Turn {
  if (h === "grok") {
    const second = bool(o, "stopHookActive");
    const cwd = str(o, "cwd");
    const session = sessionOf(o);
    if (typeof o.lastAssistantMessage === "string") return { cwd, second, reply: o.lastAssistantMessage, session };
    const path = str(o, "transcriptPath");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new Allow(`transcript unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { cwd, second, reply: grokTranscriptReply(text), session };
  }
  if (h === "antigravity") throw new Allow("no reading of Antigravity's end-of-turn payload is measured");
  // Claude Code and Codex: `last_assistant_message` is null on Codex when the
  // turn has no assistant message — no reply of this turn to read.
  return {
    cwd: str(o, "cwd"),
    second: bool(o, "stop_hook_active"),
    reply: str(o, "last_assistant_message"),
    session: sessionOf(o),
  };
}

// ── The decision ───────────────────────────────────────────────────────────

/** Why to refuse, or null to allow. Writes the markers as it goes. */
async function decide(state: string, turn: Turn, log: (l: string) => void): Promise<string | null> {
  const report = join(state, "report");
  const delivered = join(state, "report-delivered");
  const paused = join(state, "paused");
  let block = "";
  let proof = "";
  if (isFile(report)) {
    block = readFileSync(report, "utf8").trim();
    proof =
      block
        .split("\n")
        .filter((l) => l.trim())
        .at(-1) ?? "";
  }
  // 1. A reply carrying the line delivers it, whichever stop it is.
  if (proof && !isFile(delivered) && flat(turn.reply).includes(flat(proof))) writeFileSync(delivered, "");
  // 2. A recorded question is settled by the reply that asks it, whichever
  //    stop; a refused first stop keeps it, so the retry is checked too.
  if (isFile(paused)) {
    const question = readFileSync(paused, "utf8").trim();
    if (question && flat(turn.reply).includes(flat(question))) {
      writeFileSync(join(state, "asked"), "");
      rmSync(paused, { force: true });
      return null;
    }
    if (turn.second) {
      rmSync(paused, { force: true });
      return null;
    }
    return `You recorded a question for the user with --pause, but this reply does not ask it. Ask it in these words: "${question}"`;
  }
  // 3.
  if (turn.second) return null;
  // 4.
  if (isFile(join(state, "held"))) return null;
  // 5.
  if (isFile(join(state, "reopened")))
    return `This close is paused for the user's answer: deal with it and close again (/close), or run \`node --experimental-strip-types ${SCRIPT} --pause "<question>"\` to ask another question.`;
  // 6.
  if (isFile(report) && !isFile(delivered)) {
    if (!proof) {
      log(`${report} is empty: nothing to compare the reply with`);
      return null;
    }
    // The block itself, not only its path: a session without file access
    // could not read it.
    return `This thread closed, and your reply does not carry its close report. Paste the close report (saved at ${report}) verbatim, ending with its last line:\n\n${block}\n\n${PAUSE_HINT}`;
  }
  // 7.
  const ledger = join(state, "worktrees");
  // `closed-once` too: a later landing removes `closed` when it starts, and
  // one that is then refused must not switch this check off.
  if ((isFile(join(state, "closed")) || isFile(join(state, "closed-once"))) && isFile(ledger)) {
    // Loaded here, not at the top: the manifest check imports COVERED from
    // this file and must not pull in land.ts and everything it imports.
    const { unlandedWork } = await import("./land.ts");
    const landed = unlandedWork(ledger);
    if (landed === "unlanded") return `This thread closed earlier and has work not landed: run /close.\n${PAUSE_HINT}`;
    if (landed === "unreadable") log("a ledger worktree could not be read; not refused");
  }
  return null;
}

function refuse(h: Harness, why: string): never {
  if (h === "antigravity") {
    process.stdout.write(`${JSON.stringify({ decision: "continue", reason: why })}\n`);
    process.exit(0);
  }
  process.stderr.write(`${why}\n`);
  process.exit(2);
}

async function hook(h: string | undefined): Promise<void> {
  // Only a covered harness reads anything; Grok through the Claude or Codex
  // manifest arrives as `claude` or `codex` and is told apart from its payload below.
  if (!h || !(HARNESSES as readonly string[]).includes(h) || !covered().includes(h)) process.exit(0);
  let harness = h as Harness;
  let state = "";
  const log = (l: string) => logTo(state ? join(state, "end-of-turn.log") : join(CACHE, "end-of-turn.log"), l);
  try {
    const o = parse(readFileSync(0, "utf8"));
    harness = senderOf(harness, o);
    if (!covered().includes(harness)) process.exit(0);
    // A reviewer the review chain spawned (.agents/skills/review/policy-chain.ts sets
    // WORKBENCH_REVIEW_SLOT) runs in the session's worktree but is not the
    // session's turn: refusing it turned a SPEC audit's answer into "run
    // /close".
    if (process.env.WORKBENCH_REVIEW_SLOT) {
      throw new Allow(`a review-chain ${process.env.WORKBENCH_REVIEW_SLOT} subprocess, not a session turn`);
    }
    const turn = readTurn(harness, o);
    if (!existsSync(turn.cwd)) throw new Allow(`cwd ${turn.cwd} does not exist`);
    const tid = threadOf(turn.cwd);
    const dir = join(CACHE, "threads", tid);
    if (!existsSync(dir)) process.exit(0); // a thread that never closed or held
    state = dir;
    // 0b. A helper's turn. Loaded here, not at the top, for the same
    // reason as land.ts below; and only now, so a thread with no state folder
    // never opens T3's database.
    if (turn.session) {
      const { sessionThread } = await import("./t3-db.ts");
      const owner = sessionThread(turn.session);
      if (typeof owner === "string" && owner !== tid)
        throw new Allow(`a helper's turn (${owner}), not thread ${tid}'s`);
      if (owner !== null && typeof owner === "object") log(`session id not looked up: ${owner.error}`);
    }
    const why = await decide(state, turn, log);
    if (why) refuse(harness, why);
  } catch (e) {
    log(
      `${harness}: allowed — ${e instanceof Allow ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
  }
  process.exit(0);
}

function pause(question: string | undefined): void {
  if (!question?.trim()) {
    process.stderr.write('end-of-turn: --pause needs the question you will ask: --pause "<question>"\n');
    process.exit(2);
  }
  let tid: string;
  try {
    tid = threadOf(process.cwd());
  } catch (e) {
    process.stderr.write(`end-of-turn: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const state = join(CACHE, "threads", tid);
  // At any point in the session: the state folder this makes is what has the
  // hook check the asking reply. A new question is not asked until its reply
  // passes, so an earlier question's `asked` goes.
  mkdirSync(state, { recursive: true });
  rmSync(join(state, "asked"), { force: true });
  writeFileSync(join(state, "paused"), `${question.trim()}\n`);
  writeFileSync(join(state, "reopened"), "");
  process.stdout.write(
    "paused: ask the question in this reply, in the words you recorded. Every later turn end is refused until a new close lands (/close) or you pause again.\n",
  );
  process.exit(0);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SCRIPT)) {
  const argv = process.argv.slice(2);
  const at = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--pause")) pause(at("--pause"));
  else await hook(at("--harness"));
}
