#!/usr/bin/env -S node --experimental-strip-types
// session.ts — the whole of this thread's session, read back from T3 at close.
//
// WHY. A journal entry's Changes, Findings, Lessons and `rejected:` lines are
// written from the agent's context, and once a long session compacts that
// context is a summary of itself: the dead end tried at 10:00, the reading that
// ruled out a cause, the approach dropped and why, are the first things a
// summary loses. Compaction thins the journal that way: `corrections.ts`
// re-reads the user's words from T3, but nothing re-read the rest. T3 keeps every turn item of every harness in
// `orchestration_v2_projection_turn_items` whatever the agent's context holds,
// so the close reads the session from there instead of from memory.
//
// WHAT IS PRINTED, in T3's own order (`ordinal`):
//   - the user's messages and the assistant's replies, in full;
//   - the agent's reasoning, in full, on one line — it is where "tried X, it
//     failed because Y" lives;
//   - one line per tool call: the command or tool and its target. A call that
//     failed (status other than completed, or a non-zero exit) also carries the
//     tail of its output, because a failure is a finding. A successful call's
//     output is not printed: what was learned from it is in the reasoning and
//     the replies that follow, and printing every file read would bury them;
//   - a marker at each compaction, with T3's token counts, so the entry can
//     tell what the agent's summary replaced. Only Claude Code records one
//     (every `compaction` item T3 had written when this was measured was
//     `claudeAgent`'s), so no marker does not prove a Codex session never
//     compacted;
//   - checkpoints are dropped: T3's bookkeeping, nothing anyone did.
//   An item type this script does not know is printed with its type and title
//   rather than dropped, for the reason corrections.ts keeps uncertain rows:
//   the reader can skip a line, but nothing can recover one never printed.
//
// WHY PAGES. A harness truncates long command output (Claude Code's Bash tool
// near 30,000 characters), and a cut read is exactly the loss this exists to
// undo. So the output comes in pages of at most PAGE_CHARS, split at item
// boundaries (an item longer than a page is split across pages), and each page
// ends naming the next. The close reads every page.
//
// Usage:
//   session.ts                 — page 1 of this thread
//   session.ts --page <n>      — page n
//   session.ts --thread <id>   — another thread (pages the same way)
//
// Env:
//   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.ts; T3CODE_HOME also
//   locates the database.
//
// peers:
//   .agents/skills/close/scripts/session.test.ts
//   .agents/skills/close/scripts/t3-db.ts         (the database, the thread id)
//   .agents/skills/close/SKILL.md § 3 — Journal   (who reads it, and when)
//
// OUTSIDE T3 there is no such database: this exits 2 saying so, and the close
// writes the entry from the agent's own context (SKILL.md § 3).
//
// Exit: 0 ok · 2 no thread, no database, a database without turn items, a page
// past the end, or bad usage

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import { currentThread, loadSqlite, mainTables, t3Database } from "./t3-db.ts";

export const PAGE_CHARS = 24_000;
const TARGET_CHARS = 240;
const FAILURE_CHARS = 400;
const USAGE = "usage: session.ts [--page <n>] [--thread <id>]";

function die(message: string): never {
  process.stderr.write(`session: ${message}\n`);
  return exit(2);
}

type Payload = Record<string, unknown>;

