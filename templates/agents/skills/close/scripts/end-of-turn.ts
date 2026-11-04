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
//   1. The reply carries the saved report's last line → `report-delivered`.
//   2. `paused` exists → remove it, remembering its question.
//   3. The second stop of a turn → allow.
//   4. `held` (a close waiting on its live checks) → allow.
//   5. A question was just taken from `paused` → allow when the reply carries
//      it (whitespace collapsed); else refuse, naming it.
//   6. `reopened` (a close paused for the user's answer) → refuse until a new
//      close lands; land.ts removes it when it writes `closed`.
//   7. `report` saved and not delivered → refuse: paste it.
//   8. `closed` (or `closed-once`, which a refused later landing keeps) and
//      ledger work not landed (land.ts unlandedWork) → refuse:
//      run /close.
// Anything that goes wrong allows the reply and logs a line: a broken check
// must not trap every reply. A refusal says how to ask the user a question.
//
// A QUESTION AFTER A CLOSE. The AI may need to ask the user something after a
// finished close; the question pauses the close until it is answered and dealt
// with:
//   end-of-turn.ts --pause "<question>"
// records the question (`paused`) and pauses the close (`reopened`). The
// turn that asks it passes when the reply carries the words; every later turn
// end is refused until a new close lands, or the AI pauses again.
//
// STATE, under ~/.cache/workbench/threads/<thread id>/ (land.ts writes the
// first three): `report` (the close's final block), `closed`, `held`,
// the ledger `worktrees`; this script's own `report-delivered`, `paused`,
// `reopened` and `end-of-turn.log`. Errors with no thread go to
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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const THREAD = join(dirname(SCRIPT), "thread.ts");
const CACHE = join(process.env.HOME ?? "", ".cache", "workbench");

const HARNESSES = ["claude", "codex", "grok", "antigravity"] as const;
type Harness = (typeof HARNESSES)[number];

/** The harnesses whose end-of-turn hook was measured blocking a reply and
 *  passing its second stop, in three of three runs each. Not covered:
 *  Antigravity (its workspace asks to trust its hooks first) and Grok Build
 *  (not measured). The harness comes from --harness, which each manifest
 *  passes — Claude Code and Codex send the same fields. */
export const COVERED: readonly Harness[] = ["claude", "codex"];

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

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Collapse whitespace, so a reply that rewraps a line still carries it. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The thread a directory belongs to, or an Allow naming why not. */
function threadOf(cwd: string): string {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", THREAD, "--id"], {
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
}

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
    if (typeof o.lastAssistantMessage === "string") return { cwd, second, reply: o.lastAssistantMessage };
    const path = str(o, "transcriptPath");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new Allow(`transcript unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { cwd, second, reply: grokTranscriptReply(text) };
  }
  if (h === "antigravity") throw new Allow("no reading of Antigravity's end-of-turn payload is measured");
  // Claude Code and Codex: `last_assistant_message` is null on Codex when the
  // turn has no assistant message — no reply of this turn to read.
  return { cwd: str(o, "cwd"), second: bool(o, "stop_hook_active"), reply: str(o, "last_assistant_message") };
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
  // 2. A pause is consumed by the very next turn end, allowed or not.
  let asked: string | null = null;
  if (isFile(paused)) {
    asked = readFileSync(paused, "utf8").trim();
    rmSync(paused, { force: true });
  }
  // 3, 4.
  if (turn.second) return null;
  if (isFile(join(state, "held"))) return null;
  // 5.
  if (asked !== null) {
    if (asked && flat(turn.reply).includes(flat(asked))) return null;
    return `You recorded a question for the user with --pause, but this reply does not ask it. Ask it in these words: "${asked}"`;
  }
  // 6.
  if (isFile(join(state, "reopened")))
    return `This close is paused for the user's answer: deal with it and close again (/close), or run \`node --experimental-strip-types ${SCRIPT} --pause "<question>"\` to ask another question.`;
  // 7.
  if (isFile(report) && !isFile(delivered)) {
    if (!proof) {
      log(`${report} is empty: nothing to compare the reply with`);
      return null;
    }
    // The block itself, not only its path: a session without file access
    // could not read it.
    return `This thread closed, and your reply does not carry its close report. Paste the close report (saved at ${report}) verbatim, ending with its last line:\n\n${block}\n\n${PAUSE_HINT}`;
  }
  // 8.
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
    const turn = readTurn(harness, o);
    if (!existsSync(turn.cwd)) throw new Allow(`cwd ${turn.cwd} does not exist`);
    const tid = threadOf(turn.cwd);
    const dir = join(CACHE, "threads", tid);
    if (!existsSync(dir)) process.exit(0); // a thread that never closed or held
    state = dir;
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
  // Either marker: a refused later landing clears `closed` and keeps
  // `closed-once`, and its refusal tells the AI it may pause to ask.
  if (!isFile(join(state, "closed")) && !isFile(join(state, "closed-once"))) {
    process.stderr.write(
      "end-of-turn: no close has finished in this thread, so nothing checks the reply — ask the question without --pause\n",
    );
    process.exit(2);
  }
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
