// session.test.ts — what the close reads back of a session, and how it pages.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/session.test.ts
//
// The fixture is a v2 database holding the turn-item shapes T3 really writes
// (measured from a real statev2.sqlite), built in a temporary folder by the test
// itself; the script is spawned, with TZ pinned so the clock and the day header
// are known.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "session.ts");
const TMP = mkdtempSync(join(tmpdir(), "session-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

type Run = { out: string; err: string; rc: number };

function run(t3: string, env: Record<string, string>, ...args: string[]): Run {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    T3CODE_HOME: t3,
    HOME: join(TMP, "home"),
    TZ: "America/Los_Angeles",
    NODE_OPTIONS: "--no-warnings",
    ...env,
  };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "CONTEXTIUM_SESSION"]) delete e[k];
  if (!("WORKBENCH_THREAD_ID" in env)) delete e.WORKBENCH_THREAD_ID;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: e,
    timeout: 60_000,
  });
  return { out: r.stdout ?? "", err: r.stderr ?? "", rc: r.status ?? -1 };
}

const TID = "ffffffff-1111-2222-3333-777777777777";
const OTHER = "99999999-1111-2222-3333-888888888888";

const TURN_ITEMS = `create table orchestration_v2_projection_turn_items (
  turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT,
  provider_thread_id TEXT, provider_turn_id TEXT, parent_item_id TEXT,
  ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
  updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)`;

function t3Home(name: string, withTable = true): { home: string; add: (...a: Parameters<Adder>) => void } {
  const home = join(TMP, name);
  mkdirSync(join(home, "userdata"), { recursive: true });
  const db = new DatabaseSync(join(home, "userdata", "statev2.sqlite"));
  if (!withTable) {
    db.exec("create table orchestration_v2_projection_threads (thread_id TEXT)");
    db.close();
    return { home, add: () => {} };
  }
  db.exec(TURN_ITEMS);
  const ins = db.prepare(
    "insert into orchestration_v2_projection_turn_items values (?,?,null,null,null,null,null,?,?,?,?,?)",
  );
  let n = 0;
  const add: Adder = (thread, ordinal, type, status, payload) => {
    const at = String(payload.startedAt ?? "2026-10-19T13:00:00.000Z");
    ins.run(`i${n++}`, thread, ordinal, type, status, at, JSON.stringify({ type, status, startedAt: at, ...payload }));
  };
  return { home, add };
}

type Adder = (thread: string, ordinal: number, type: string, status: string, payload: Record<string, unknown>) => void;

// 13:39 UTC is 06:39 in Los Angeles in October (PDT).
const main = t3Home("main");
// Inserted out of order on purpose: the script must follow `ordinal`, not rowid.
main.add(TID, 9, "assistant_message", "completed", {
  text: "Yes, partly.\n\nCorrections are not affected.",
  startedAt: "2026-10-19T13:45:00.000Z",
});
main.add(TID, 1, "user_message", "completed", {
  text: "Does compaction\nthin the journal?",
  createdBy: "user",
  startedAt: "2026-10-19T13:39:12.845Z",
});
main.add(TID, 2, "reasoning", "completed", { text: "Check close first.\nThen the db.\n" });
main.add(TID, 3, "command_execution", "completed", {
  input: "ls .agents/skills/close",
  output: "SKILL.md\nscripts",
  exitCode: 0,
});
main.add(TID, 4, "command_execution", "completed", {
  input: "node x.ts",
  output: `${"noise ".repeat(200)}Error: no such table: projection_thread_activities`,
  exitCode: 1,
});
main.add(TID, 5, "dynamic_tool", "failed", {
  toolName: "Read",
  title: "Read /tmp/missing.md",
  input: { file_path: "/tmp/missing.md" },
  output: "File does not exist.",
});
main.add(TID, 6, "checkpoint", "completed", { files: [] });
main.add(TID, 7, "compaction", "completed", { beforeTokenCount: 361620, afterTokenCount: 15949 });
main.add(TID, 8, "mystery_kind", "completed", { title: "something new from T3" });
main.add(TID, 10, "user_message", "completed", { text: "Agent restart notice", createdBy: "agent" });
main.add(OTHER, 1, "user_message", "completed", { text: "another thread's words", createdBy: "user" });

