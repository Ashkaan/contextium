// sqlite-child.ts — a DatabaseSync for a test suite, on every Node the layer
// supports. node:sqlite loads unflagged only from Node 22.13; on 22.5–22.12 it
// needs --experimental-sqlite, which a running test cannot give itself, so a
// suite that imported node:sqlite ran no case there at all. Every call here
// runs in a child Node started with the flag, as setup-worktree.test.ts's
// fixture always did, so a suite swaps its import and keeps its code.
//
// What it keeps of DatabaseSync: `new DatabaseSync(path, { readOnly })`,
// `exec(sql)`, `prepare(sql)` with `run`, `get` and `all`, and `close()`. A
// writable connection writes at once (each call opens the file, runs, and
// closes it: autocommit). A connection remembers the `exec` calls that only it
// can see — every one on a read-only connection, and one creating a TEMP object
// on a writable one (the views a caller makes) — and replays them first. Rows come
// back as plain objects; integers past 2^53 do not survive, and no suite here
// stores one.
//
// Run by: the suites that read or write a T3 database fixture.
// Tested by: sqlite-child.test.ts beside it.

import { spawnSync } from "node:child_process";

type Param = string | number | null;

const CHILD = `
import { DatabaseSync } from "node:sqlite";
const [path, ro, setup, sql, params, mode] = process.argv.slice(1);
try {
const db = new DatabaseSync(path, { readOnly: ro === "1" });
for (const s of JSON.parse(setup)) db.exec(s);
const p = JSON.parse(params);
let out = null;
if (mode === "exec") db.exec(sql);
else {
  const st = db.prepare(sql);
  out = mode === "run" ? st.run(...p) : mode === "get" ? (st.get(...p) ?? null) : st.all(...p);
}
db.close();
process.stdout.write(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
`;

function call(path: string, readOnly: boolean, setup: string[], sql: string, params: Param[], mode: string): unknown {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      CHILD,
      path,
      readOnly ? "1" : "0",
      JSON.stringify(setup),
      sql,
      JSON.stringify(params),
      mode,
    ],
    { encoding: "utf8", maxBuffer: 1 << 28 },
  );
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`sqlite: ${(r.stderr ?? "").trim() || `exit ${r.status}`}`);
  return JSON.parse(r.stdout || "null");
}

type Row = Record<string, unknown>;

export class DatabaseSync {
  readonly #path: string;
  readonly #readOnly: boolean;
  readonly #setup: string[] = [];

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.#path = path;
    this.#readOnly = opts.readOnly === true;
    // Opening is a read of the file (read-only) or its creation, as it is for
    // node:sqlite's own constructor: a missing database fails here.
    call(path, this.#readOnly, [], "select 1", [], "get");
  }

  exec(sql: string): void {
    call(this.#path, this.#readOnly, this.#setup, sql, [], "exec");
    if (this.#readOnly || /\bcreate\s+temp(?:orary)?\s/i.test(sql)) this.#setup.push(sql);
  }

  prepare(sql: string): {
    run(...p: Param[]): { changes: number; lastInsertRowid: number };
    get(...p: Param[]): Row | undefined;
    all(...p: Param[]): Row[];
  } {
    const setup = this.#setup;
    return {
      run: (...p) =>
        call(this.#path, this.#readOnly, setup, sql, p, "run") as { changes: number; lastInsertRowid: number },
      get: (...p) => (call(this.#path, this.#readOnly, setup, sql, p, "get") as Row | null) ?? undefined,
      all: (...p) => call(this.#path, this.#readOnly, setup, sql, p, "all") as Row[],
    };
  }

  close(): void {}
}
