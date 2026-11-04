// t3-db.test.ts — which T3 database file is chosen, and what the v2 views return.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/t3-db.test.ts
//
// The programs that use this module are tested as programs in thread.test.ts and
// corrections.test.ts; this covers the module's own edges on a throwaway T3 home.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import {
  legacyViews,
  mainTables,
  openThreads,
  t3Database,
  threadsSource,
  reviewSessionId,
  recordedReviewAuthors,
  inT3ReviewContext,
} from "./t3-db.ts";

const TMP = mkdtempSync(join(tmpdir(), "t3-db-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

test("review ids prefer resolved T3 context, isolate explicit children and refuse ambiguous cwd identity", () => {
  const t3 = join(TMP, "review-ids");
  mkdirSync(join(t3, "userdata"), { recursive: true });
  const db = new DatabaseSync(join(t3, "userdata/state.sqlite"));
  db.exec(
    "create table projection_threads(thread_id text,branch text,worktree_path text,created_at text,deleted_at text)",
  );
  const env = { HOME: TMP, T3CODE_HOME: t3, WORKBENCH_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "native-id" };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, env);
    // Outside T3, thread.ts names the harness's own session (harness.sh reads
    // its native id), so that id keys the review, hashed like a T3 thread's.
    assert.equal(
      reviewSessionId(),
      `t3-${createHash("sha256").update("native-id").digest("hex")}`,
      "no T3 context keys on the harness's native session id",
    );
    // …and that native session is not a T3 thread: a T3 database on the machine
    // does not make a native review owe a T3 writing thread (v9.2.0 review).
    assert.equal(inT3ReviewContext(), false, "a native session beside a T3 database is not T3");
    assert.deepEqual(recordedReviewAuthors(), { vendors: [] }, "…so no T3 writing thread is demanded");
    const insert = db.prepare("insert into projection_threads values (?,null,?,null,null)");
    insert.run("root", process.cwd());
    const rootKey = reviewSessionId();
    assert.match(rootKey, /^t3-[a-f0-9]{64}$/);
    assert.equal(inT3ReviewContext(), true, "the cwd's own T3 thread is T3");
    insert.run("thread:child", process.cwd());
    assert.equal(reviewSessionId(), "", "a leaked native id cannot certify two T3 tasks");
    process.env.WORKBENCH_THREAD_ID = "thread:child";
    const childKey = reviewSessionId();
    assert.match(childKey, /^t3-[a-f0-9]{64}$/);
    assert.notEqual(childKey, rootKey);
  } finally {
    db.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("with neither file, the legacy path is named so the error says where it looked", () => {
  assert.equal(t3Database(join(TMP, "none")), join(TMP, "none/userdata/state.sqlite"));
});

test("with only the legacy file, it is chosen and read as-is", () => {
  const home = join(TMP, "legacy");
  mkdirSync(join(home, "userdata"), { recursive: true });
  writeFileSync(join(home, "userdata/state.sqlite"), "");
  const db = t3Database(home);
  assert.equal(db, join(home, "userdata/state.sqlite"));
  assert.equal(threadsSource(db), "projection_threads");
  assert.equal(legacyViews(db, new Set()), "");
});

test("with statev2.sqlite beside the legacy file, statev2 wins", () => {
  const home = join(TMP, "both");
  mkdirSync(join(home, "userdata"), { recursive: true });
  writeFileSync(join(home, "userdata/state.sqlite"), "");
  writeFileSync(join(home, "userdata/statev2.sqlite"), "");
  assert.equal(t3Database(home), join(home, "userdata/statev2.sqlite"));
});

test("a directory named statev2.sqlite is not a database", () => {
  const home = join(TMP, "dir");
  mkdirSync(join(home, "userdata/statev2.sqlite"), { recursive: true });
  assert.equal(t3Database(home), join(home, "userdata/state.sqlite"));
});

test("the v2 views shadow the legacy names with live rows on a read-only connection", () => {
  const path = join(TMP, "v2.sqlite").replace(/v2\.sqlite$/, "statev2.sqlite");
  const w = new DatabaseSync(path);
  w.exec(`
    create table projection_thread_messages (thread_id TEXT, role TEXT, text TEXT, created_at TEXT);
    create table projection_thread_sessions (thread_id TEXT, provider_name TEXT);
    create table orchestration_v2_projection_threads (thread_id TEXT, title TEXT, created_at TEXT, deleted_at TEXT, payload_json TEXT);
    create table orchestration_v2_projection_messages (thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT);
    create table orchestration_v2_projection_provider_sessions (thread_id TEXT, provider TEXT);
    insert into projection_thread_messages values ('t', 'user', 'old', '1');
    insert into orchestration_v2_projection_messages values ('t', 'user', '1', '{"text":"old"}');
    insert into orchestration_v2_projection_messages values ('t', 'user', '2', '{"text":"new"}');
    insert into orchestration_v2_projection_threads values ('t', 'T', '0', null, '{"branch":"b","worktreePath":"/w"}');
    insert into orchestration_v2_projection_provider_sessions values ('t', 'codex');
  `);
  w.close();

  const db = new DatabaseSync(path, { readOnly: true });
  db.exec(legacyViews(path, mainTables(db)));
  const texts = db.prepare("select text from projection_thread_messages order by created_at").all();
  assert.deepEqual(
    texts.map((r) => r.text),
    ["old", "new"],
  );
  const row = db.prepare("select branch, worktree_path, title from projection_threads where thread_id = 't'").get();
  assert.deepEqual({ ...row }, { branch: "b", worktree_path: "/w", title: "T" });
  const s = db.prepare("select provider_name from projection_thread_sessions").get();
  assert.equal(s?.provider_name, "codex");
});

test("the v2 activities view reads tool calls from the legacy table and from v2 turn items", () => {
  const path = join(TMP, "acts", "statev2.sqlite");
  mkdirSync(join(TMP, "acts"), { recursive: true });
  const w = new DatabaseSync(path);
  w.exec(`
    create table projection_thread_messages (thread_id TEXT, role TEXT, text TEXT, created_at TEXT);
    create table projection_thread_sessions (thread_id TEXT, provider_name TEXT);
    create table projection_thread_activities (activity_id TEXT, thread_id TEXT, turn_id TEXT, tone TEXT, kind TEXT, summary TEXT, payload_json TEXT, created_at TEXT);
    create table orchestration_v2_projection_threads (thread_id TEXT, title TEXT, created_at TEXT, deleted_at TEXT, payload_json TEXT);
    create table orchestration_v2_projection_messages (thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT);
    create table orchestration_v2_projection_provider_sessions (thread_id TEXT, provider TEXT);
    create table orchestration_v2_projection_turn_items (turn_item_id TEXT, thread_id TEXT, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    insert into projection_thread_activities values ('a1', 't', null, 'tool', 'tool.completed', 'Ran', '{"itemType":"command_execution"}', '2026-10-01T00:00:00Z');
    insert into projection_thread_activities values ('a2', 't', null, 'info', 'context-window.updated', '', '{}', '2026-10-01T00:00:01Z');
    insert into orchestration_v2_projection_turn_items values ('i1', 't', 'command_execution', 'completed', '2026-10-05T00:00:09Z', '{"type":"command_execution","startedAt":"2026-10-05T00:00:00Z","input":"ls"}');
    insert into orchestration_v2_projection_turn_items values ('i2', 't', 'dynamic_tool', 'failed', '2026-10-05T00:00:10Z', '{"type":"dynamic_tool","toolName":"Read"}');
    insert into orchestration_v2_projection_turn_items values ('i3', 't', 'command_execution', 'running', '2026-10-05T00:00:11Z', '{"type":"command_execution"}');
    insert into orchestration_v2_projection_turn_items values ('i4', 't', 'assistant_message', 'completed', '2026-10-05T00:00:12Z', '{"type":"assistant_message"}');
  `);
  w.close();

  const db = new DatabaseSync(path, { readOnly: true });
  db.exec(legacyViews(path, mainTables(db)));
  const rows = db
    .prepare(
      "select thread_id, kind, created_at, json_extract(payload_json, '$.type') as t from projection_thread_activities where kind = 'tool.completed' order by created_at",
    )
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { thread_id: "t", kind: "tool.completed", created_at: "2026-10-01T00:00:00Z", t: null },
    { thread_id: "t", kind: "tool.completed", created_at: "2026-10-05T00:00:00Z", t: "command_execution" },
    { thread_id: "t", kind: "tool.completed", created_at: "2026-10-05T00:00:10Z", t: "dynamic_tool" },
  ]);
});

// With the legacy activities gone from v2, the question answers before the cutover are
// still in the frozen `state.sqlite` beside it; that file is attached read-only.
test("with the legacy activities gone from v2, the answers before the cutover are read from state.sqlite", () => {
  const home = join(TMP, "attach", "userdata");
  mkdirSync(home, { recursive: true });
  const old = new DatabaseSync(join(home, "state.sqlite"));
  old.exec(`
    create table projection_thread_activities (thread_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT);
    insert into projection_thread_activities values ('t', 'user-input.resolved', '{"requestId":"r"}', '2026-09-20T00:00:00Z');
  `);
  old.close();
  const path = join(home, "statev2.sqlite");
  const w = new DatabaseSync(path);
  w.exec(`
    create table orchestration_v2_projection_threads (thread_id TEXT, title TEXT, created_at TEXT, deleted_at TEXT, payload_json TEXT);
    create table orchestration_v2_projection_messages (thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT);
    create table orchestration_v2_projection_provider_sessions (thread_id TEXT, provider TEXT);
    create table orchestration_v2_projection_turn_items (turn_item_id TEXT, thread_id TEXT, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
  `);
  w.close();

  const db = new DatabaseSync(path, { readOnly: true });
  db.exec(legacyViews(path, mainTables(db)));
  const rows = db
    .prepare("select kind, created_at from projection_thread_activities")
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ kind: "user-input.resolved", created_at: "2026-09-20T00:00:00Z" }]);
});