test("prints the session in ordinal order, messages in full", () => {
  const r = run(main.home, { WORKBENCH_THREAD_ID: TID });
  assert.equal(r.rc, 0, r.err);
  const asked = r.out.indexOf("[06:39] user:\nDoes compaction\nthin the journal?");
  const answered = r.out.indexOf("[06:45] assistant:\nYes, partly.\n\nCorrections are not affected.");
  assert.ok(asked >= 0, `user turn missing or not in full:\n${r.out}`);
  assert.ok(answered > asked, `assistant reply missing or out of ordinal order:\n${r.out}`);
  assert.ok(r.out.includes("═══ 2026-10-19 ═══"), "no local day header");
  assert.ok(!r.out.includes("another thread's words"), "read another thread's items");
});

test("reasoning is one line, with no trailing marker", () => {
  const r = run(main.home, { WORKBENCH_THREAD_ID: TID });
  assert.match(r.out, /thinking: Check close first\. ⏎ Then the db\.\n/);
});

test("a successful call prints no output; a failed one prints the tail of it", () => {
  const r = run(main.home, { WORKBENCH_THREAD_ID: TID });
  assert.match(r.out, /\$ ls \.agents\/skills\/close\n/, "a successful command carried its output");
  assert.match(r.out, /\$ node x\.ts → exit 1: ….*Error: no such table: projection_thread_activities\n/);
  assert.match(r.out, /Read: Read \/tmp\/missing\.md → failed: File does not exist\.\n/);
});

test("a compaction is marked and counted; a checkpoint is dropped; an unknown type is kept", () => {
  const r = run(main.home, { WORKBENCH_THREAD_ID: TID });
  assert.match(r.out, /context compacted \(361,620 → 15,949 tokens\)/);
  assert.match(r.out.split("\n")[0] ?? "", /· 1 compaction · page 1 of 1$/);
  assert.ok(!r.out.includes("checkpoint"), "printed a checkpoint");
  assert.match(r.out, /mystery_kind completed: something new from T3/);
  assert.match(r.out, /sent by an agent:\nAgent restart notice/);
  assert.match(r.out, /page 1 of 1: end of session/);
});

test("a long session pages at item boundaries, and every page names the next", () => {
  const long = t3Home("long");
  const block = "x".repeat(5_000);
  for (let i = 1; i <= 12; i++) long.add(TID, i, "assistant_message", "completed", { text: `item-${i} ${block}` });
  const one = run(long.home, {}, "--thread", TID);
  assert.equal(one.rc, 0, one.err);
  const total = Number(/page 1 of (\d+)/.exec(one.out)?.[1]);
  assert.ok(total >= 3, `expected several pages, got ${total}`);
  assert.match(one.out, new RegExp(`next: session\\.ts --page 2 --thread ${TID}`));
  const seen: string[] = [];
  for (let p = 1; p <= total; p++) {
    const r = run(long.home, {}, "--thread", TID, "--page", String(p));
    assert.equal(r.rc, 0, r.err);
    // No item is split across pages: each one appears whole on exactly one.
    for (const m of r.out.matchAll(/item-(\d+) (x+)/g)) {
      assert.equal(m[2]?.length, 5_000, `item-${m[1]} was cut on page ${p}`);
      seen.push(m[1] ?? "");
    }
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 12 }, (_, i) => String(i + 1)),
  );
  const past = run(long.home, {}, "--thread", TID, "--page", String(total + 1));
  assert.equal(past.rc, 2);
  assert.match(past.err, new RegExp(`page ${total + 1} is past the end: thread ${TID} has ${total}`));
});

test("a thread with no items says so and exits 0", () => {
  const r = run(main.home, {}, "--thread", "no-such-thread");
  assert.equal(r.rc, 0, r.err);
  assert.equal(r.out, "thread no-such-thread: no turn items\n");
});

test("refuses a database without turn items, a missing database, and bad usage", () => {
  const legacy = t3Home("legacy", false);
  const noTable = run(legacy.home, {}, "--thread", TID);
  assert.equal(noTable.rc, 2);
  assert.match(noTable.err, /has no orchestration_v2_projection_turn_items table/);

  const missing = run(join(TMP, "nowhere"), {}, "--thread", TID);
  assert.equal(missing.rc, 2);
  assert.match(missing.err, /no T3 database at/);

  for (const args of [["--page", "0"], ["--page"], ["--bogus"]]) {
    const r = run(main.home, { WORKBENCH_THREAD_ID: TID }, ...args);
    assert.equal(r.rc, 2, `${args.join(" ")} was accepted`);
    assert.match(r.err, /usage: session\.ts/);
  }
});
