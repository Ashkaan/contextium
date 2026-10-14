// t3-db.test.ts — which T3 database file is chosen, and what the v2 views return.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/t3-db.test.ts
//
// The programs that use this module are tested as programs in thread.test.ts and
// corrections.test.ts; this covers the module's own edges on a throwaway T3 home.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { legacyViews, t3Database, threadsSource } from "./t3-db.ts";

const TMP = mkdtempSync(join(tmpdir(), "t3-db-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

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
  assert.equal(legacyViews(db), "");
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
  db.exec(legacyViews(path));
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
  db.exec(legacyViews(path));
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