// openThreads is what rows-taken.ts reads: a thread the user has not deleted, archived
// or settled, with a worktree, that is not a child task. A child is marked by
// T3's lineage (a parentThreadId), and by the `thread:` id prefix when an older
// row has no lineage at all. One malformed payload costs that row, not the read.
test("openThreads keeps open top-level threads with a worktree and drops the rest", () => {
  const path = join(TMP, "open", "statev2.sqlite");
  mkdirSync(join(TMP, "open"), { recursive: true });
  const w = new DatabaseSync(path);
  w.exec(
    "create table orchestration_v2_projection_threads (thread_id TEXT, title TEXT, created_at TEXT, deleted_at TEXT, payload_json TEXT);",
  );
  const ins = w.prepare("insert into orchestration_v2_projection_threads values (?, ?, ?, ?, ?)");
  const top = JSON.stringify({ parentThreadId: null, relationshipToParent: null, rootThreadId: "x" });
  const child = JSON.stringify({ parentThreadId: "open", relationshipToParent: "subagent", rootThreadId: "open" });
  const p = (o: Record<string, unknown>): string =>
    JSON.stringify({ archivedAt: null, settledAt: null, deletedAt: null, worktreePath: "/w/open", lineage: top, ...o });
  ins.run("open", "Open", "01", null, p({}));
  ins.run("deleted", "D", "02", "2026-10-01", p({ worktreePath: "/w/d" }));
  ins.run("archived", "A", "03", null, p({ archivedAt: "2026-10-01", worktreePath: "/w/a" }));
  ins.run("settled", "S", "04", null, p({ settledAt: "2026-10-01", worktreePath: "/w/s" }));
  ins.run("no-worktree", "N", "05", null, p({ worktreePath: null }));
  ins.run("child", "C", "06", null, p({ lineage: child, worktreePath: "/w/c" }));
  ins.run("thread:old-child", "OC", "07", null, p({ lineage: undefined, worktreePath: "/w/oc" }));
  ins.run("no-lineage", "NL", "08", null, p({ lineage: undefined, worktreePath: "/w/nl" }));
  ins.run("broken", "B", "09", null, "{not json");
  ins.run("untitled", null, "10", null, p({ worktreePath: "/w/u" }));
  w.close();

  const db = new DatabaseSync(path, { readOnly: true });
  const warnings: string[] = [];
  const got = openThreads(db, (m) => warnings.push(m));
  assert.deepEqual(got, [
    { id: "open", title: "Open", worktreePath: "/w/open" },
    { id: "no-lineage", title: "NL", worktreePath: "/w/nl" },
    { id: "untitled", title: "", worktreePath: "/w/u" },
  ]);
  assert.equal(warnings.length, 1, "one warning, for the malformed payload");
  assert.match(warnings[0] ?? "", /broken/, "the warning names the thread");
});