function isRecord(v: unknown): v is Payload {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** One line, newlines shown as `⏎`, cut to `max` characters with an ellipsis. */
function line(v: unknown, max = Number.POSITIVE_INFINITY): string {
  const flat = text(v)
    .trim()
    .replace(/\s*\n\s*/g, " ⏎ ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The END of a failure's output, where the error usually is. */
function tail(v: unknown): string {
  const flat = line(v);
  return flat.length > FAILURE_CHARS ? `…${flat.slice(-FAILURE_CHARS)}` : flat;
}

// Local time, as the journal's own minute is (thread.ts --local).
const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const day = new Intl.DateTimeFormat("en-CA");

function failed(type: string, status: string, p: Payload): boolean {
  if (status !== "completed") return true;
  return type === "command_execution" && typeof p.exitCode === "number" && p.exitCode !== 0;
}

/** One turn item as the lines it prints, or null when it carries nothing to read. */
export function render(type: string, status: string, p: Payload): string | null {
  const why = (output: unknown): string => {
    const exitCode = typeof p.exitCode === "number" ? `exit ${p.exitCode}` : status;
    const t = tail(output);
    return t === "" ? ` → ${exitCode}` : ` → ${exitCode}: ${t}`;
  };
  const bad = failed(type, status, p);
  switch (type) {
    case "checkpoint":
      return null;
    case "user_message": {
      const who = p.createdBy === "agent" ? "sent by an agent" : "user";
      return `${who}:\n${text(p.text).trim()}`;
    }
    case "assistant_message":
      return `assistant:\n${text(p.text).trim()}`;
    case "reasoning":
      return line(p.text) === "" ? null : `thinking: ${line(p.text)}`;
    case "command_execution":
      return `$ ${line(p.input, TARGET_CHARS)}${bad ? why(p.output) : ""}`;
    case "dynamic_tool": {
      const target = line(p.title ?? p.input, TARGET_CHARS);
      return `${text(p.toolName) || "tool"}: ${target}${bad ? why(p.output) : ""}`;
    }
    case "file_change":
      return `edit ${text(p.fileName)}${bad ? why(p.diffStr) : ""}`;
    case "web_search": {
      const patterns = Array.isArray(p.patterns) ? p.patterns.map((x) => text(x)).join(" | ") : "";
      return `search: ${line(patterns, TARGET_CHARS)}${bad ? ` → ${status}` : ""}`;
    }
    case "file_search":
      return `${line(p.title ?? p.pattern, TARGET_CHARS)}${bad ? ` → ${status}` : ""}`;
    case "subagent":
      return `subagent ${status}: ${line(p.title, TARGET_CHARS)}`;
    case "compaction": {
      const n = (v: unknown): string => (typeof v === "number" ? v.toLocaleString("en-US") : "?");
      return `── context compacted (${n(p.beforeTokenCount)} → ${n(p.afterTokenCount)} tokens): what is above this line, the agent knew only as a summary from here on ──`;
    }
    case "error":
      return `error: ${line(isRecord(p.failure) ? p.failure.message : p.title)}`;
    case "system_notice":
      return `notice: ${line(p.message ?? p.title)}`;
    case "notification":
      return `notice: ${line(p.summary ?? p.title)}`;
    case "run_interrupt_request":
      return null;
    case "run_interrupt_result":
      return `interrupted: ${line(p.message ?? p.title)}`;
    case "user_input_request": {
      const questions = Array.isArray(p.questions)
        ? p.questions.map((q) => (isRecord(q) ? text(q.question) : "")).filter((q) => q !== "")
        : [];
      return `asked (${status}): ${line(questions.join(" | ") || p.title)}`;
    }
    case "handoff":
      return "handoff: the thread moved to another provider";
    default:
      return `${type} ${status}: ${line(p.title, TARGET_CHARS)}`;
  }
}

type Item = { at: string; body: string };

function items(db: DatabaseSync, tid: string): Item[] {
  const rows: Record<string, SQLOutputValue>[] = db
    .prepare(
      "select type, status, payload_json from main.orchestration_v2_projection_turn_items where thread_id = ? order by ordinal",
    )
    .all(tid);
  const out: Item[] = [];
  for (const row of rows) {
    let p: Payload = {};
    try {
      const parsed: unknown = JSON.parse(String(row.payload_json ?? ""));
      if (isRecord(parsed)) p = parsed;
    } catch {
      p = {};
    }
    const body = render(String(row.type), String(row.status), p);
    if (body === null) continue;
    out.push({ at: text(p.startedAt ?? p.updatedAt), body });
  }
  return out;
}

/** Each item as a block — a day header when the local date changes, then `[HH:MM] body`. */
function blocks(list: Item[]): string[] {
  const out: string[] = [];
  let lastDay = "";
  for (const item of list) {
    const at = new Date(item.at);
    const valid = !Number.isNaN(at.getTime());
    const d = valid ? day.format(at) : "";
    const header = d !== "" && d !== lastDay ? `═══ ${d} ═══\n` : "";
    if (d !== "") lastDay = d;
    out.push(`${header}[${valid ? clock.format(at) : "--:--"}] ${item.body}\n`);
  }
  return out;
}

/** Blocks packed into pages of at most `size` characters. A block longer than
 *  a page is split into page-sized pieces, each after the first marked as a
 *  continuation: as a page of its own it was cut by the harness exactly as the
 *  pages exist to prevent (Contextium v9.2.0 review). */
export function paginate(list: string[], size = PAGE_CHARS): string[] {
  const pages: string[] = [];
  let current = "";
  const MARK = "[… continued]\n";
  // A continuation piece must hold the marker and at least two code units
  // (one is given back when it would end on half a surrogate pair); a smaller
  // page never advances, and looped until memory ran out.
  if (!Number.isInteger(size) || size < MARK.length + 2) {
    throw new RangeError(`page size ${size} is below the minimum ${MARK.length + 2}`);
  }
  const pieces: string[] = [];
  for (const b of list) {
    if (b.length <= size) {
      pieces.push(b);
      continue;
    }
    for (let at = 0, first = true; at < b.length; first = false) {
      let room = first ? size : size - MARK.length;
      // Never between the two halves of a surrogate pair: cut, each half
      // prints as U+FFFD (v9.2.0 review).
      const last = b.charCodeAt(at + room - 1);
      if (at + room < b.length && last >= 0xd800 && last <= 0xdbff) room -= 1;
      pieces.push((first ? "" : MARK) + b.slice(at, at + room));
      at += room;
    }
  }
  for (const b of pieces) {
    if (current !== "" && current.length + b.length > size) {
      pages.push(current);
      current = "";
    }
    current += b;
  }
  if (current !== "") pages.push(current);
  return pages;
}

async function main(): Promise<void> {
  const DB = t3Database(process.env.T3CODE_HOME || `${process.env.HOME ?? homedir()}/.t3`);
  let page = 1;
  let tid = "";
  const argv = process.argv.slice(2);
  while (argv.length > 0) {
    const [a, next] = argv;
    if (a === "--page" && next && /^[1-9]\d*$/.test(next)) {
      page = Number(next);
      argv.splice(0, 2);
    } else if (a === "--thread" && next) {
      tid = next;
      argv.splice(0, 2);
    } else {
      die(USAGE);
    }
  }

  if (tid === "") {
    const thread = currentThread();
    if ("error" in thread) die(thread.error);
    tid = thread.id;
  }

  let isFile = false;
  try {
    isFile = statSync(DB).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) die(`no T3 database at ${DB}`);

  const sqlite = await loadSqlite(fileURLToPath(import.meta.url));
  let db: DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(DB, { readOnly: true });
  } catch (e) {
    return die(`cannot read ${DB}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The turn items exist only in the v2 file (T3 0.0.46 and later); a legacy
  // database has the messages but not the tool calls, and printing half a
  // session as if it were all of it is the defect this script removes.
  if (!mainTables(db).has("orchestration_v2_projection_turn_items")) {
    die(`${DB} has no orchestration_v2_projection_turn_items table, so no session to read`);
  }

  const list = items(db, tid);
  if (list.length === 0) {
    process.stdout.write(`thread ${tid}: no turn items\n`);
    return;
  }
  const pages = paginate(blocks(list));
  if (page > pages.length) die(`page ${page} is past the end: thread ${tid} has ${pages.length}`);
  const compactions = list.filter((i) => i.body.startsWith("── context compacted")).length;
  const self = tid === "" ? "" : ` --thread ${tid}`;
  process.stdout.write(
    `thread ${tid} · ${list.length} items · ${compactions} compaction${compactions === 1 ? "" : "s"} · page ${page} of ${pages.length}\n\n`,
  );
  process.stdout.write(pages[page - 1] ?? "");
  process.stdout.write(
    page < pages.length
      ? `\n── page ${page} of ${pages.length}; next: session.ts --page ${page + 1}${self} ──\n`
      : `\n── page ${page} of ${pages.length}: end of session ──\n`,
  );
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
