// sqlite-child.test.ts — the DatabaseSync a suite uses in place of node:sqlite.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/tests/sqlite-child.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "./sqlite-child.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "sqlite-child-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

test("a writable connection creates the file and writes at once; a read sees the rows", () => {
  const path = join(TMP, "a.sqlite");
  const w = new DatabaseSync(path);
  assert.ok(existsSync(path), "opening creates the file, as node:sqlite does");
  w.exec("create table t (id TEXT, n INTEGER, note TEXT)");
  const ins = w.prepare("insert into t values (?, ?, ?)");
  assert.deepEqual(ins.run("a", 1, null), { changes: 1, lastInsertRowid: 1 });
  ins.run("b", 2, "two");
  w.close();
  const r = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(r.prepare("select id, n, note from t order by id").all(), [
    { id: "a", n: 1, note: null },
    { id: "b", n: 2, note: "two" },
  ]);
  assert.deepEqual(r.prepare("select n from t where id = ?").get("b"), { n: 2 });
  assert.equal(r.prepare("select n from t where id = ?").get("none"), undefined, "no row is undefined");
  assert.deepEqual(r.prepare("select id from t where n > ?").all(5), [], "no rows is an empty list");
});

test("a read-only connection replays its own exec calls, so a TEMP view it made is there to read", () => {
  const path = join(TMP, "b.sqlite");
  new DatabaseSync(path).exec("create table t (x TEXT); insert into t values ('v');");
  const r = new DatabaseSync(path, { readOnly: true });
  r.exec("create temp view shadow as select x || '!' as y from main.t");
  assert.deepEqual(r.prepare("select y from shadow").all(), [{ y: "v!" }]);
  assert.throws(() => r.exec("insert into t values ('w')"), /sqlite: .*readonly/i, "a read-only connection refuses a write");
  const w = new DatabaseSync(path);
  w.exec("create temp view mine as select x from main.t");
  assert.deepEqual(w.prepare("select x from mine").all(), [{ x: "v" }], "a writable connection keeps its TEMP view too");
});

test("a missing read-only database and a bad statement throw, naming why", () => {
  assert.throws(() => new DatabaseSync(join(TMP, "none.sqlite"), { readOnly: true }), /sqlite: /);
  const w = new DatabaseSync(join(TMP, "c.sqlite"));
  assert.throws(() => w.exec("create tabel t (x)"), /sqlite: .*syntax error/);
  assert.throws(() => w.prepare("select * from absent").all(), /no such table: absent/);
});

// The point of it: a process that cannot load node:sqlite itself, as on Node
// 22.5–22.12 without the flag, still reads and writes through it.
test("it works in a process where node:sqlite cannot be loaded", () => {
  const path = join(TMP, "d.sqlite");
  const r = spawnSync(
    process.execPath,
    [
      "--no-experimental-sqlite",
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from ${JSON.stringify(join(HERE, "sqlite-child.ts"))};
const db = new DatabaseSync(process.argv[1]);
db.exec("create table t (x TEXT)");
db.prepare("insert into t values (?)").run("ok");
process.stdout.write(JSON.stringify(db.prepare("select x from t").all()));
await import("node:sqlite").then(() => process.stdout.write(" loaded"), () => process.stdout.write(" unloadable"));`,
      path,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '[{"x":"ok"}] unloadable', "the rows came back, and the process itself had no node:sqlite");
});