test("review provenance includes run history when session rows disappear and keeps every recorded vendor", () => {
  const home = join(TMP, "author-runs");
  mkdirSync(join(home, "userdata"), { recursive: true });
  const db = new DatabaseSync(join(home, "userdata/statev2.sqlite"));
  db.exec(
    "create table orchestration_v2_projection_provider_sessions(thread_id text,provider text,driver text);" +
      "create table orchestration_v2_projection_runs(thread_id text,provider text);",
  );
  db.prepare("insert into orchestration_v2_projection_runs values (?,?)").run("run-only", "codex_example");
  db.prepare("insert into orchestration_v2_projection_runs values (?,?)").run("run-only", "codex_example");
  db.prepare("insert into orchestration_v2_projection_provider_sessions values (?,?,?)").run(
    "mixed",
    "codex_example",
    "codex",
  );
  db.prepare("insert into orchestration_v2_projection_runs values (?,?)").run("mixed", "claude-example");
  db.prepare("insert into orchestration_v2_projection_runs values (?,?)").run("unknown", "unsupported");
  db.prepare("insert into orchestration_v2_projection_runs values (?,?)").run("empty", null);
  const saved = process.env.T3CODE_HOME;
  process.env.T3CODE_HOME = home;
  try {
    assert.deepEqual(
      recordedReviewAuthors("run-only"),
      { vendors: ["codex"] },
      "completed runs retain Codex provenance after session rows disappear",
    );
    const mixed = recordedReviewAuthors("mixed");
    assert.ok("vendors" in mixed);
    assert.deepEqual(
      new Set(mixed.vendors),
      new Set(["codex", "claude"]),
      "run history cannot omit a past writer when a current session exists",
    );
    assert.deepEqual(recordedReviewAuthors("unknown"), { error: "unrecognized writing provider unsupported" });
    assert.ok(
      "error" in recordedReviewAuthors("empty"),
      "null provenance must fail closed rather than certify no authors",
    );
    assert.ok("error" in recordedReviewAuthors("missing"), "no records still refuse");
    db.exec("drop table orchestration_v2_projection_provider_sessions");
    assert.deepEqual(
      recordedReviewAuthors("run-only"),
      { vendors: ["codex"] },
      "run records work without a session table",
    );
  } finally {
    db.close();
    if (saved === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = saved;
  }
});

test("v2 session compatibility view retains run-only provider history", () => {
  const path = join(TMP, "run-view", "statev2.sqlite");
  mkdirSync(join(TMP, "run-view"), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "create table orchestration_v2_projection_runs(thread_id text,provider text); insert into orchestration_v2_projection_runs values ('run-only','codex_example');",
  );
  try {
    db.exec(legacyViews(path, mainTables(db)));
    const rows = db
      .prepare("select thread_id,provider_name from projection_thread_sessions")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(
      rows,
      [{ thread_id: "run-only", provider_name: "codex_example" }],
      "message/history readers retain the provider after session rows disappear",
    );
  } finally {
    db.close();
  }
});
